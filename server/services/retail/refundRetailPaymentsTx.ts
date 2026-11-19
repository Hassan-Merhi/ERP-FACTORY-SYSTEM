// Extracted from ./retailFinancialService.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { and, asc, eq } from "drizzle-orm";
import { retailPosPayments, retailPosSales } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { resolveRetailPaymentAccountTx, type RetailMoneyAccountSelection } from "./retailPaymentAccounts";
import { ensureRetailAccountingSettingsTx } from "./retailAccountingSettingsService";
import {
  EPSILON,
  deriveRetailIdempotencyKey,
  exactMoney,
  money,
  resolvedPayment,
  type RetailResolvedPayment,
} from "./validateRetailShiftTx";

export async function refundRetailPaymentsTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    saleId: number;
    locationId: number;
    shiftId?: number | null;
    refundAmount: Decimal.Value;
    idempotencyKey: string;
    userId: string;
    /** Cash/card/bank refund, or credit the real customer ledger instead. */
    destination?: "original" | "customer_credit" | "account";
    refundAccount?: RetailMoneyAccountSelection;
  }
): Promise<RetailResolvedPayment[]> {
  let remaining = exactMoney(input.refundAmount, "Retail refund amount");
  if (remaining.lessThanOrEqualTo(0)) return [];
  const refundTarget =
    input.destination === "account"
      ? await resolveRetailPaymentAccountTx(tx, input.companyId, input.refundAccount ?? {})
      : null;
  if (input.destination !== "account" && (input.refundAccount?.ledgerAccountId || input.refundAccount?.bankAccountId)) {
    throw new Error("Manual refund account requires account refund destination");
  }
  if (input.destination === "customer_credit") {
    const [sale] = await tx
      .select({ customerId: retailPosSales.customerId })
      .from(retailPosSales)
      .where(and(eq(retailPosSales.companyId, input.companyId), eq(retailPosSales.id, input.saleId)))
      .limit(1);
    if (!sale?.customerId) throw new Error("Select a customer before issuing customer-account credit");
  }
  let payments = await tx
    .select()
    .from(retailPosPayments)
    .where(
      and(
        eq(retailPosPayments.companyId, input.companyId),
        eq(retailPosPayments.saleId, input.saleId),
        eq(retailPosPayments.paymentType, "payment")
      )
    )
    .orderBy(asc(retailPosPayments.id));

  // Backward compatibility for Retail sales created before Wave 1 payments existed.
  // Materialize the historical sale total as one cash payment without rewriting the
  // sale or its stock history, so old receipts can still be returned/cancelled.
  if (!payments.length) {
    const [sale] = await tx
      .select({ totalAmount: retailPosSales.totalAmount })
      .from(retailPosSales)
      .where(and(eq(retailPosSales.companyId, input.companyId), eq(retailPosSales.id, input.saleId)))
      .limit(1);
    if (!sale) throw new Error("Retail sale not found");
    const legacyTotal = toMoney(sale.totalAmount);
    if (legacyTotal.lessThan(remaining)) {
      throw new Error("Original Retail sale does not have enough paid value to refund");
    }
    const settings = await ensureRetailAccountingSettingsTx(tx, input.companyId, input.locationId);
    const legacyKey = `retail-legacy-payment:${input.saleId}`;
    await tx
      .insert(retailPosPayments)
      .values({
        companyId: input.companyId,
        saleId: input.saleId,
        locationId: input.locationId,
        shiftId: null,
        paymentType: "payment",
        method: "cash",
        amount: money(legacyTotal),
        tenderedAmount: null,
        changeAmount: "0",
        reference: "Legacy Retail sale payment",
        ledgerAccountId: settings.cashLedgerAccountId,
        bankAccountId: null,
        idempotencyKey: legacyKey,
        createdBy: input.userId,
      })
      .onConflictDoNothing();
    payments = await tx
      .select()
      .from(retailPosPayments)
      .where(
        and(
          eq(retailPosPayments.companyId, input.companyId),
          eq(retailPosPayments.saleId, input.saleId),
          eq(retailPosPayments.paymentType, "payment")
        )
      )
      .orderBy(asc(retailPosPayments.id));
  }

  // Reverse unpaid receivables before returning any real cash/bank tender.
  // An item returned on a partly paid invoice must never pay out more cash
  // while an uncollected credit portion still exists on that sale.
  payments = [...payments].sort((a, b) => Number(b.method === "credit") - Number(a.method === "credit") || a.id - b.id);

  const refunds = await tx
    .select()
    .from(retailPosPayments)
    .where(
      and(
        eq(retailPosPayments.companyId, input.companyId),
        eq(retailPosPayments.saleId, input.saleId),
        eq(retailPosPayments.paymentType, "refund")
      )
    );
  const refundedByPayment = new Map<number, Decimal>();
  for (const row of refunds) {
    if (!row.relatedPaymentId) continue;
    refundedByPayment.set(
      row.relatedPaymentId,
      (refundedByPayment.get(row.relatedPaymentId) ?? new MoneyDecimal(0)).plus(toMoney(row.amount))
    );
  }

  const created: RetailResolvedPayment[] = [];
  for (const original of payments) {
    if (remaining.lessThanOrEqualTo(EPSILON)) break;
    const available = MoneyDecimal.max(0, toMoney(original.amount).minus(refundedByPayment.get(original.id) ?? 0));
    if (available.isZero()) continue;
    const amount = MoneyDecimal.min(available, remaining);
    const key = deriveRetailIdempotencyKey(input.idempotencyKey, `refund:${original.id}`);
    // Credit-original = cancellation of an unpaid receivable. For collected
    // tenders customer_credit records a fresh credit to the party, not a payout.
    const refundMethod =
      input.destination === "customer_credit" && original.method !== "credit"
        ? "store_credit"
        : input.destination === "account" && original.method !== "credit"
          ? refundTarget!.method
          : original.method;
    const [inserted] = await tx
      .insert(retailPosPayments)
      .values({
        companyId: input.companyId,
        saleId: input.saleId,
        locationId: input.locationId,
        // Only the validated current shift; a closed historical shift must not absorb later cash.
        shiftId: input.shiftId ?? null,
        paymentType: "refund",
        method: refundMethod,
        amount: money(amount),
        tenderedAmount: null,
        changeAmount: "0",
        reference:
          refundMethod === "store_credit"
            ? `Customer credit from payment #${original.id}`
            : `Refund for payment #${original.id}`,
        ledgerAccountId:
          refundMethod === "store_credit"
            ? null
            : original.method === "credit"
              ? null
              : (refundTarget?.ledgerAccountId ?? original.ledgerAccountId),
        bankAccountId:
          refundMethod === "store_credit"
            ? null
            : original.method === "credit"
              ? null
              : (refundTarget?.bankAccountId ?? original.bankAccountId),
        relatedPaymentId: original.id,
        idempotencyKey: key,
        createdBy: input.userId,
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted ??
      (
        await tx
          .select()
          .from(retailPosPayments)
          .where(and(eq(retailPosPayments.companyId, input.companyId), eq(retailPosPayments.idempotencyKey, key)))
          .limit(1)
      )[0];
    if (!row) throw new Error("Retail refund payment could not be persisted");
    created.push(resolvedPayment(row));
    remaining = remaining.minus(amount);
  }
  if (remaining.greaterThan(EPSILON)) {
    throw new Error(`Refund exceeds the remaining paid amount by ${remaining.toFixed(2)}`);
  }
  return created;
}
