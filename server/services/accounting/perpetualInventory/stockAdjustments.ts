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
import { isSupplierPartnerCompany } from "./linkedJournal";

/** The voucher types the stock adjustment writers create. */
export const STOCK_ADJUSTMENT_VOUCHER_TYPES: ReadonlySet<string> = new Set([
  "Production",
  "Consumption",
  "Mixed",
  "Stock Adjustment",
]);

export const STOCK_ADJUSTMENT_INVENTORY_NARRATION = "Inventory - stock adjustment";

/**
 * Replaces the inventory line of a stock adjustment voucher. Returns the net
 * amount posted to inventory (positive = debit), or null when the voucher
 * carries no inventory line. A voucher of another type is left untouched.
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
       AND la.id = ve.ledger_account_id AND la.company_id = ${companyId} AND la.code = 'INVENTORY'
       AND ve.narration = ${STOCK_ADJUSTMENT_INVENTORY_NARRATION}
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
  if (net.isZero()) return null;

  const { id: inventoryAccountId } = await getOrCreateInventoryControlAccount(tx, companyId);
  const zero = new MoneyDecimal(0);
  await tx.insert(voucherEntries).values({
    voucherId,
    ledgerAccountId: inventoryAccountId,
    debitAmount: (net.isPositive() ? net : zero).toFixed(2),
    creditAmount: (net.isNegative() ? net.negated() : zero).toFixed(2),
    narration: STOCK_ADJUSTMENT_INVENTORY_NARRATION,
  });
  return net.toFixed(2);
}
