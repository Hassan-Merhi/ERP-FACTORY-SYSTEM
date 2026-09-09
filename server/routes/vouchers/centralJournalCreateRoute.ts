import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  customerBalances,
  customerOrderCharges,
  customerOrders,
  factoryDaybookEntries,
  factorySettings,
} from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  PostingValidationError,
  postBalancedVoucherTx,
  type CentralPostingResult,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { erpRateToDaybookFxRateToUsd } from "../../services/accounting/currencyAmounts";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { buildManualJournalPostingRequest } from "../../services/accounting/manualJournalPosting";
import { transformGoldenCoastOwnerWithdrawalJournal } from "../../services/accounting/goldenCoastOwnerWithdrawalJournal";
import { recalculateOrderTotals } from "../factory/_helpers";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { buildVoucherChangesForCreate, logAudit, snapshotVoucherEntries } from "../_helpers";

const postingDependencies = createDatabasePostingDependencies();

type PersistedPostingResult = CentralPostingResult<any, any>;

async function syncJournalToOrderCharge(
  companyId: number,
  savedEntries: Array<{
    customerId: number | null;
    ledgerAccountId: number | null;
    debitAmount: string | null;
    creditAmount: string | null;
  }>,
  voucherId: number
): Promise<void> {
  const customerEntry = savedEntries.find((entry) => entry.customerId !== null);
  if (!customerEntry) return;

  const ledgerCreditEntries = savedEntries.filter(
    (entry) => entry.ledgerAccountId !== null && entry.customerId === null && Number(entry.creditAmount || 0) > 0
  );

  for (const ledgerEntry of ledgerCreditEntries) {
    const newAmount = Number(ledgerEntry.creditAmount || 0);
    if (newAmount <= 0) continue;

    let matchingCharges: Array<{
      id: number;
      orderId: number;
      amount: string;
      chargeType: string;
    }> = await db
      .select({
        id: customerOrderCharges.id,
        orderId: customerOrderCharges.orderId,
        amount: customerOrderCharges.amount,
        chargeType: customerOrderCharges.chargeType,
      })
      .from(customerOrderCharges)
      .innerJoin(
        customerOrders,
        and(eq(customerOrderCharges.orderId, customerOrders.id), eq(customerOrders.companyId, companyId))
      )
      .where(
        and(
          eq(customerOrderCharges.voucherId, voucherId),
          eq(customerOrderCharges.ledgerAccountId, ledgerEntry.ledgerAccountId!)
        )
      );

    if (matchingCharges.length === 0) {
      const byLedger = await db
        .select({
          id: customerOrderCharges.id,
          orderId: customerOrderCharges.orderId,
          amount: customerOrderCharges.amount,
          chargeType: customerOrderCharges.chargeType,
        })
        .from(customerOrderCharges)
        .innerJoin(
          customerOrders,
          and(
            eq(customerOrderCharges.orderId, customerOrders.id),
            eq(customerOrders.customerId, customerEntry.customerId!),
            eq(customerOrders.companyId, companyId)
          )
        )
        .where(
          and(
            eq(customerOrderCharges.ledgerAccountId, ledgerEntry.ledgerAccountId!),
            isNull(customerOrderCharges.voucherId)
          )
        );

      if (byLedger.length === 1) matchingCharges = byLedger;
    }

    if (matchingCharges.length === 0) continue;
    const charge = matchingCharges[0];
    const amountChanged = Math.abs(Number(charge.amount || 0) - newAmount) >= 0.01;

    await db.transaction(async (tx) => {
      await tx
        .update(customerOrderCharges)
        .set({ amount: newAmount.toFixed(2), voucherId })
        .where(eq(customerOrderCharges.id, charge.id));

      if (!amountChanged) return;
      await recalculateOrderTotals(tx, charge.orderId);

      const [updatedOrder] = await tx
        .select({ grandTotal: customerOrders.grandTotal })
        .from(customerOrders)
        .where(eq(customerOrders.id, charge.orderId));

      if (updatedOrder) {
        await tx
          .update(customerBalances)
          .set({ debitAmount: updatedOrder.grandTotal, balance: updatedOrder.grandTotal })
          .where(
            and(
              eq(customerBalances.companyId, companyId),
              eq(customerBalances.referenceId, charge.orderId),
              eq(customerBalances.referenceType, "INVOICE")
            )
          );
      }
    });
  }
}

async function writeFactoryDaybook(result: PersistedPostingResult, companyId: number): Promise<void> {
  const [settings] = await db
    .select({ companyId: factorySettings.companyId })
    .from(factorySettings)
    .where(eq(factorySettings.companyId, companyId))
    .limit(1);
  if (!settings) return;

  const currency = result.voucher.currency || "USD";
  const baseTotal = Number(result.voucher.totalAmount || 0);
  const rate = result.voucher.exchangeRate ? Number(result.voucher.exchangeRate) : 1;
  const transactionTotal = currency !== "USD" && rate > 0 ? baseTotal * rate : baseTotal;

  await db.insert(factoryDaybookEntries).values({
    companyId,
    txDate: result.voucher.voucherDate,
    txType: "JOURNAL",
    referenceId: result.voucher.id,
    referenceTable: "vouchers",
    description: result.voucher.description || `Journal voucher #${result.voucher.voucherNumber}`,
    currencyCode: currency,
    amountCurrency: String(transactionTotal),
    fxRateToUsd: erpRateToDaybookFxRateToUsd(currency, "USD", result.voucher.exchangeRate),
    amountUsd: String(baseTotal),
    createdBy: null,
  });
}

function postingStatus(error: PostingValidationError): number {
  return error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400;
}

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

    const ownerWithdrawal = await transformGoldenCoastOwnerWithdrawalJournal({ companyId, entries });
    const postingEntries = ownerWithdrawal.entries;

    if (ownerWithdrawal.transformed) {
      logger.info("Golden Coast owner withdrawal journal transformed", {
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

    const built = buildManualJournalPostingRequest({
      companyId,
      voucherNumber: `JOURNAL-${Date.now()}`,
      voucherDate,
      entries: postingEntries,
      notes,
      currency: currency || "USD",
      exchangeRate: exchangeRate ?? null,
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

    const result = (await db.transaction(async (tx) => {
      const posted = (await postBalancedVoucherTx(tx, built.request, postingDependencies)) as PersistedPostingResult;

      if (!posted.replayed) {
        await applyEmployeeBalanceDeltasTx({
          tx,
          companyId,
          entries: posted.entries,
        });
      }

      return posted;
    })) as PersistedPostingResult;

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

      try {
        const auditEntries = await snapshotVoucherEntries(result.entries);
        await logAudit({
          userId: userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "create",
          tableName: "vouchers",
          recordId: result.voucher.id,
          recordIdentifier: result.voucher.voucherNumber,
          changes: buildVoucherChangesForCreate(result.voucher, auditEntries),
        });
      } catch {
        // The transaction-owned central posting audit already exists. Preserve
        // the old rich audit as best-effort compatibility only.
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

    res.status(500).json({ message: getErrorMessage(error) });
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
