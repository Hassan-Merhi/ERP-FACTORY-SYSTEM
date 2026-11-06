/**
 * The Payment / Receipt voucher edit (PATCH /api/vouchers/:id/payment-receipt),
 * moved out of the route unchanged so the factory LAN capture and the cloud
 * replay of an offline edit run the exact same code on their own transaction
 * (plan batch 4, owner-approved 2026-11-05).
 */
import { eq } from "drizzle-orm";
import { vouchers, voucherEntries } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { syncEmployeeBalancesFromEntries } from "../../routes/_helpers";
import { syncContainerChargeVoucherEditTx } from "../containers/offload-lifecycle/charge-voucher-sync";
import { normalizeVoucherEntryAmounts } from "./currencyAmounts";
import { rebalanceVoucherRoundingTx } from "./engineRounding";
import { paymentVoucherTotals } from "./paymentReceiptVoucherPosting";
import { assertVoucherEditableTx, recordVoucherEditAuditTx } from "./voucherCorrection";
import { isVoucherAccountType, voucherEntryAccountLink } from "./voucherEntryAccountLink";
import { assertLockedZmwVoucherEdit, assertResolvedZmwVoucherEntriesTx } from "./zambiaVoucherRatePolicy";

export interface PaymentReceiptEditBody {
  voucherType: "Payment" | "Receipt";
  voucherDate: string;
  paymentAccountType: string;
  paymentAccountId: number;
  entries: Array<{ accountType: string; accountId: number; amount: string }>;
  notes: string | null;
  optional: boolean;
  currency?: string;
  exchangeRate?: string | number | null;
  effectiveDate: string | null;
}

export interface PaymentReceiptEditPlan {
  /** The currency and rate the edit posts at (a posted Kwacha voucher keeps its own). */
  currency: string;
  rate: string | number | null;
  baseTotal: ReturnType<typeof paymentVoucherTotals> extends infer T
    ? T extends { baseTotal: infer B }
      ? B
      : never
    : never;
}

/**
 * The currency, rate and base total an edit posts at, from the voucher as it
 * stands (null when the amounts are invalid). Throws when a locked Kwacha
 * voucher's currency or rate would change.
 */
export function paymentReceiptEditPlan(
  prior: { currency: string | null; exchangeRate: unknown; voucherDate?: unknown },
  body: Pick<PaymentReceiptEditBody, "voucherDate" | "currency" | "exchangeRate" | "entries">
): PaymentReceiptEditPlan | null {
  assertLockedZmwVoucherEdit(
    prior as never,
    {
      voucherDate: body.voucherDate,
      currency: body.currency,
      exchangeRate: body.exchangeRate,
    } as never
  );
  // Only a posted Kwacha voucher locks its currency and rate on edit; the
  // existing USD/CFA PATCH contract (caller-supplied currency/rate) is kept.
  const priorIsZmw = String(prior.currency || "USD").toUpperCase() === "ZMW";
  const currency = priorIsZmw ? "ZMW" : (body.currency as string | undefined) || "USD";
  const rate = priorIsZmw ? String(prior.exchangeRate) : (body.exchangeRate as string | number | undefined) || null;
  // Base total (historical USD) — stored in vouchers.totalAmount
  const totals = paymentVoucherTotals(body.entries, currency, rate);
  if (!totals) return null;
  return { currency, rate, baseTotal: totals.baseTotal };
}

export async function applyPaymentReceiptEditTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    voucherId: number;
    body: PaymentReceiptEditBody;
    plan: PaymentReceiptEditPlan;
    actor: { userId: string | undefined; username: string | undefined };
  }
) {
  const { companyId, voucherId, plan, actor } = input;
  const {
    voucherType,
    voucherDate,
    paymentAccountType,
    paymentAccountId,
    entries,
    notes,
    optional,
    currency,
    exchangeRate,
    effectiveDate,
  } = input.body;
  const pCurrency = plan.currency;
  const pRateRaw = plan.rate;
  const pBaseTotal = plan.baseTotal;
  // Verify voucher exists and belongs to current company
  const [existingVoucher] = await tx.select().from(vouchers).where(eq(vouchers.id, voucherId));

  if (!existingVoucher) {
    throw new Error("Voucher not found");
  }

  if (existingVoucher.companyId !== companyId) {
    throw new Error("Access denied: Voucher belongs to a different company");
  }

  const blockedVoucherReason = voucherMutationBlockReason(existingVoucher);
  if (blockedVoucherReason) {
    throw new Error(blockedVoucherReason);
  }
  // Phase 22 (B), PE9/G4: open-period edit, audited below; closed period → 409.
  const editContext = await assertVoucherEditableTx(tx, voucherId, {
    companyId: existingVoucher.companyId,
    newVoucherDate: voucherDate,
    newEffectiveDate: effectiveDate || null,
  });

  // Recheck the immutable FX header under the write transaction; a
  // second editor must not be able to alter it between read and save.
  assertLockedZmwVoucherEdit(existingVoucher, { voucherDate, currency, exchangeRate });
  // Get existing entries before deleting (for balance sync)
  const oldEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
  if (existingVoucher.currency === "ZMW") {
    await assertResolvedZmwVoucherEntriesTx(tx, existingVoucher.companyId, oldEntries);
  }

  // Update voucher — store historical base (USD) total
  const [updatedVoucher] = await tx
    .update(vouchers)
    .set({
      voucherType,
      voucherDate,
      description: notes || null,
      totalAmount: pBaseTotal.toFixed(6),
      optional: optional ?? false,
      effectiveDate: effectiveDate || null,
    })
    .where(eq(vouchers.id, voucherId))
    .returning();

  // Delete existing voucher entries
  await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

  const voucherEntriesToCreate = [];

  // Create new entries with dual-currency normalization.
  for (const entry of entries) {
    const amount: string = entry.amount;
    const narration = notes || null;

    // Determine account field for entry account
    const entryAccountField = isVoucherAccountType(entry.accountType)
      ? voucherEntryAccountLink(entry.accountType, entry.accountId)
      : {};

    // Determine account field for payment account
    const paymentAccountField = isVoucherAccountType(paymentAccountType)
      ? voucherEntryAccountLink(paymentAccountType, paymentAccountId)
      : {};

    const isLiabilityPaymentAccount =
      paymentAccountType === "supplier" ||
      paymentAccountType === "factorySupplier" ||
      paymentAccountType === "employee";

    // Normalize once; debit/credit fields determined by voucher type below
    const normDR = normalizeVoucherEntryAmounts({
      transactionCurrency: pCurrency,
      baseCurrency: "USD",
      transactionDebitAmount: amount,
      transactionCreditAmount: "0",
      historicalRate: pRateRaw,
    });
    const normCR = normalizeVoucherEntryAmounts({
      transactionCurrency: pCurrency,
      baseCurrency: "USD",
      transactionDebitAmount: "0",
      transactionCreditAmount: amount,
      historicalRate: pRateRaw,
    });

    const mkDR = (acctField: Record<string, unknown>) => ({
      voucherId: updatedVoucher.id,
      ...acctField,
      debitAmount: normDR.debitAmount,
      creditAmount: normDR.creditAmount,
      transactionCurrency: normDR.transactionCurrency,
      transactionDebitAmount: normDR.transactionDebitAmount,
      transactionCreditAmount: normDR.transactionCreditAmount,
      baseDebitAmount: normDR.baseDebitAmount,
      baseCreditAmount: normDR.baseCreditAmount,
      historicalExchangeRate: normDR.historicalExchangeRate,
      rateConvention: normDR.rateConvention,
      narration,
    });
    const mkCR = (acctField: Record<string, unknown>) => ({
      voucherId: updatedVoucher.id,
      ...acctField,
      debitAmount: normCR.debitAmount,
      creditAmount: normCR.creditAmount,
      transactionCurrency: normCR.transactionCurrency,
      transactionDebitAmount: normCR.transactionDebitAmount,
      transactionCreditAmount: normCR.transactionCreditAmount,
      baseDebitAmount: normCR.baseDebitAmount,
      baseCreditAmount: normCR.baseCreditAmount,
      historicalExchangeRate: normCR.historicalExchangeRate,
      rateConvention: normCR.rateConvention,
      narration,
    });

    if (voucherType === "Payment") {
      if (isLiabilityPaymentAccount) {
        voucherEntriesToCreate.push(mkDR(paymentAccountField));
        voucherEntriesToCreate.push(mkCR(entryAccountField));
      } else {
        voucherEntriesToCreate.push(mkDR(entryAccountField));
        voucherEntriesToCreate.push(mkCR(paymentAccountField));
      }
    } else {
      if (isLiabilityPaymentAccount) {
        voucherEntriesToCreate.push(mkDR(entryAccountField));
        voucherEntriesToCreate.push(mkCR(paymentAccountField));
      } else {
        voucherEntriesToCreate.push(mkDR(paymentAccountField));
        voucherEntriesToCreate.push(mkCR(entryAccountField));
      }
    }
  }

  // Batch insert all new voucher entries
  const insertedEntries = await tx.insert(voucherEntries).values(voucherEntriesToCreate).returning();
  // Phase 22 A (D3): the rounding remainder of an engine voucher's new lines.
  await rebalanceVoucherRoundingTx(tx, { companyId: existingVoucher.companyId, voucherId });

  // An edited duty/transport/office charge voucher re-prices the offloaded bales.
  await syncContainerChargeVoucherEditTx(tx, {
    companyId: existingVoucher.companyId,
    voucherNumber: existingVoucher.voucherNumber,
    oldTotal: existingVoucher.optional ? 0 : existingVoucher.totalAmount,
    newTotal: updatedVoucher.optional ? 0 : updatedVoucher.totalAmount,
  });

  // Wave 12: employee balances move in this transaction, and the edit is
  // audited with the full before/after snapshot before it commits.
  if (!existingVoucher.optional) {
    await syncEmployeeBalancesFromEntries(oldEntries, companyId, true, tx);
  }
  if (!updatedVoucher.optional) {
    await syncEmployeeBalancesFromEntries(insertedEntries, companyId, false, tx);
  }
  const audited = await recordVoucherEditAuditTx(tx, {
    voucherId,
    before: editContext.before,
    actor: {
      userId: actor.userId,
      username: actor.username,
      companyId: companyId,
    },
    reason: `${voucherType} voucher update`,
  });
  const createdEntries = audited.entries;

  return {
    voucher: updatedVoucher,
    entries: createdEntries,
    oldEntries,
    existingVoucher,
    wasOptional: existingVoucher.optional,
  };
}
