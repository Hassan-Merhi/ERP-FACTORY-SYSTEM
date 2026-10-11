/**
 * The factory checks of the perpetual-inventory cut-over (wave 17 B, owner
 * decisions 2 and 6).
 *
 * The opening journal values the factory with its costing as it stands
 * (factoryStockValuation). The apply is refused (409 FACTORY_READINESS_BLOCKERS,
 * with the counts) and the readiness report lists the same figures while, for
 * the company:
 *
 *   - raw-stock rows or bales carry no USD cost (the opening would leave them
 *     out of the factory accounts);
 *   - open mixes are recorded without a USD rate (a source had no USD rate
 *     when it was mixed: cost 0);
 *   - stock bales from a stock entry with no mix are costed at the catalogue
 *     production price (decision 2: bales must come from a costed mix; the
 *     garbage HMD16 articles cost nothing by rule and are not counted);
 *   - legacy factory foreign-currency lines the wave 6 repair has not
 *     converted remain (the count is the repair plan's, read-only:
 *     planFactoryFxLegacyRepair).
 *
 * Phase 28 (F4, F6): a no-mix bale whose cost an Owner accepted with a
 * sign-off (noMixBaleResolution.ts) is no longer counted while it keeps the
 * accepted cost; spreadsheet-imported bales are re-costed: one from a mix
 * whose cost is not weight × the mix's cost per kg blocks until the reviewed
 * re-cost brings it there (IMPORTED_BALES_NOT_RECOSTED), one with no mix is a
 * no-mix bale (resolved by the same tool).
 *
 * Read-only.
 */
import { sql, type SQL } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../../db";
import { toMoney } from "../../../lib/money";
import { planFactoryFxLegacyRepair } from "../../factory/factoryFxLegacyRepair";
import { factoryStockValuation, type FactoryStockValuation } from "./factoryValuation";

export interface NoMixCataloguePricedBales {
  count: number;
  /** Their recorded (catalogue-price) cost, 2dp text. */
  cost: string;
  baleIds: number[];
}

export interface FactoryCutoverBlockers {
  unvaluedRawStock: number;
  unvaluedBales: number;
  openMixesWithoutUsdRate: number;
  noMixBales: NoMixCataloguePricedBales;
  /** Phase 28 (F6): imported stock bales from a mix not yet re-costed from it. */
  importedNotRecosted: NoMixCataloguePricedBales;
  legacyFxLines: number;
}

/**
 * Phase 28 (F4): the bale (alias `table`) has an accepted cost, signed off by
 * an Owner, and still carries it.
 */
export const ACCEPTED_BALE_COST_SQL = (companyId: number, table: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM factory_bale_cost_resolutions r
   WHERE r.company_id = ${companyId} AND r.bale_id = ${table}.id AND r.action = 'ACCEPT'
     AND r.new_total_cost = ${table}.total_cost
)`;

const STOCK_BALE_SQL = (companyId: number): SQL => sql`
  b.company_id = ${companyId} AND b.deleted_at IS NULL
  AND b.status IN ('PENDING_PRESSING', 'IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
  AND NOT (b.status = 'IN_STOCK' AND EXISTS (
    SELECT 1 FROM customer_order_bales cob
      JOIN customer_orders co ON co.id = cob.order_id
     WHERE cob.bale_id = b.id AND co.company_id = ${companyId} AND co.deleted_at IS NULL
       AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD', 'INVOICED', 'COMPLETED')
  ))`;

/**
 * Phase 28 (F6): stock bales of a spreadsheet import batch that come from a
 * mix whose cost per kg they do not carry (to the cent of their total): the
 * reviewed re-cost values them from the mix.
 */
export async function importedBalesNotRecosted(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<NoMixCataloguePricedBales> {
  const result = await executor.execute(sql`
    SELECT COUNT(*)::int AS count, COALESCE(SUM(b.total_cost), 0)::text AS cost,
           COALESCE(array_agg(b.id ORDER BY b.id), '{}') AS ids
      FROM factory_bales b
      JOIN factory_mix_batches m ON m.id = b.mix_batch_id AND m.company_id = ${companyId}
     WHERE ${STOCK_BALE_SQL(companyId)} AND b.import_batch_id IS NOT NULL
       AND ROUND(b.total_cost, 2) <> ROUND(b.weight_kg * m.cost_per_kg, 2)
  `);
  const row = result.rows[0] as { count: number; cost: string; ids: number[] } | undefined;
  return {
    count: row?.count ?? 0,
    cost: toMoney(row?.cost ?? 0).toFixed(2),
    baleIds: (row?.ids ?? []).map(Number),
  };
}

/**
 * Stock bales (the statuses factoryStockValuation values, not on an invoiced
 * order) with no mix and a cost: costed at the catalogue production price by a
 * stock entry with no mix (baleCostBasis.stockEntryBaleCost). Bales with no
 * cost are already listed as unvalued. Bales of a spreadsheet import batch
 * (bale import and reimport) carry the spreadsheet's cost, not the catalogue
 * price; with no mix they are counted here too (phase 28 F6: imported bales
 * are re-costed; the no-mix resolution tool assigns, writes off or accepts
 * them). A bale whose cost an Owner accepted is left out (F4).
 */
export async function noMixCataloguePricedBales(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<NoMixCataloguePricedBales> {
  const result = await executor.execute(sql`
    SELECT COUNT(*)::int AS count, COALESCE(SUM(b.total_cost), 0)::text AS cost,
           COALESCE(array_agg(b.id ORDER BY b.id), '{}') AS ids
      FROM factory_bales b
     WHERE ${STOCK_BALE_SQL(companyId)} AND b.mix_batch_id IS NULL
       AND COALESCE(b.total_cost, 0) > 0 AND COALESCE(b.article_code, '') NOT LIKE 'HMD16%'
       AND NOT ${ACCEPTED_BALE_COST_SQL(companyId, sql`b`)}
  `);
  const row = result.rows[0] as { count: number; cost: string; ids: number[] } | undefined;
  return {
    count: row?.count ?? 0,
    cost: toMoney(row?.cost ?? 0).toFixed(2),
    baleIds: (row?.ids ?? []).map(Number),
  };
}

/** The factory blockers of the cut-over (see the module comment). */
export async function factoryCutoverBlockers(
  executor: DatabaseOrTransaction,
  companyId: number,
  valuation?: FactoryStockValuation
): Promise<FactoryCutoverBlockers> {
  const factory = valuation ?? (await factoryStockValuation(executor, companyId));
  const bySource = (source: string) => factory.unvalued.filter((row) => row.source === source).length;
  const fx = await planFactoryFxLegacyRepair(companyId, executor);
  return {
    unvaluedRawStock: bySource("factory_raw_stock") + bySource("factory_raw_material_adjustments"),
    unvaluedBales: bySource("factory_bales"),
    openMixesWithoutUsdRate: bySource("factory_mix_batches"),
    noMixBales: await noMixCataloguePricedBales(executor, companyId),
    importedNotRecosted: await importedBalesNotRecosted(executor, companyId),
    legacyFxLines: fx.legacyLines,
  };
}

/** The apply's refusal message for the blockers, or null when there are none. */
export function factoryCutoverBlockerMessage(blockers: FactoryCutoverBlockers): string | null {
  const found = [
    [blockers.unvaluedRawStock, "raw-stock rows with no USD cost"],
    [blockers.unvaluedBales, "bales with no recorded cost"],
    [blockers.openMixesWithoutUsdRate, "open mixes without a USD rate"],
    [blockers.noMixBales.count, `bales with no mix costed at the catalogue price (${blockers.noMixBales.cost})`],
    [blockers.importedNotRecosted.count, "imported bales not re-costed from their mix (bale re-cost)"],
    [blockers.legacyFxLines, "legacy factory foreign-currency lines not repaired (wave 6 repair)"],
  ] as const;
  const present = found.filter(([count]) => count > 0);
  if (present.length === 0) return null;
  return `The factory is not ready for the cut-over: ${present
    .map(([count, label]) => `${count} ${label}`)
    .join(", ")}; resolve them first (see the perpetual-inventory readiness report)`;
}
