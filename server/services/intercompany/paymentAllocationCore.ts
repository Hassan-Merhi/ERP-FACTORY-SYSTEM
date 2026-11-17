/** Signed, append-only PO allocations; no cash or bank movement occurs in this module.
 * Caller holds the source-company advisory lock for the entire transaction.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { intercompanyContainerPayments, intercompanyPaymentAllocations, intercompanyTrades } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { MoneyDecimal, sumMoney } from "../../lib/money";
import { oldestAvailableCredits, pairCreditBalance } from "./paymentMoney";
import { cents } from "./tradeRevisionMath";

export const INTERCOMPANY_PAYMENT_LOCK_NAMESPACE = 741235;
export async function paymentAvailableTx(tx: DbTransaction, paymentId: number) {
  const [payment] = await tx
    .select()
    .from(intercompanyContainerPayments)
    .where(eq(intercompanyContainerPayments.id, paymentId));
  if (!payment) throw new Error("Verified intercompany payment not found");
  const events = await tx
    .select({ amount: intercompanyPaymentAllocations.amount })
    .from(intercompanyPaymentAllocations)
    .where(eq(intercompanyPaymentAllocations.paymentId, paymentId));
  return pairCreditBalance(
    cents(payment.baseAmount),
    events.map((e) => cents(e.amount))
  );
}
export async function tradeAppliedTx(tx: DbTransaction, tradeId: number) {
  const rows = await tx
    .select({ amount: intercompanyPaymentAllocations.amount })
    .from(intercompanyPaymentAllocations)
    .where(eq(intercompanyPaymentAllocations.tradeId, tradeId));
  const amount = sumMoney(rows.map((row) => cents(row.amount)));
  if (amount.lt(0)) throw new Error("Intercompany PO payment allocation is unreconciled");
  return amount;
}
export async function pairCreditsTx(tx: DbTransaction, relationshipId: number) {
  const payments = await tx
    .select()
    .from(intercompanyContainerPayments)
    .where(
      and(
        eq(intercompanyContainerPayments.relationshipId, relationshipId),
        eq(intercompanyContainerPayments.status, "confirmed")
      )
    )
    .orderBy(asc(intercompanyContainerPayments.paymentDate), asc(intercompanyContainerPayments.id));
  const balances: Array<{ id: number; available: ReturnType<typeof cents>; paymentDate: string }> = [];
  for (const payment of payments) {
    const available = await paymentAvailableTx(tx, payment.id);
    if (available.gt(0)) balances.push({ id: payment.id, available, paymentDate: payment.paymentDate });
  }
  return balances;
}
/** New imports automatically consume existing credit in chronological order only within their pair. */
export async function autoAllocateNewTradeCreditTx(
  tx: DbTransaction,
  input: {
    tradeId: number;
    relationshipId: number;
    confirmedLandedCost: string;
  }
) {
  const [trade] = await tx.select().from(intercompanyTrades).where(eq(intercompanyTrades.id, input.tradeId));
  if (!trade || trade.state !== "active" || trade.relationshipId !== input.relationshipId) {
    throw new Error("Automatic credit requires a verified new active trade of the same company pair");
  }
  const current = await tradeAppliedTx(tx, input.tradeId),
    cost = cents(input.confirmedLandedCost);
  const due = cost.minus(current);
  if (due.lt(0)) throw new Error("Existing PO allocation exceeds its confirmed cost");
  const credits = await pairCreditsTx(tx, input.relationshipId);
  const plan = oldestAvailableCredits(credits, due);
  for (const part of plan) {
    await tx.insert(intercompanyPaymentAllocations).values({
      paymentId: part.paymentId,
      tradeId: input.tradeId,
      amount: part.amount.toFixed(2),
      allocationKind: "new_import_credit",
      requestKey: "ic-import-credit:" + input.tradeId + ":" + part.paymentId,
      createdBy: null,
      reason: "Existing credit automatically applied at company-pair PO import",
    });
  }
  const used = sumMoney(plan.map((p) => p.amount));
  return { applied: used.toFixed(2), remainingDue: due.minus(used).toFixed(2) };
}
/** Preserve PO allocations where possible. Release excess credit; never re-autoapply it on edits. */
export async function releaseEditOverallocationTx(
  tx: DbTransaction,
  input: {
    tradeId: number;
    newLandedCost: string;
    actorUserId: string;
    revisionId: number;
  }
) {
  const current = await tradeAppliedTx(tx, input.tradeId);
  const excess = current.minus(cents(input.newLandedCost));
  if (!excess.gt(0)) return { released: "0.00", details: [] };
  const events = await tx
    .select()
    .from(intercompanyPaymentAllocations)
    .where(eq(intercompanyPaymentAllocations.tradeId, input.tradeId))
    .orderBy(desc(intercompanyPaymentAllocations.id));
  const priority = (kind: string) => (kind === "new_import_credit" ? 0 : kind === "cancel_credit_reallocate" ? 1 : 2);
  events.sort((a, b) => priority(a.allocationKind) - priority(b.allocationKind) || b.id - a.id);
  const net = new Map<number, ReturnType<typeof cents>>();
  for (const e of events) net.set(e.paymentId, (net.get(e.paymentId) ?? new MoneyDecimal(0)).plus(cents(e.amount)));
  let remaining = excess;
  const details: Array<{ paymentId: number; amount: string }> = [];
  for (const event of events) {
    if (remaining.lte(0)) break;
    if (!["manual", "new_import_credit", "cancel_credit_reallocate"].includes(event.allocationKind)) continue;
    const available = net.get(event.paymentId) ?? new MoneyDecimal(0);
    const released = MoneyDecimal.min(remaining, available, cents(event.amount));
    if (!released.gt(0)) continue;
    await tx.insert(intercompanyPaymentAllocations).values({
      paymentId: event.paymentId,
      tradeId: input.tradeId,
      amount: released.negated().toFixed(2),
      allocationKind: "edit_release",
      requestKey: "ic-edit-release:" + input.revisionId + ":" + event.id,
      createdBy: input.actorUserId,
      reason: "PO cost decrease returned overpaid credit to original company pair",
    });
    remaining = remaining.minus(released);
    net.set(event.paymentId, available.minus(released));
    details.push({ paymentId: event.paymentId, amount: released.toFixed(2) });
  }
  if (!remaining.isZero()) throw new Error("Cannot safely release excess PO allocation");
  return { released: excess.toFixed(2), details };
}
/** Reverse an actual payment's allocations without inventing any new bank/cash movement. */
export async function releasePaymentAllocationsTx(
  tx: DbTransaction,
  input: {
    paymentId: number;
    actorUserId: string;
  }
) {
  const events = await tx
    .select()
    .from(intercompanyPaymentAllocations)
    .where(eq(intercompanyPaymentAllocations.paymentId, input.paymentId));
  const byTrade = new Map<number, ReturnType<typeof cents>>();
  for (const e of events) byTrade.set(e.tradeId, (byTrade.get(e.tradeId) ?? new MoneyDecimal(0)).plus(cents(e.amount)));
  const released: Array<{ tradeId: number; amount: string }> = [];
  for (const [tradeId, amount] of byTrade) {
    if (amount.lt(0)) throw new Error("Negative allocation found during mirrored payment reversal");
    if (amount.isZero()) continue;
    await tx.insert(intercompanyPaymentAllocations).values({
      paymentId: input.paymentId,
      tradeId,
      amount: amount.negated().toFixed(2),
      allocationKind: "reversal_release",
      requestKey: "ic-payment-reversal:" + input.paymentId + ":" + tradeId,
      createdBy: input.actorUserId,
      reason: "Reversed both confirmed cash/bank payment vouchers",
    });
    released.push({ tradeId, amount: amount.toFixed(2) });
  }
  return released;
}
