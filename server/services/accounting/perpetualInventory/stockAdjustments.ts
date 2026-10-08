/**
 * Stock adjustments under perpetual inventory (wave 8.3).
 *
 * A stock adjustment voucher (Production, Consumption, Mixed, Stock
 * Adjustment) posts its profit-and-loss side to STOCK_ADJUSTMENT: production
 * credits it with the value received, consumption debits it with the value
 * issued. Under periodic inventory that was the whole posting, and the stock
 * sub-ledger carried the contra. Once the company's cut-over applies, the
 * voucher also carries that contra in the ledger: one line on the inventory
 * control account for the net of its other lines, so the voucher balances
 * (production Dr Inventory, consumption Cr Inventory).
 *
 * Wave 11: the inventory line carries exactly what the stock sub-ledger moved,
 * the sum of the voucher's stock_adjustment_items.value_moved (each line's
 * AdjustInventoryResult.valueDelta, stored as an amount: the direction is the
 * line's, received on a Production, issued on a Consumption, and by the sign of
 * the quantity on a Mixed voucher, as the adjustment writer moves the stock;
 * the type is compared trimmed and case-insensitively, so an imported
 * 'consumption' line is an issue, not a receipt). The voucher's other lines value
 * the document at quantity × the document rate; where that differs from what
 * the sub-ledger moved (a consumption issues stock at its average cost, not at
 * the rate typed on the voucher; a production into negative stock takes back
 * the shortage's provisional value) the difference is posted on a second
 * marked line to INVENTORY_ADJUSTMENT, so the voucher still balances and the
 * INVENTORY account moves with the sub-ledger. A voucher with a line written
 * before wave 11 (value_moved NULL) keeps the old rule: one inventory line for
 * the net of its other lines.
 *
 * The inventory line is derived from the voucher's current lines and replaced
 * whole by syncStockAdjustmentInventoryTx, which the create, edit, date-change,
 * line-replacement, optional and restore paths call. It is marked by its
 * narration: an inventory line entered by hand is left alone and counted with
 * the other lines. An optional or deleted voucher, a voucher dated before the
 * cut-over and a supplier-partner company carry no inventory line.
 */
import { sql } from "drizzle-orm";

import { voucherEntries } from "@shared/schema";

import type { DbTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getOrCreateInventoryControlAccount } from "../inventoryControlAccount";
import { isPerpetualInventoryActive } from "./cutover";
import { isSupplierPartnerCompany, systemAccountIdsTx } from "./linkedJournal";

/** The voucher types the stock adjustment writers create. */
export const STOCK_ADJUSTMENT_VOUCHER_TYPES: ReadonlySet<string> = new Set([
  "Production",
  "Consumption",
  "Mixed",
  "Stock Adjustment",
]);

export const STOCK_ADJUSTMENT_INVENTORY_NARRATION = "Inventory - stock adjustment";
export const STOCK_ADJUSTMENT_VALUATION_NARRATION = "Inventory - stock adjustment valuation difference";

/**
 * Replaces the inventory line (and valuation-difference line) of a stock
 * adjustment voucher. Returns the amount posted to inventory (positive =
 * debit), or null when the voucher carries no inventory line. A voucher of
 * another type is left untouched.
 */
export async function syncStockAdjustmentInventoryTx(
  tx: DbTransaction,
  companyId: number,
  voucherId: number
): Promise<string | null> {
  const voucher = (
    await tx.execute(sql`
      SELECT voucher_type, voucher_date::text AS voucher_date, optional, deleted_at
        FROM vouchers WHERE id = ${voucherId} AND company_id = ${companyId}
    `)
  ).rows[0] as
    { voucher_type: string; voucher_date: string; optional: boolean | null; deleted_at: string | null } | undefined;
  if (!voucher || !STOCK_ADJUSTMENT_VOUCHER_TYPES.has(voucher.voucher_type)) return null;

  await tx.execute(sql`
    DELETE FROM voucher_entries ve
     USING ledger_accounts la, vouchers v
     WHERE ve.voucher_id = ${voucherId} AND v.id = ve.voucher_id AND v.company_id = ${companyId}
       AND la.id = ve.ledger_account_id AND la.company_id = ${companyId}
       AND ((la.code = 'INVENTORY' AND ve.narration = ${STOCK_ADJUSTMENT_INVENTORY_NARRATION})
         OR (la.code = 'INVENTORY_ADJUSTMENT' AND ve.narration = ${STOCK_ADJUSTMENT_VALUATION_NARRATION}))
  `);

  if (voucher.optional === true || voucher.deleted_at !== null) return null;
  if (!(await isPerpetualInventoryActive(tx, companyId, voucher.voucher_date))) return null;
  if (await isSupplierPartnerCompany(tx, companyId)) return null;

  const [totals] = (
    await tx.execute(sql`
      SELECT COALESCE(SUM(ve.debit_amount), 0)::text AS debit, COALESCE(SUM(ve.credit_amount), 0)::text AS credit
        FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
       WHERE ve.voucher_id = ${voucherId} AND v.company_id = ${companyId}
    `)
  ).rows as { debit: string; credit: string }[];
  // The inventory line takes the side the other lines leave open.
  const net = toMoney(totals?.credit ?? 0)
    .minus(toMoney(totals?.debit ?? 0))
    .toDecimalPlaces(2);

  // What the sub-ledger moved, when every line recorded it.
  const [moved] = (
    await tx.execute(sql`
      SELECT COUNT(sai.id)::int AS lines,
             COUNT(sai.value_moved)::int AS recorded,
             COALESCE(SUM(CASE
               WHEN LOWER(BTRIM(COALESCE(sav.adjustment_type, ''))) = 'production' THEN ABS(sai.value_moved)
               WHEN LOWER(BTRIM(COALESCE(sav.adjustment_type, ''))) = 'consumption' THEN -ABS(sai.value_moved)
               WHEN sai.quantity < 0 THEN -ABS(sai.value_moved)
               ELSE ABS(sai.value_moved)
             END), 0)::text AS value
        FROM stock_adjustment_vouchers sav
        JOIN stock_adjustment_items sai ON sai.adjustment_id = sav.id
        JOIN vouchers v ON v.id = sav.voucher_id AND v.company_id = ${companyId}
       WHERE sav.voucher_id = ${voucherId}
    `)
  ).rows as { lines: number; recorded: number; value: string }[];
  const exact = moved !== undefined && moved.lines > 0 && moved.recorded === moved.lines;
  const inventory = exact ? toMoney(moved.value).toDecimalPlaces(2) : net;
  const difference = net.minus(inventory);
  if (inventory.isZero() && difference.isZero()) return null;

  const { id: inventoryAccountId } = await getOrCreateInventoryControlAccount(tx, companyId);
  const zero = new MoneyDecimal(0);
  const entries: Array<typeof voucherEntries.$inferInsert> = [];
  if (!inventory.isZero()) {
    entries.push({
      voucherId,
      ledgerAccountId: inventoryAccountId,
      debitAmount: (inventory.isPositive() ? inventory : zero).toFixed(2),
      creditAmount: (inventory.isNegative() ? inventory.negated() : zero).toFixed(2),
      narration: STOCK_ADJUSTMENT_INVENTORY_NARRATION,
    });
  }
  if (!difference.isZero()) {
    const adjustmentAccountId = (await systemAccountIdsTx(tx, companyId, ["INVENTORY_ADJUSTMENT"])).get(
      "INVENTORY_ADJUSTMENT"
    )!;
    entries.push({
      voucherId,
      ledgerAccountId: adjustmentAccountId,
      debitAmount: (difference.isPositive() ? difference : zero).toFixed(2),
      creditAmount: (difference.isNegative() ? difference.negated() : zero).toFixed(2),
      narration: STOCK_ADJUSTMENT_VALUATION_NARRATION,
    });
  }
  await tx.insert(voucherEntries).values(entries);
  return inventory.toFixed(2);
}
