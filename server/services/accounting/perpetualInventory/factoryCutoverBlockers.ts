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
 * Read-only.
 */
import { sql } from "drizzle-orm";

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
  legacyFxLines: number;
}

/**
 * Stock bales (the statuses factoryStockValuation values, not on an invoiced
 * order) with no mix and a cost: costed at the catalogue production price by a
 * stock entry with no mix (baleCostBasis.stockEntryBaleCost). Bales with no
 * cost are already listed as unvalued.
 */
export async function noMixCataloguePricedBales(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<NoMixCataloguePricedBales> {
  const result = await executor.execute(sql`
    SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cost), 0)::text AS cost,
           COALESCE(array_agg(id ORDER BY id), '{}') AS ids
      FROM factory_bales
     WHERE company_id = ${companyId} AND deleted_at IS NULL AND mix_batch_id IS NULL
       AND COALESCE(total_cost, 0) > 0 AND COALESCE(article_code, '') NOT LIKE 'HMD16%'
       AND status IN ('PENDING_PRESSING', 'IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
       AND NOT (status = 'IN_STOCK' AND EXISTS (
         SELECT 1 FROM customer_order_bales cob
           JOIN customer_orders co ON co.id = cob.order_id
          WHERE cob.bale_id = factory_bales.id AND co.company_id = ${companyId} AND co.deleted_at IS NULL
            AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD', 'INVOICED', 'COMPLETED')
       ))
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
    unvaluedRawStock: bySource("factory_raw_stock"),
    unvaluedBales: bySource("factory_bales"),
    openMixesWithoutUsdRate: bySource("factory_mix_batches"),
    noMixBales: await noMixCataloguePricedBales(executor, companyId),
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
    [blockers.legacyFxLines, "legacy factory foreign-currency lines not repaired (wave 6 repair)"],
  ] as const;
  const present = found.filter(([count]) => count > 0);
  if (present.length === 0) return null;
  return `The factory is not ready for the cut-over: ${present
    .map(([count, label]) => `${count} ${label}`)
    .join(", ")}; resolve them first (see the perpetual-inventory readiness report)`;
}
