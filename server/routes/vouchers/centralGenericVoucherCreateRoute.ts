import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { customers } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db, type DbTransaction } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import {
  PostingValidationError,
  postBalancedVoucherTx,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import {
  buildGenericVoucherPostingRequest,
  supportsCentralGenericVoucher,
} from "../../services/accounting/genericVoucherPosting";
import { triggerIntercompanyNotifications } from "../intercompanyNotificationRoutes";
import { buildVoucherChangesForCreate, getCurrentExchangeRate, logAudit, snapshotVoucherEntries } from "../_helpers";

const postingDependencies = createDatabasePostingDependencies();
type CustomerLinkedLedgerRow = { id: number; ledgerAccountId: number | null };

async function resolveCustomerLinkedLedgersTx(input: {
  tx: DbTransaction;
  companyId: number;
  entries: Array<Record<string, unknown>>;
}): Promise<Array<Record<string, unknown>>> {
  const customerIds = [
    ...new Set(input.entries.map((entry) => Number(entry.customerId)).filter((id) => Number.isInteger(id) && id > 0)),
  ];

  if (customerIds.length === 0) return input.entries.map((entry) => ({ ...entry }));

  const rows: CustomerLinkedLedgerRow[] = await input.tx
    .select({ id: customers.id, ledgerAccountId: customers.ledgerAccountId })
    .from(customers)
    .where(and(eq(customers.companyId, input.companyId), inArray(customers.id, customerIds)));
  const customerById = new Map<number, CustomerLinkedLedgerRow>(rows.map((row) => [Number(row.id), row] as const));

  return input.entries.map((entry) => {
    const customerId = Number(entry.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) return { ...entry };

    const customer = customerById.get(customerId);
    if (!customer) {
      throw new PostingValidationError(
        "POSTING_TARGET_NOT_OWNED",
        `Customer ${customerId} not found in company ${input.companyId}`
      );
    }

    const linkedLedgerId = customer.ledgerAccountId == null ? null : Number(customer.ledgerAccountId);
    const suppliedLedgerId = entry.ledgerAccountId == null ? null : Number(entry.ledgerAccountId);
    if (linkedLedgerId && suppliedLedgerId && linkedLedgerId !== suppliedLedgerId) {
      throw new PostingValidationError(
        "POSTING_LINKED_LEDGER_MISMATCH",
        `Customer ${customerId} is linked to ledger ${linkedLedgerId}, but the entry specifies ledger ${suppliedLedgerId}`
      );
    }

    return {
      ...entry,
      ...(linkedLedgerId ? { ledgerAccountId: linkedLedgerId } : {}),
    };
  });
}

function postingStatus(error: PostingValidationError): number {
  return error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400;
}

async function createCentralGenericVoucher(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!supportsCentralGenericVoucher(req.body)) {
    next();
    return;
  }

  const startedAt = Date.now();
  const companyId = req.session.currentCompanyId;
  const userId = req.session.userId;

  try {
    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const currentRate = await getCurrentExchangeRate(companyId);
    const suppliedRate = req.body.voucher?.exchangeRate;
    const voucherExchangeRate =
      suppliedRate != null ? String(suppliedRate) : currentRate != null ? String(currentRate) : null;

    const result = await db.transaction(async (tx) => {
      const resolvedEntries = await resolveCustomerLinkedLedgersTx({
        tx,
        companyId,
        entries: req.body.entries,
      });
      const built = buildGenericVoucherPostingRequest({
        companyId,
        clientRequestId: req.body.clientRequestId,
        voucher: req.body.voucher,
        entries: resolvedEntries,
        exchangeRate: voucherExchangeRate,
        actor: {
          userId: userId ?? null,
          username: req.session.username || "unknown",
          reason: "Generic voucher creation",
        },
      });

      const posted = await postBalancedVoucherTx(tx, built.request, postingDependencies);

      if (!posted.replayed) {
        await applyEmployeeBalanceDeltasTx({
          tx,
          companyId,
          entries: posted.entries,
        });
      }

      return { posted, clientRequestId: built.clientRequestId };
    });

    const { posted, clientRequestId } = result;
    if (!posted.replayed) {
      try {
        const entrySnapshot = await snapshotVoucherEntries(posted.entries);
        await logAudit({
          userId: userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "create",
          tableName: "vouchers",
          recordId: posted.voucher.id,
          recordIdentifier: posted.voucher.voucherNumber,
          changes: buildVoucherChangesForCreate(posted.voucher, entrySnapshot),
        });
      } catch (error: unknown) {
        logger.error("Central generic voucher compatibility audit failed (non-fatal)", {
          companyId,
          voucherId: posted.voucher.id,
          error,
        });
      }

      triggerIntercompanyNotifications(
        companyId,
        posted.voucher.id,
        posted.voucher.voucherNumber,
        posted.voucher.voucherDate,
        posted.voucher.totalAmount || "0",
        posted.voucher.description,
        posted.entries.map((entry) => entry.ledgerAccountId),
        posted.voucher.voucherType
      ).catch(() => {});

      autoReallocateLoansAccounts(
        companyId,
        posted.entries.map((entry) => entry.ledgerAccountId)
      ).catch(() => {});
    }

    logger.info("Central generic voucher create succeeded", {
      module: "vouchers",
      action: "createWithEntriesCentral",
      userId,
      companyId,
      voucherId: posted.voucher.id,
      replayed: posted.replayed,
      durationMs: Date.now() - startedAt,
    });

    res.json({
      voucher: posted.voucher,
      entries: posted.entries,
      replayed: posted.replayed,
      clientRequestId,
    });
  } catch (error: unknown) {
    logger.error("Central generic voucher create failed", {
      module: "vouchers",
      action: "createWithEntriesCentral",
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

export function registerCentralGenericVoucherCreateRoute(app: Express): void {
  app.post(
    "/api/vouchers/with-entries",
    requireAuth,
    requireNonPOS,
    (req, res, next) => void createCentralGenericVoucher(req, res, next)
  );
}
