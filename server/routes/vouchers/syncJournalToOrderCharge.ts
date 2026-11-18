// Extracted from ./voucherJournalRoutes.ts to keep that module under the source-size cap.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { recalculateOrderTotals } from "../factory/_helpers";
import { customerBalances, customerOrderCharges, customerOrders } from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../lib/money";

/**
 * Transaction-currency debit and credit totals of a journal request. Amounts
 * are read the way the float path read them (a leading number, else 0) but
 * summed exactly.
 */
export function journalTotals(entries: Array<{ type?: unknown; amount?: unknown }>): {
  debits: Decimal;
  credits: Decimal;
} {
  let debits = new MoneyDecimal(0);
  let credits = new MoneyDecimal(0);
  for (const entry of entries) {
    const amount = parseMoneyInput(entry.amount || "0") ?? new MoneyDecimal(0);
    if (entry.type === "DR") debits = debits.plus(amount);
    else if (entry.type === "CR") credits = credits.plus(amount);
  }
  return { debits, credits };
}

/** The voucher's CFA-per-USD rate as the float path read it; NaN when unreadable. */
export function journalRate(currency: string, rateRaw: string | number | null): Decimal {
  if (currency === "USD" || !rateRaw) return new MoneyDecimal(1);
  return parseMoneyInput(String(rateRaw)) ?? new MoneyDecimal(NaN);
}

/** The historical base (USD) total: the larger side, divided by a positive rate. */
export function journalBaseTotal(
  currency: string,
  totals: { debits: Decimal; credits: Decimal },
  rate: Decimal
): Decimal {
  const larger = MoneyDecimal.max(totals.debits, totals.credits);
  return currency !== "USD" && rate.greaterThan(0) ? larger.dividedBy(rate) : larger;
}

/**
 * After saving a journal voucher, if it has a customer entry + a ledger account entry,
 * look for order charges linked to that ledger account for that customer.
 * If exactly one charge is found, update its amount and recalculate the order totals.
 */

export async function syncJournalToOrderCharge(
  tx: DbTransaction,
  companyId: number,
  savedEntries: Array<{
    customerId: number | null;
    ledgerAccountId: number | null;
    debitAmount: string | null;
    creditAmount: string | null;
  }>,
  voucherId?: number
) {
  const customerEntry = savedEntries.find((e) => e.customerId !== null);
  if (!customerEntry) return;

  const ledgerCrEntries = savedEntries.filter(
    (e) => e.ledgerAccountId !== null && e.customerId === null && toMoney(e.creditAmount).greaterThan(0)
  );
  if (ledgerCrEntries.length === 0) return;

  for (const ledgerEntry of ledgerCrEntries) {
    const newAmount = toMoney(ledgerEntry.creditAmount);
    if (newAmount.lessThanOrEqualTo(0)) continue;

    let matchingCharges: { id: number; orderId: number; amount: string; chargeType: string }[] = [];

    // Priority 1: find by direct voucher link (exact match, no ambiguity)
    if (voucherId) {
      matchingCharges = await tx
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
    }

    // Priority 2: fall back to ledger account match (only if exactly one unlinked result)
    if (matchingCharges.length === 0) {
      const byLedger = await tx
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

      if (byLedger.length === 1) {
        matchingCharges = byLedger;
      }
    }

    if (matchingCharges.length === 0) continue;

    const charge = matchingCharges[0];
    const amountChanged = !toMoney(charge.amount).equals(newAmount.toDecimalPlaces(2));

    // Phase 22 (B), PE10: in the journal's own transaction (it ran after the
    // commit, its failure swallowed): charge amount, order totals and the
    // invoice balance commit with the journal or not at all.
    {
      // Update charge amount and stamp voucherId for direct future lookups
      await tx
        .update(customerOrderCharges)
        .set({
          amount: newAmount.toFixed(2),
          ...(voucherId ? { voucherId } : {}),
        })
        .where(eq(customerOrderCharges.id, charge.id));

      if (!amountChanged) continue; // voucherId stamp done, but no recalc needed

      // DI7: the order is locked before its totals are recalculated.
      await tx.execute(sql`SELECT id FROM customer_orders WHERE id = ${charge.orderId} FOR UPDATE`);
      // Recalculate and save order totals
      await recalculateOrderTotals(tx, charge.orderId);

      // Also sync the invoice debit in customerBalances
      const [updatedOrder] = await tx
        .select({ grandTotal: customerOrders.grandTotal })
        .from(customerOrders)
        .where(eq(customerOrders.id, charge.orderId));

      if (updatedOrder) {
        // DI7: the invoice balance row is locked before it is rewritten.
        await tx.execute(sql`
          SELECT id FROM customer_balances
           WHERE company_id = ${companyId} AND reference_id = ${charge.orderId} AND reference_type = 'INVOICE'
           FOR UPDATE
        `);
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
    }
  }
}
