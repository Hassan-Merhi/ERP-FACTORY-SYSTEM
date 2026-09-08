import type { Express, NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { customers, factoryDaybookEntries, factorySettings, ledgerAccounts } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db, type DbTransaction } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import type { VoucherEntryInsertFields } from "../../services/accounting/accountingTypes";
import {
  PostingValidationError,
  postBalancedVoucherTx,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { buildFactoryDaybookPosting } from "../../services/accounting/daybookConvergence";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { buildPaymentReceiptPostingRequest } from "../../services/accounting/paymentReceiptPosting";
import { triggerIntercompanyNotifications } from "../intercompanyNotificationRoutes";
import { buildVoucherChangesForCreate, logAudit, snapshotVoucherEntries } from "../_helpers";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import type { FactoryDaybookVoucherLike } from "../../services/accounting/daybookConvergence";

const postingDependencies = createDatabasePostingDependencies();
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function supportsCentralPaymentReceipt(input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (input.optional === true) return false;
  if (input.voucherType !== "Payment" && input.voucherType !== "Receipt") return false;
  if (typeof input.clientRequestId !== "string" || !input.clientRequestId.trim()) return false;
  return Array.isArray(input.entries) && input.entries.length > 0;
}

function postingStatus(error: PostingValidationError): number {
  return error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400;
}

async function resolvePaymentReceiptTargetTx(input: {
  tx: DbTransaction;
  companyId: number;
  accountType: string;
  accountId: number;
}): Promise<VoucherEntryInsertFields> {
  const { tx, companyId, accountType, accountId } = input;
  if (accountType === "ledger") {
    const [ledger] = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)))
      .limit(1);
    if (!ledger) {
      throw new PostingValidationError(
        "POSTING_TARGET_NOT_OWNED",
        `Ledger account ${accountId} not found in company ${companyId}`
      );
    }

    const [linkedCustomer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.ledgerAccountId, accountId), eq(customers.companyId, companyId)))
      .limit(1);
    return {
      ledgerAccountId: accountId,
      ...(linkedCustomer ? { customerId: Number(linkedCustomer.id) } : {}),
    };
  }

  if (accountType === "customer") {
    const [customer] = await tx
      .select({ id: customers.id, ledgerAccountId: customers.ledgerAccountId })
      .from(customers)
      .where(and(eq(customers.id, accountId), eq(customers.companyId, companyId)))
      .limit(1);
    if (!customer) {
      throw new PostingValidationError(
        "POSTING_TARGET_NOT_OWNED",
        `Customer ${accountId} not found in company ${companyId}`
      );
    }
    return {
      customerId: accountId,
      ...(customer.ledgerAccountId ? { ledgerAccountId: Number(customer.ledgerAccountId) } : {}),
    };
  }

  const fieldByType: Record<string, keyof VoucherEntryInsertFields> = {
    bank: "bankAccountId",
    supplier: "supplierId",
    factorySupplier: "factorySupplierId",
    employee: "employeeId",
    fixedAsset: "fixedAssetId",
  };
  const field = fieldByType[accountType];
  if (!field) {
    throw new PostingValidationError(
      "POSTING_TARGET_INVALID",
      `Unsupported Payment/Receipt account type: ${accountType}`
    );
  }
  return { [field]: accountId } as VoucherEntryInsertFields;
}

async function writeFactoryDaybookCompatibilityTx(input: {
  tx: DbTransaction;
  companyId: number;
  // The persisted row goes straight to buildFactoryDaybookPosting, so this is
  // the contract that function already declares.
  voucher: FactoryDaybookVoucherLike;
}): Promise<void> {
  const [settings] = await input.tx
    .select({ id: factorySettings.id })
    .from(factorySettings)
    .where(eq(factorySettings.companyId, input.companyId))
    .limit(1);
  if (!settings) return;

  const values = buildFactoryDaybookPosting({
    companyId: input.companyId,
    voucher: input.voucher,
  });
  await input.tx.insert(factoryDaybookEntries).values(values);
}

async function createCentralPaymentReceipt(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!supportsCentralPaymentReceipt(req.body)) {
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

    const body = req.body as Record<string, any>;
    const result = await db.transaction(async (tx) => {
      const built = await buildPaymentReceiptPostingRequest({
        companyId,
        voucherNumber: `${String(body.voucherType).toUpperCase()}-${Date.now()}`,
        voucherType: body.voucherType,
        voucherDate: body.voucherDate,
        paymentAccountType: body.paymentAccountType,
        paymentAccountId: body.paymentAccountId,
        paymentAccountNarration: body.paymentAccountNarration,
        entries: body.entries,
        notes: body.notes,
        currency: body.currency || "USD",
        exchangeRate: body.exchangeRate ?? null,
        effectiveDate: body.effectiveDate || null,
        clientRequestId: body.clientRequestId,
        actor: {
          userId: userId ?? null,
          username: req.session.username || "unknown",
          reason: `${body.voucherType} voucher creation`,
        },
        resolveTarget: (accountType, accountId) =>
          resolvePaymentReceiptTargetTx({ tx, companyId, accountType, accountId }),
      });

      const posted = await postBalancedVoucherTx(tx, built.request, postingDependencies);

      if (!posted.replayed) {
        await applyEmployeeBalanceDeltasTx({
          tx,
          companyId,
          entries: posted.entries,
        });
        await writeFactoryDaybookCompatibilityTx({
          tx,
          companyId,
          voucher: posted.voucher,
        });
      }

      return { posted, clientRequestId: built.clientRequestId };
    });

    const { posted, clientRequestId } = result;
    let whatsapp: {
      prompt: boolean;
      accountId?: number;
      voucherDate?: string;
      month?: string;
    } = { prompt: false };

    if (!posted.replayed) {
      try {
        whatsapp = await checkAccountWhatsAppRule({
          companyId,
          accountId: Number(req.body.paymentAccountId),
          accountType: String(req.body.paymentAccountType),
          voucherType: req.body.voucherType,
          voucherDate: req.body.voucherDate,
        });
      } catch (error: unknown) {
        logger.error("Central Payment/Receipt WhatsApp check failed (non-fatal)", {
          companyId,
          voucherId: posted.voucher.id,
          error,
        });
      }

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
        logger.error("Central Payment/Receipt audit write failed (non-fatal)", {
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

    logger.info("Central Payment/Receipt create succeeded", {
      module: "vouchers",
      action: "createPaymentReceiptCentral",
      userId,
      companyId,
      voucherId: posted.voucher.id,
      replayed: posted.replayed,
      durationMs: Date.now() - startedAt,
    });

    res.json({
      voucher: posted.voucher,
      entries: posted.entries,
      whatsapp,
      replayed: posted.replayed,
      clientRequestId,
    });
  } catch (error: unknown) {
    logger.error("Central Payment/Receipt create failed", {
      module: "vouchers",
      action: "createPaymentReceiptCentral",
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

export function registerCentralPaymentReceiptCreateRoute(app: Express): void {
  app.post(
    "/api/vouchers/payment-receipt",
    requireAuth,
    requireNonPOS,
    (req, res, next) => void createCentralPaymentReceipt(req, res, next)
  );
}
