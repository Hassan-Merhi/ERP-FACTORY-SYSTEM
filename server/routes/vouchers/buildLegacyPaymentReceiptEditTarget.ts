// Extracted from ./centralPaymentReceiptLifecycleRoute.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { and, eq, or } from "drizzle-orm";
import { interCompanyTransfers, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { IntercompanyTransferLegEditRefused } from "../../services/accounting/intercompanyTransferLegGuard";
import type { VoucherEntryInsertFields } from "../../services/accounting/accountingTypes";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import type { BuildPaymentReceiptPostingInput } from "../../services/accounting/paymentReceiptPosting";
import { assertVoucherEditableTx, recordVoucherEditAuditTx } from "../../services/accounting/voucherCorrection";

export type CentralPaymentReceiptBody = Omit<
  BuildPaymentReceiptPostingInput,
  "companyId" | "voucherNumber" | "actor" | "resolveTarget"
> & { optional?: unknown };

export const postingDependencies = createDatabasePostingDependencies();

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

function safePositiveMoney(value: unknown): Decimal | null {
  try {
    const amount = new Decimal(String(value ?? ""));
    return amount.isFinite() && amount.gt(0) ? amount : null;
  } catch {
    return null;
  }
}

export function isActivePaymentReceiptType(value: unknown): value is "Payment" | "Receipt" {
  return value === "Payment" || value === "Receipt";
}

/**
 * A linked intercompany Payment/Receipt may be reclassified to another ledger
 * account in THIS company. No lines or voucher headers are recreated: the
 * opposite company, transfer amount and historical currency stay untouched.
 *
 * Generic edits remain forbidden. Only a 1-debit/1-credit ledger voucher with
 * exactly the original amounts, date, type and currency is eligible. The linked
 * cash-account id follows a cash-side correction in this same transaction.
 */
export async function updateIntercompanyPaymentReceiptAccounts(params: {
  voucherId: number;
  companyId: number;
  userId?: string | null;
  username?: string | null;
  body: CentralPaymentReceiptBody;
}) {
  const { voucherId, companyId, body } = params;
  return db.transaction(async (tx) => {
    const [lockedVoucher] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
      .for("update");
    if (!lockedVoucher || lockedVoucher.deletedAt) {
      throw new PostingValidationError("VOUCHER_NOT_FOUND", "Voucher not found");
    }
    const [transfer] = await tx
      .select()
      .from(interCompanyTransfers)
      .where(or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId)))
      .for("update");
    if (!transfer) {
      // An unrelated writer deleted the link after the preflight lookup.
      throw new PostingValidationError("INTERCOMPANY_TRANSFER_CHANGED", "Transfer changed; reload this voucher");
    }
    const refuse = () => {
      throw new IntercompanyTransferLegEditRefused(voucherId, transfer.id);
    };
    const originalDate = String(lockedVoucher.voucherDate).slice(0, 10);
    const requestDate = String(body.voucherDate ?? "").slice(0, 10);
    const originalEffectiveDate = lockedVoucher.effectiveDate ? String(lockedVoucher.effectiveDate).slice(0, 10) : null;
    const requestedEffectiveDate = body.effectiveDate ? String(body.effectiveDate).slice(0, 10) : null;
    const originalCurrency = String(lockedVoucher.currency || "USD").toUpperCase();
    const requestedCurrency = String(body.currency || "USD").toUpperCase();
    const suppliedRate = safePositiveMoney(body.exchangeRate);
    const sameRate =
      originalCurrency === "USD" ||
      (suppliedRate !== null &&
        lockedVoucher.exchangeRate != null &&
        suppliedRate.eq(String(lockedVoucher.exchangeRate)));

    if (
      !isActivePaymentReceiptType(lockedVoucher.voucherType) ||
      lockedVoucher.optional ||
      body.optional === true ||
      body.voucherType !== lockedVoucher.voucherType ||
      requestDate !== originalDate ||
      requestedEffectiveDate !== originalEffectiveDate ||
      requestedCurrency !== originalCurrency ||
      !sameRate ||
      String(body.notes ?? "").trim() !== String(lockedVoucher.description ?? "").trim() ||
      body.paymentAccountType !== "ledger" ||
      !Array.isArray(body.entries) ||
      body.entries.length !== 1 ||
      body.entries[0]?.accountType !== "ledger"
    ) {
      refuse();
    }
    const oldEntries = await tx
      .select()
      .from(voucherEntries)
      .where(eq(voucherEntries.voucherId, voucherId))
      .orderBy(voucherEntries.id);
    if (oldEntries.length !== 2) refuse();
    const debit = oldEntries.find((line) => new Decimal(line.debitAmount || "0").gt(0));
    const credit = oldEntries.find((line) => new Decimal(line.creditAmount || "0").gt(0));
    if (
      !debit ||
      !credit ||
      debit.id === credit.id ||
      oldEntries.some(
        (line) =>
          !line.ledgerAccountId ||
          line.bankAccountId ||
          line.customerId ||
          line.supplierId ||
          line.factorySupplierId ||
          line.employeeId ||
          line.fixedAssetId
      )
    ) {
      refuse();
    }
    const cashLine = lockedVoucher.voucherType === "Receipt" ? debit! : credit!;
    const contraLine = lockedVoucher.voucherType === "Receipt" ? credit! : debit!;
    const originalAmount = new Decimal(
      contraLine.transactionCurrency
        ? (lockedVoucher.voucherType === "Receipt"
            ? contraLine.transactionCreditAmount
            : contraLine.transactionDebitAmount) || "0"
        : (lockedVoucher.voucherType === "Receipt" ? contraLine.creditAmount : contraLine.debitAmount) || "0"
    );
    const submittedAmount = safePositiveMoney(body.entries[0]?.amount);
    if (
      !submittedAmount ||
      !originalAmount.gt(0) ||
      !submittedAmount.eq(originalAmount) ||
      !new Decimal(debit!.debitAmount || "0").eq(credit!.creditAmount || "0")
    ) {
      refuse();
    }
    const cashAccountId = Number(body.paymentAccountId);
    const contraAccountId = Number(body.entries[0]!.accountId);
    if (
      !Number.isSafeInteger(cashAccountId) ||
      cashAccountId <= 0 ||
      !Number.isSafeInteger(contraAccountId) ||
      contraAccountId <= 0
    )
      refuse();
    const changes = [
      { line: cashLine, newId: cashAccountId },
      { line: contraLine, newId: contraAccountId },
    ].filter(({ line, newId }) => line.ledgerAccountId !== newId);
    if (changes.length === 0) {
      const currentEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
      return { voucher: lockedVoucher, entries: currentEntries, whatsapp: { prompt: false } };
    }
    // Recheck both new accounts against the active company's account catalog.
    for (const { newId } of changes) {
      const [account] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, newId)).limit(1);
      if (!account || account.companyId !== companyId || !account.active || account.deletedAt) {
        throw new PostingValidationError(
          "POSTING_TARGET_INVALID",
          "Replacement account must be an active ledger account in this company"
        );
      }
    }
    // Applies the correction policy (closed periods/reversed vouchers) and
    // captures the complete pre-edit snapshot for the accounting audit.
    const editContext = await assertVoucherEditableTx(tx, voucherId, { companyId });
    for (const { line, newId } of changes) {
      await tx
        .update(voucherEntries)
        .set({ ledgerAccountId: newId })
        .where(and(eq(voucherEntries.id, line.id), eq(voucherEntries.voucherId, voucherId)));
    }
    // The transfer's nominated cash/source account is authoritative for
    // transfer listings; synchronize it only when the cash side was changed.
    if (cashAccountId !== cashLine.ledgerAccountId) {
      if (transfer.fromVoucherId === voucherId && transfer.fromLedgerAccountId === cashLine.ledgerAccountId) {
        await tx
          .update(interCompanyTransfers)
          .set({ fromLedgerAccountId: cashAccountId })
          .where(eq(interCompanyTransfers.id, transfer.id));
      } else if (transfer.toVoucherId === voucherId && transfer.toLedgerAccountId === cashLine.ledgerAccountId) {
        await tx
          .update(interCompanyTransfers)
          .set({ toLedgerAccountId: cashAccountId })
          .where(eq(interCompanyTransfers.id, transfer.id));
      }
    }
    const audited = await recordVoucherEditAuditTx(tx, {
      voucherId,
      before: editContext.before,
      actor: { userId: params.userId ?? null, username: params.username || "unknown", companyId },
      reason: "Intercompany transfer voucher account correction",
      extra: { intercompanyTransferId: { new: transfer.id }, accountOnly: { new: true } },
    });
    return { voucher: lockedVoucher, entries: audited.entries, whatsapp: { prompt: false } };
  });
}
