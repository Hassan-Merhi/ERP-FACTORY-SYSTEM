/**
 * A factory order-charge voucher (`CHARGE-<…>-<chargeId>-<n>`) edited through
 * the generic voucher editor: the charge, the order totals and a FINALIZED
 * order's invoice balance follow the edit.
 *
 * Phase 22 (B), PE10 / DI7: runs inside the edit's transaction (it ran after
 * the commit, on the pool), in exact decimals (the charge amount was a float),
 * with the order and its `customer_balances` rows locked FOR UPDATE so a
 * concurrent edit cannot lose this update.
 */
import type Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { customerBalances, customerOrderCharges, customerOrders, type Voucher } from "@shared/schema";
import type { DbTransaction } from "../../../db";
import { recalculateOrderTotals } from "../../factory/_helpers";

export async function syncFactoryChargeVoucherEditTx(
  tx: DbTransaction,
  input: { companyId: number; voucher: Voucher; description: string | null; newAmount: Decimal }
): Promise<void> {
  const chargeMatch = input.voucher.voucherNumber?.match(/^CHARGE-.+-(\d+)-\d+$/);
  if (!chargeMatch || input.voucher.sourceModule !== "FACTORY") return;
  const chargeId = parseInt(chargeMatch[1]);
  const [charge] = await tx
    .select({ orderId: customerOrderCharges.orderId })
    .from(customerOrderCharges)
    .where(eq(customerOrderCharges.id, chargeId));
  if (!charge) return;

  await tx.execute(
    sql`SELECT id FROM customer_orders WHERE id = ${charge.orderId} AND company_id = ${input.companyId} FOR UPDATE`
  );
  const chargeUpdate: { amount: string; name?: string } = { amount: input.newAmount.toFixed(2) };
  if (input.description?.trim()) chargeUpdate.name = input.description.trim();
  await tx.update(customerOrderCharges).set(chargeUpdate).where(eq(customerOrderCharges.id, chargeId));
  await recalculateOrderTotals(tx, charge.orderId);
  const [updatedOrd] = await tx
    .select({ grandTotal: customerOrders.grandTotal, status: customerOrders.status })
    .from(customerOrders)
    .where(eq(customerOrders.id, charge.orderId));
  if (updatedOrd?.status !== "FINALIZED") return;

  await tx.execute(sql`
    SELECT id FROM customer_balances
     WHERE company_id = ${input.companyId} AND reference_id = ${charge.orderId} AND reference_type = 'INVOICE'
     FOR UPDATE
  `);
  await tx
    .update(customerBalances)
    .set({ debitAmount: String(updatedOrd.grandTotal), balance: String(updatedOrd.grandTotal) })
    .where(
      and(
        eq(customerBalances.companyId, input.companyId),
        eq(customerBalances.referenceId, charge.orderId),
        eq(customerBalances.referenceType, "INVOICE")
      )
    );
}
