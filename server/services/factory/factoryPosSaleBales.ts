/**
 * The bales each factory POS sale took (accounting audit wave 11).
 *
 * A factory POS sale marks bales SOLD. It used not to record which, so a void
 * or an edit re-opened "the most recent SOLD bales of the product at the
 * location", which can be other bales (another sale's, or an order's), and its
 * cost of sales could differ from what was relieved. Now:
 *   - a sale records its bales in factory_pos_sale_bales;
 *   - a void or an edit puts back exactly those bales (those still SOLD) and
 *     forgets them;
 *   - FPOS-COGS is the SUM of those bales' total_cost.
 * A sale written before this table existed has no rows: its void or edit keeps
 * the old heuristic (`legacy: true`), so history still reverses.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";

async function rows<T>(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)).rows as unknown as T[];
}

/** Records the bales a sale took (idempotent per sale and bale). */
export async function recordPosSaleBalesTx(
  tx: DbTransaction,
  companyId: number,
  saleId: number,
  baleIds: readonly number[]
): Promise<void> {
  for (const baleId of baleIds) {
    await tx.execute(sql`
      INSERT INTO factory_pos_sale_bales (company_id, sale_id, bale_id, cost_at_sale)
      SELECT ${companyId}, ${saleId}, b.id, b.total_cost FROM factory_bales b
       WHERE b.id = ${baleId} AND b.company_id = ${companyId}
      ON CONFLICT (sale_id, bale_id) DO NOTHING
    `);
  }
}

/** The bales a sale recorded. */
export async function posSaleBaleIdsTx(tx: DbTransaction, companyId: number, saleId: number): Promise<number[]> {
  const recorded = await rows<{ bale_id: number }>(
    tx,
    sql`SELECT bale_id FROM factory_pos_sale_bales WHERE company_id = ${companyId} AND sale_id = ${saleId} ORDER BY bale_id`
  );
  return recorded.map((row) => row.bale_id);
}

/**
 * Puts back the bales a sale recorded (those still SOLD return to IN_STOCK)
 * and forgets them. `legacy` is true when the sale recorded none.
 */
export async function releasePosSaleBalesTx(
  tx: DbTransaction,
  companyId: number,
  saleId: number
): Promise<{ legacy: boolean; restored: number[] }> {
  const baleIds = await posSaleBaleIdsTx(tx, companyId, saleId);
  if (baleIds.length === 0) return { legacy: true, restored: [] };
  const restored = await rows<{ id: number }>(
    tx,
    sql`
      UPDATE factory_bales SET status = 'IN_STOCK', updated_at = now()
       WHERE company_id = ${companyId} AND status = 'SOLD'
         AND id IN (SELECT bale_id FROM factory_pos_sale_bales WHERE company_id = ${companyId} AND sale_id = ${saleId})
      RETURNING id
    `
  );
  await tx.execute(sql`DELETE FROM factory_pos_sale_bales WHERE company_id = ${companyId} AND sale_id = ${saleId}`);
  return { legacy: false, restored: restored.map((row) => row.id).sort((a, b) => a - b) };
}

/** The cost of the bales a sale recorded: the SUM of their total_cost. */
export async function posSaleBalesCostTx(tx: DbTransaction, companyId: number, saleId: number): Promise<Decimal> {
  const [row] = await rows<{ cost: string }>(
    tx,
    sql`
      SELECT COALESCE(SUM(b.total_cost), 0)::text AS cost
        FROM factory_pos_sale_bales sb JOIN factory_bales b ON b.id = sb.bale_id AND b.company_id = ${companyId}
       WHERE sb.company_id = ${companyId} AND sb.sale_id = ${saleId}
    `
  );
  return row ? toMoney(row.cost) : new MoneyDecimal(0);
}
