import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { storage } from "../../storage";
import type { VoucherEntryInsertFields } from "../../services/accounting/accountingTypes";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { buildPaymentReceiptPostingRequest } from "../../services/accounting/paymentReceiptPosting";
import { syncContainerChargeVoucherEditTx } from "../../services/containers/offload-lifecycle/charge-voucher-sync";
import type { BuildPaymentReceiptPostingInput } from "../../services/accounting/paymentReceiptPosting";

type CentralPaymentReceiptBody = Omit<
  BuildPaymentReceiptPostingInput,
  "companyId" | "voucherNumber" | "actor" | "resolveTarget"
> & { optional?: unknown };
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { buildVoucherChangesForUpdate, logAudit, snapshotVoucherEntries } from "../_helpers";

const postingDependencies = createDatabasePostingDependencies();

function positiveAccountId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new PostingValidationError("POSTING_TARGET_ID_INVALID", `${field} must be a positive integer`);
  }
  return id;
}

/**
 * Preserve the existing Payment/Receipt edit representation exactly.
 * Unlike creation, the legacy edit path does not denormalize a customer into
 * its linked ledger (or a linked ledger into its customer). Ownership is still
 * verified separately before any write.
 */
export function buildLegacyPaymentReceiptEditTarget(
  accountType: string,
  accountIdValue: unknown
): VoucherEntryInsertFields {
  const accountId = positiveAccountId(accountIdValue, "accountId");
  const fieldByType: Record<string, keyof VoucherEntryInsertFields> = {
    ledger: "ledgerAccountId",
    bank: "bankAccountId",
    supplier: "supplierId",
    factorySupplier: "factorySupplierId",
    employee: "employeeId",
    fixedAsset: "fixedAssetId",
    customer: "customerId",
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

function isActivePaymentReceiptType(value: unknown): value is "Payment" | "Receipt" {
  return value === "Payment" || value === "Receipt";
}

async function updateActivePaymentReceipt(req: Request, res: Response, next: NextFunction): Promise<void> {
  const startedAt = Date.now();
  const voucherId = Number(req.params.id);
  const companyId = req.session.currentCompanyId;
  const userId = req.session.userId;

  if (!Number.isInteger(voucherId) || voucherId <= 0) {
    res.status(400).json({ message: "Invalid voucher ID" });
    return;
  }
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return;
  }

  try {
    const existing = await storage.getVoucherById(voucherId);
    if (!existing) {
      res.status(404).json({ message: "Voucher not found" });
      return;
    }
    if (existing.companyId !== companyId) {
      res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
      return;
    }
    const blockedVoucherReason = voucherMutationBlockReason(existing);
    if (blockedVoucherReason) {
      res.status(403).json({ message: blockedVoucherReason });
      return;
    }

    const body = req.body as CentralPaymentReceiptBody;
    // Keep optional transitions and all non-Payment/Receipt edits on the legacy route.
    if (
      !isActivePaymentReceiptType(existing.voucherType) ||
      existing.optional ||
      body.optional === true ||
      !isActivePaymentReceiptType(body.voucherType)
    ) {
      next();
      return;
    }

    if (!body.voucherDate || !body.paymentAccountId || !Array.isArray(body.entries) || body.entries.length === 0) {
      res.status(400).json({ message: "Missing required fields" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM vouchers
        WHERE id = ${voucherId} AND company_id = ${companyId}
        FOR UPDATE
      `);

      const [lockedVoucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
        .limit(1);

      if (!lockedVoucher || lockedVoucher.deletedAt) {
        throw new Error("Voucher not found or already deleted");
      }
      if (!isActivePaymentReceiptType(lockedVoucher.voucherType) || lockedVoucher.optional) {
        throw new Error("Payment/Receipt compatibility state changed during update");
      }

      const built = await buildPaymentReceiptPostingRequest({
        companyId,
        voucherNumber: lockedVoucher.voucherNumber,
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
        clientRequestId: body.clientRequestId || `payment-receipt-update-${voucherId}-${Date.now()}`,
        actor: {
          userId: userId ?? null,
          username: req.session.username || "unknown",
          reason: `${body.voucherType} voucher update`,
        },
        resolveTarget: async (accountType, accountId) => buildLegacyPaymentReceiptEditTarget(accountType, accountId),
      });

      await postingDependencies.ownership.validateVoucherOwnership({
        tx,
        companyId,
        voucher: built.request.voucher,
        entries: built.request.entries,
      });

      const oldEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries: oldEntries,
        direction: "reverse",
        missingEmployeeBehavior: "skip",
      });

      // Preserve the legacy edit contract: voucher currency/exchangeRate are not
      // rewritten by this endpoint; submitted currency metadata is used for the
      // replacement entry normalization and historical base total.
      const [updatedVoucher] = await tx
        .update(vouchers)
        .set({
          voucherType: body.voucherType,
          voucherDate: built.request.voucher.voucherDate,
          description: built.request.voucher.description ?? null,
          totalAmount: built.request.voucher.totalAmount,
          optional: false,
          effectiveDate: built.request.voucher.effectiveDate ?? null,
        })
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
        .returning();

      await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
      const createdEntries = await tx
        .insert(voucherEntries)
        .values(built.request.entries.map((entry) => ({ voucherId, ...entry })))
        .returning();

      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries: createdEntries,
        direction: "apply",
        missingEmployeeBehavior: "throw",
      });

      // An edited duty/transport/office charge voucher re-prices the offloaded bales.
      await syncContainerChargeVoucherEditTx(tx, {
        companyId,
        voucherNumber: lockedVoucher.voucherNumber,
        oldTotal: lockedVoucher.totalAmount,
        newTotal: updatedVoucher.totalAmount,
      });

      // Wave 16 (B): the edit replaces the voucher's lines (delete and
      // re-insert, the legacy edit contract). The before and after lines are
      // audited in this transaction, so a failed audit rolls the edit back.
      const oldSnapshot = await snapshotVoucherEntries(oldEntries, tx);
      const newSnapshot = await snapshotVoucherEntries(createdEntries, tx);
      await logAudit(
        {
          userId: userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "update",
          tableName: "vouchers",
          recordId: voucherId,
          recordIdentifier: updatedVoucher.voucherNumber,
          changes: buildVoucherChangesForUpdate(
            {
              voucherType: lockedVoucher.voucherType,
              voucherDate: lockedVoucher.voucherDate,
              totalAmount: lockedVoucher.totalAmount,
              description: lockedVoucher.description,
              optional: lockedVoucher.optional,
            },
            {
              voucherType: updatedVoucher.voucherType,
              voucherDate: updatedVoucher.voucherDate,
              totalAmount: updatedVoucher.totalAmount,
              description: updatedVoucher.description,
              optional: updatedVoucher.optional,
            },
            oldSnapshot,
            newSnapshot
          ),
        },
        tx
      );

      return {
        voucher: updatedVoucher,
        entries: createdEntries,
      };
    });

    let whatsapp: {
      prompt: boolean;
      accountId?: number;
      voucherDate?: string;
      month?: string;
    } = { prompt: false };
    try {
      whatsapp = await checkAccountWhatsAppRule({
        companyId,
        accountId: Number(body.paymentAccountId),
        accountType: String(body.paymentAccountType),
        voucherType: body.voucherType,
        voucherDate: body.voucherDate,
      });
    } catch (error: unknown) {
      logger.error("Central Payment/Receipt update WhatsApp check failed (non-fatal)", {
        companyId,
        voucherId,
        error,
      });
    }

    logger.info("central Payment/Receipt update succeeded", {
      module: "vouchers",
      action: "updatePaymentReceiptCentral",
      userId,
      companyId,
      voucherId,
      durationMs: Date.now() - startedAt,
    });

    res.json({ voucher: result.voucher, entries: result.entries, whatsapp });
  } catch (error: unknown) {
    logger.error("central Payment/Receipt update failed", {
      module: "vouchers",
      action: "updatePaymentReceiptCentral",
      userId,
      companyId,
      voucherId,
      durationMs: Date.now() - startedAt,
      error,
    });
    if (error instanceof PostingValidationError) {
      res.status(400).json({ message: error.message, code: error.code });
      return;
    }
    res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
  }
}

export function registerCentralPaymentReceiptLifecycleRoutes(app: Express): void {
  app.patch(
    "/api/vouchers/:id/payment-receipt",
    requireAuth,
    requireNonPOS,
    (req, res, next) => void updateActivePaymentReceipt(req, res, next)
  );
}
