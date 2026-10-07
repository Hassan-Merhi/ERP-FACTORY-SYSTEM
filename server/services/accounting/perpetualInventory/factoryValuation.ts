/**
 * The factory's stock at book cost (wave 8), as its own costing holds it now.
 *
 * The owner's decision makes the factory costing the book cost:
 *   Raw material     remaining kg × landed USD cost per kg (factory_raw_stock)
 *   Work in progress open mix-batch kg × mix cost per kg, plus bales awaiting
 *                    pressing at their recorded cost
 *   Finished goods   bales held at their recorded cost, including bales already
 *                    marked sold on orders that are not invoiced yet (their
 *                    cost of sales is posted with the invoice)
 *
 * The opening journal and the daily factory stock journal both value the
 * factory with this function. Rows that carry no cost are listed, never valued
 * at a guess.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";

export interface UnvaluedRow {
  source: "factory_raw_stock" | "factory_mix_batches" | "factory_bales";
  id: number;
  reason: string;
}

export interface FactoryStockValuation {
  raw: Decimal;
  wip: Decimal;
  finished: Decimal;
  unvalued: UnvaluedRow[];
  /** Bales marked sold on orders that are not invoiced yet; included in finished goods. */
  soldNotInvoiced: { bales: number; cost: string };
}

async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

export async function factoryStockValuation(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<FactoryStockValuation> {
  const unvalued: UnvaluedRow[] = [];

  const raw = await rows<{ id: number; remaining: string; cost: string | null }>(
    executor,
    sql`
      SELECT id, (received_kg - used_kg)::text AS remaining, cost_per_kg_usd::text AS cost
        FROM factory_raw_stock
       WHERE company_id = ${companyId} AND deleted_at IS NULL AND received_kg - used_kg > 0
    `
  );
  let rawValue: Decimal = new MoneyDecimal(0);
  for (const row of raw) {
    if (row.cost === null) {
      unvalued.push({ source: "factory_raw_stock", id: row.id, reason: "no USD cost per kg" });
      continue;
    }
    rawValue = rawValue.plus(toMoney(row.remaining).times(toMoney(row.cost)));
  }

  const mixes = await rows<{ remaining: string; cost: string }>(
    executor,
    sql`
      SELECT (total_weight_kg - used_kg)::text AS remaining, cost_per_kg::text AS cost
        FROM factory_mix_batches
       WHERE company_id = ${companyId} AND deleted_at IS NULL AND status <> 'CLOSED'
         AND total_weight_kg - used_kg > 0
    `
  );
  let wipValue: Decimal = new MoneyDecimal(0);
  for (const row of mixes) wipValue = wipValue.plus(toMoney(row.remaining).times(toMoney(row.cost)));

  const bales = await rows<{ status: string; cost: string; zero_cost: number[] }>(
    executor,
    sql`
      SELECT status, COALESCE(SUM(total_cost), 0)::text AS cost,
             COALESCE(array_agg(id) FILTER (WHERE COALESCE(total_cost, 0) = 0), '{}') AS zero_cost
        FROM factory_bales
       WHERE company_id = ${companyId} AND deleted_at IS NULL
         AND status IN ('PENDING_PRESSING', 'IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
       GROUP BY status
    `
  );
  let finishedValue: Decimal = new MoneyDecimal(0);
  for (const row of bales) {
    if (row.status === "PENDING_PRESSING") wipValue = wipValue.plus(toMoney(row.cost));
    else finishedValue = finishedValue.plus(toMoney(row.cost));
    for (const id of row.zero_cost) unvalued.push({ source: "factory_bales", id, reason: "no recorded cost" });
  }

  const [sold] = await rows<{ count: number; cost: string }>(
    executor,
    sql`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(b.total_cost), 0)::text AS cost
        FROM factory_bales b
       WHERE b.company_id = ${companyId} AND b.deleted_at IS NULL AND b.status = 'SOLD'
         AND EXISTS (
           SELECT 1 FROM customer_order_bales cob
             JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = b.id AND co.company_id = ${companyId} AND co.deleted_at IS NULL
              AND co.status NOT IN ('FINALIZED', 'CANCELLED')
         )
    `
  );
  const soldCost = toMoney(sold?.cost ?? 0);
  finishedValue = finishedValue.plus(soldCost);

  return {
    raw: rawValue.toDecimalPlaces(2),
    wip: wipValue.toDecimalPlaces(2),
    finished: finishedValue.toDecimalPlaces(2),
    unvalued,
    soldNotInvoiced: { bales: sold?.count ?? 0, cost: soldCost.toFixed(2) },
  };
}

/**
 * The ERP stock items that mirror factory bales: pressing and stock entry add
 * each bale to an ERP location under a BALE item coded with its product. The
 * factory values those bales itself (finished goods), so ERP inventory leaves
 * these items out.
 */
export async function factoryBaleMirrorStockItemIds(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<Set<number>> {
  const result = await rows<{ id: number }>(
    executor,
    sql`
      SELECT si.id FROM stock_items si
       WHERE si.company_id = ${companyId} AND UPPER(COALESCE(si.uom, '')) = 'BALE'
         AND EXISTS (
           SELECT 1 FROM factory_bale_products p
            WHERE p.company_id = ${companyId} AND si.code IN (p.code, p.article_code)
         )
    `
  );
  return new Set(result.map((row) => row.id));
}
