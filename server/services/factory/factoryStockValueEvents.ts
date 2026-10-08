/**
 * Factory stock value changes tagged by source (accounting audit wave 11).
 *
 * The daily factory stock journal (GL-FACTORY-STOCK) moves the factory stock
 * accounts to the costing value and used to put every unexplained difference
 * in Production Variance. Writers whose value change has a known cause now
 * record it here, and the journal posts each kind to its own account:
 *
 *   WASTE           bales written off, removed or deleted from stock (and
 *                   restored), at their cost          → FACTORY_WASTE_WRITE_OFF
 *   REVALUATION     container cost recalculations and cost cascades: the
 *                   change of the whole factory valuation they caused
 *                                                     → FACTORY_REVALUATION
 *   MATERIAL_PRICE  a mix priced at the supplier's moving average against the
 *                   container's own landed cost       → FACTORY_MATERIAL_PRICE_VARIANCE
 *
 * Production Variance keeps only the remainder (mixing and pressing yields,
 * anything not tagged). The reviewed bale re-cost posts its own journal to
 * Factory Stock Revaluation, so it records nothing here.
 *
 * `amount` is the signed change of the factory stock value in USD (a
 * write-off is negative). Events are recorded only while the company's
 * cut-over applies to today, since the journal exists only then; each journal
 * claims the events not yet claimed by an earlier day's journal.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { isPerpetualInventoryActive } from "../accounting/perpetualInventory/cutover";
import { factoryStockValuation } from "../accounting/perpetualInventory/factoryValuation";

export const FACTORY_STOCK_EVENT_KINDS = ["WASTE", "REVALUATION", "MATERIAL_PRICE"] as const;
export type FactoryStockEventKind = (typeof FACTORY_STOCK_EVENT_KINDS)[number];

/** The registry account each kind posts to. */
export const FACTORY_STOCK_EVENT_ACCOUNT: Record<FactoryStockEventKind, string> = {
  WASTE: "FACTORY_WASTE_WRITE_OFF",
  REVALUATION: "FACTORY_REVALUATION",
  MATERIAL_PRICE: "FACTORY_MATERIAL_PRICE_VARIANCE",
};

/** The journal's dates are UTC days (factoryStockJournal.todayUtc). */
const todayUtc = () => new Date().toISOString().slice(0, 10);

export interface FactoryStockEventSource {
  sourceType: string;
  sourceId?: string | number | null;
}

/** Whether value events are recorded for the company today. */
export async function factoryStockEventsActive(tx: DbTransaction, companyId: number): Promise<boolean> {
  return isPerpetualInventoryActive(tx, companyId, todayUtc());
}

/** Records one value change; a no-op before the cut-over and for a zero amount. */
export async function recordFactoryStockValueEventTx(
  tx: DbTransaction,
  params: { companyId: number; kind: FactoryStockEventKind; amount: Decimal } & FactoryStockEventSource
): Promise<void> {
  const amount = params.amount.toDecimalPlaces(7);
  if (amount.isZero()) return;
  if (!(await factoryStockEventsActive(tx, params.companyId))) return;
  await tx.execute(sql`
    INSERT INTO factory_stock_value_events (company_id, event_date, kind, amount, source_type, source_id)
    VALUES (${params.companyId}, ${todayUtc()}::date, ${params.kind}, ${amount.toFixed(7)}, ${params.sourceType},
            ${params.sourceId == null ? null : String(params.sourceId)})
  `);
}

const valuationTotal = async (tx: DbTransaction, companyId: number) => {
  const valuation = await factoryStockValuation(tx, companyId);
  return valuation.raw.plus(valuation.wip).plus(valuation.finished);
};

/**
 * Runs `work` and records the change it made to the whole factory valuation
 * as one event of `kind` (cost recalculations rewrite raw, mix and bale costs
 * together, so the valuation before and after is the exact change). Before
 * the cut-over it only runs `work`.
 */
export async function withFactoryValuationEventTx<T>(
  tx: DbTransaction,
  companyId: number,
  kind: FactoryStockEventKind,
  source: FactoryStockEventSource,
  work: () => Promise<T>
): Promise<T> {
  if (!(await factoryStockEventsActive(tx, companyId))) return work();
  const before = await valuationTotal(tx, companyId);
  const result = await work();
  const after = await valuationTotal(tx, companyId);
  await recordFactoryStockValueEventTx(tx, { companyId, kind, amount: after.minus(before), ...source });
  return result;
}

/**
 * The cost of bales that are factory stock (valued by factoryStockValuation)
 * among `baleIds`, read before they leave it.
 */
export async function valuedBalesCostTx(
  tx: DbTransaction,
  companyId: number,
  baleIds: readonly number[]
): Promise<Decimal> {
  if (baleIds.length === 0) return new MoneyDecimal(0);
  const ids = `{${baleIds.map((id) => Math.trunc(Number(id))).join(",")}}`;
  const result = await tx.execute(sql`
    SELECT COALESCE(SUM(total_cost), 0)::text AS cost FROM factory_bales
     WHERE company_id = ${companyId} AND deleted_at IS NULL AND id = ANY(${ids}::int[])
       AND status IN ('PENDING_PRESSING', 'IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
  `);
  return toMoney((result.rows[0] as { cost: string } | undefined)?.cost ?? 0);
}

/**
 * Claims the company's unclaimed events (and those an earlier run of the same
 * day's journal claimed) for the journal of `date`, and returns their totals
 * by kind.
 */
export async function claimFactoryStockEventsTx(
  tx: DbTransaction,
  companyId: number,
  date: string
): Promise<Map<FactoryStockEventKind, Decimal>> {
  const result = await tx.execute(sql`
    UPDATE factory_stock_value_events SET journal_date = ${date}::date
     WHERE company_id = ${companyId} AND (journal_date IS NULL OR journal_date = ${date}::date)
       AND event_date <= ${date}::date
    RETURNING kind, amount::text AS amount
  `);
  const totals = new Map<FactoryStockEventKind, Decimal>();
  for (const row of result.rows as Array<{ kind: FactoryStockEventKind; amount: string }>) {
    if (!FACTORY_STOCK_EVENT_KINDS.includes(row.kind)) continue;
    totals.set(row.kind, (totals.get(row.kind) ?? new MoneyDecimal(0)).plus(toMoney(row.amount)));
  }
  return totals;
}
