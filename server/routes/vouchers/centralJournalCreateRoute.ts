import { assertApprovedZmwVoucherRate } from "../../services/accounting/zambiaVoucherRatePolicy";
import type { Express, NextFunction, Request, Response } from "express";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { errorBody, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { PostingValidationError, postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { buildManualJournalPostingRequest } from "../../services/accounting/manualJournalPosting";
import {
  applyGoldenCoastOwnerWithdrawalTemplate,
  goldenCoastOwnerWithdrawalTemplatePreview,
  matchGoldenCoastOwnerWithdrawalJournal,
  type GoldenCoastOwnerWithdrawalTransform,
} from "../../services/accounting/goldenCoastOwnerWithdrawalJournal";

import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { buildVoucherChangesForCreate, logAudit, snapshotVoucherEntries } from "../_helpers";
import {
  GC_OWNER_WITHDRAWAL_TEMPLATE_CONFIRM,
  GC_OWNER_WITHDRAWAL_TEMPLATE_MESSAGE,
  syncJournalToOrderCharge,
  writeFactoryDaybook,
  postingStatus,
} from "./centralJournalCreateRouteHelpers";
export {
  GC_OWNER_WITHDRAWAL_TEMPLATE_CONFIRM,
  GC_OWNER_WITHDRAWAL_TEMPLATE_MESSAGE,
} from "./centralJournalCreateRouteHelpers";

const postingDependencies = createDatabasePostingDependencies();

async function createActiveJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.body?.optional === true) {
    next();
    return;
  }

  const startedAt = Date.now();
  const userId = req.session.userId;
  const companyId = req.session.currentCompanyId;

  try {
    logger.info("central journal create started", {
      module: "vouchers",
      action: "createJournalCentral",
      userId,
      companyId,
    });

    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const {
      voucherDate,
      entries,
      notes,
      currency,
      exchangeRate,
      effectiveDate,
      clientRequestId,
      mainAccountId,
      mainAccountType,
    } = req.body ?? {};

    if (!voucherDate || !Array.isArray(entries) || entries.length === 0) {
      res.status(400).json({ message: "Missing required fields" });
      return;
    }

    // Phase 22 (B), D6: the Golden Coast owner-withdrawal template is applied
    // only when the user confirmed it; a matching journal without that answer
    // is refused with the template's lines, and `false` posts it as entered.
    const templateAnswer = req.body?.goldenCoastOwnerWithdrawalTemplate;
    const withdrawalMatch = await matchGoldenCoastOwnerWithdrawalJournal({ companyId, entries });
    if (withdrawalMatch && typeof templateAnswer !== "boolean") {
      res.status(409).json({
        code: GC_OWNER_WITHDRAWAL_TEMPLATE_CONFIRM,
        message: GC_OWNER_WITHDRAWAL_TEMPLATE_MESSAGE,
        template: goldenCoastOwnerWithdrawalTemplatePreview(withdrawalMatch),
      });
      return;
    }
    if (templateAnswer === true && !withdrawalMatch) {
      res.status(400).json({
        code: "GC_OWNER_WITHDRAWAL_TEMPLATE_NOT_APPLICABLE",
        message: "This journal is not a Golden Coast owner withdrawal; post it without the template.",
      });
      return;
    }
    const ownerWithdrawal: GoldenCoastOwnerWithdrawalTransform =
      withdrawalMatch && templateAnswer === true
        ? await applyGoldenCoastOwnerWithdrawalTemplate(companyId, withdrawalMatch)
        : { entries, transformed: false };
    const postingEntries = ownerWithdrawal.entries;

    if (ownerWithdrawal.transformed) {
      logger.info("Golden Coast owner withdrawal template posted (confirmed by the user)", {
        module: "vouchers",
        action: "createJournalCentral",
        companyId,
        userId,
        amountUsd: ownerWithdrawal.amountUsd,
        gcSalesCashAccountId: ownerWithdrawal.gcSalesCashAccountId,
        hassanEquityAccountId: ownerWithdrawal.hassanEquityAccountId,
        clearingAccountId: ownerWithdrawal.clearingAccountId,
      });
    }

    const approvedRate = await assertApprovedZmwVoucherRate(companyId, voucherDate, currency || "USD", exchangeRate);

    const built = buildManualJournalPostingRequest({
      companyId,
      voucherDate,
      entries: postingEntries,
      notes,
      currency: currency || "USD",
      exchangeRate: approvedRate,
      effectiveDate: effectiveDate || null,
      clientRequestId,
      actor: {
        userId: userId ?? null,
        username: req.session.username || "unknown",
        reason: ownerWithdrawal.transformed ? "Golden Coast owner withdrawal" : "Manual journal creation",
      },
    });

    if (!clientRequestId) {
      logger.warn("Manual journal request did not include a stable clientRequestId", {
        module: "vouchers",
        action: "createJournalCentral",
        userId,
        companyId,
        generatedRequestId: built.clientRequestId,
      });
    }

    const result = await db.transaction(async (tx) => {
      const posted = await postBalancedVoucherTx(tx, built.request, postingDependencies);

      if (!posted.replayed) {
        await applyEmployeeBalanceDeltasTx({
          tx,
          companyId,
          entries: posted.entries,
        });
        // Wave 16 (B): the rich voucher audit is written in the posting
        // transaction; an audit failure rolls the journal back.
        const auditEntries = await snapshotVoucherEntries(posted.entries, tx);
        await logAudit(
          {
            userId: userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "create",
            tableName: "vouchers",
            recordId: posted.voucher.id,
            recordIdentifier: posted.voucher.voucherNumber,
            changes: buildVoucherChangesForCreate(posted.voucher, auditEntries),
          },
          tx
        );
      }

      return posted;
    });

    let whatsapp: {
      prompt: boolean;
      accountId?: number;
      voucherDate?: string;
      month?: string;
    } = { prompt: false };

    if (!result.replayed) {
      await syncJournalToOrderCharge(companyId, result.entries, result.voucher.id).catch((error: unknown) =>
        logger.error("Central journal order-charge sync failed (non-fatal)", {
          companyId,
          voucherId: result.voucher.id,
          error,
        })
      );

      await writeFactoryDaybook(result, companyId).catch((error: unknown) =>
        logger.error("Central journal factory daybook write failed (non-fatal)", {
          companyId,
          voucherId: result.voucher.id,
          error,
        })
      );

      try {
        let accountId = mainAccountId ? Number(mainAccountId) : null;
        let accountType = mainAccountType ? String(mainAccountType) : "ledger";
        if (!accountId) {
          const firstLedgerDebit = entries.find(
            (entry) => entry.accountType === "ledger" && entry.type === "DR" && Number(entry.accountId) > 0
          );
          if (firstLedgerDebit) {
            accountId = Number(firstLedgerDebit.accountId);
            accountType = "ledger";
          }
        }

        if (accountId) {
          whatsapp = await checkAccountWhatsAppRule({
            companyId,
            accountId,
            accountType,
            voucherType: "Journal",
            voucherDate,
          });
        }
      } catch (error: unknown) {
        logger.error("Central journal WhatsApp rule check failed (non-fatal)", {
          companyId,
          voucherId: result.voucher.id,
          error,
        });
      }
    }

    logger.info("central journal create succeeded", {
      module: "vouchers",
      action: "createJournalCentral",
      userId,
      companyId,
      voucherId: result.voucher.id,
      replayed: result.replayed,
      ownerWithdrawal: ownerWithdrawal.transformed,
      durationMs: Date.now() - startedAt,
    });

    res.json({
      voucher: result.voucher,
      entries: result.entries,
      whatsapp,
      replayed: result.replayed,
      clientRequestId: built.clientRequestId,
      ownerWithdrawal: ownerWithdrawal.transformed
        ? {
            amountUsd: ownerWithdrawal.amountUsd,
            gcSalesCashAccountId: ownerWithdrawal.gcSalesCashAccountId,
            hassanEquityAccountId: ownerWithdrawal.hassanEquityAccountId,
          }
        : undefined,
    });
  } catch (error: unknown) {
    logger.error("central journal create failed", {
      module: "vouchers",
      action: "createJournalCentral",
      userId,
      companyId,
      durationMs: Date.now() - startedAt,
      error,
    });

    if (error instanceof PostingValidationError) {
      res.status(postingStatus(error)).json({ message: error.message, code: error.code });
      return;
    }

    res.status(errorStatus(error)).json(errorBody(error));
  }
}

export function registerCentralJournalCreateRoute(app: Express): void {
  app.post(
    "/api/vouchers/journal",
    requireAuth,
    requireNonPOS,
    (req, res, next) => void createActiveJournal(req, res, next)
  );
}
