/**
 * Factory Net Position historical inventory, read only.
 *
 * Never reverse a mutable "current remaining" figure to fabricate an old day.
 * Receipts, supplier-owned mix sources, and adjustment events are replayed
 * independently through the company's end-of-day cutoff. Historic finished
 * stock uses bale origin/cost and real order scan/finalization timestamps.
 *
 * Old rows without reliable event/cost history produce named warnings. They
 * are intentionally NOT upgraded to an "exact" historical snapshot.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { getFactoryBalanceOnTableSnapshot } from "./productionBalanceOnTable";
import { netPositionLegacyScanKnown, netPositionRecordedThrough } from "./netPositionAsOf";
import { loadFactoryRowsKnownAt } from "./netPositionRowHistoryReader";
import {
  ZERO,
  cents,
  money,
  nextCutoff,
  rawMaterialAt,
  type HistoricalInventorySnapshot,
} from "./replayHistoricalRawEvents";
export { replayHistoricalRawEvents, valueHistoricalRawStates } from "./replayHistoricalRawEvents";
export type { HistoricalInventorySnapshot } from "./replayHistoricalRawEvents";

/**
 * Today's Stock In Hand (netPositionInventory.ts) is every IN_STOCK bale not
 * linked to an open or completed order, valued at its catalogue production
 * (or selling) price. The dated equivalent:
 *
 * - A bale row not updated since the cutoff still has the status it had that
 *   day (every bale status change writes updated_at), so today's rule applies
 *   to it directly.
 * - Otherwise its state that day is rebuilt from dated events: it entered
 *   stock when finalized (pressing finalize / stock entry set finalized_at),
 *   and left it through a scan recorded by the cutoff on an order not yet
 *   deleted or cancelled, a waste dispatch recorded by then, or deletion.
 *   Repack/removal/sale without a dated event cannot be timed; such a bale
 *   counts as still in stock and the gap is reported.
 */
async function finishedStockAt(companyId: number, scope: FactoryNetPositionAsOf, valuationMode: "cost" | "selling") {
  const orderLiveThen = sql`${nextCutoff(scope, "co.created_at")}
                  AND (co.deleted_at IS NULL OR NOT ${nextCutoff(scope, "co.deleted_at")})
                  AND NOT (co.status = 'CANCELLED' AND (${nextCutoff(scope, "co.updated_at")}
                    OR EXISTS (SELECT 1 FROM factory_daybook_entries d
                                WHERE d.company_id = co.company_id AND d.tx_type = 'ORDER_CANCELLED'
                                  AND d.reference_id = co.id AND ${nextCutoff(scope, "d.created_at")})))`;
  const rows = resultRows<{
    total_cost: string;
    total_selling: string;
    legacy_entry: string;
    missing_scan_time: string;
    uncertain_removals: string;
    priced: string;
    product_counts: Array<{ id: number | null; qty: number | string }> | null;
  }>(
    await db.execute(sql`
    WITH allocated AS MATERIALIZED (
      -- Each rule is computed once as a set of bale ids and joined below: as
      -- per-bale EXISTS probes inside one OR the planner ran every probe for
      -- every bale (and the history table has no bale_id index).
      SELECT cob.bale_id FROM customer_order_bales cob
        JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
       WHERE cob.scanned_at IS NOT NULL
         AND ${netPositionRecordedThrough(sql`cob.scanned_at`, scope, "timestamptz")}
         AND ${orderLiveThen}
         AND NOT EXISTS (
            -- A restored row may reuse the original scanned_at.
            -- If cancelled before cutoff but restoration was undated,
            -- it cannot be treated as a known allocation.
            SELECT 1 FROM customer_order_bales_history prior
             WHERE prior.order_id = cob.order_id
               AND prior.bale_id = cob.bale_id
               AND ${netPositionRecordedThrough(sql`prior.cancelled_at`, scope, "timestamptz")}
         )
      UNION
      -- A scan cancelled after the selected day was still allocated
      -- on the selected day; archived history retains that interval.
      SELECT coh.bale_id FROM customer_order_bales_history coh
        JOIN customer_orders co ON co.id = coh.order_id AND co.company_id = ${companyId}
       WHERE coh.scanned_at IS NOT NULL
         AND ${netPositionRecordedThrough(sql`coh.scanned_at`, scope, "timestamptz")}
         AND NOT ${netPositionRecordedThrough(sql`coh.cancelled_at`, scope, "timestamptz")}
         AND ${orderLiveThen}
      UNION
      SELECT cob.bale_id FROM customer_order_bales cob
        JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
       WHERE ${netPositionLegacyScanKnown("cob", "co", companyId, scope)}
         AND ${orderLiveThen}
      UNION
      -- Legacy scan without a time: allocated then only when its
      -- order row (whose totals every scan rewrites) is itself
      -- unchanged since the cutoff and in today's allocating statuses.
      SELECT cob.bale_id FROM customer_order_bales cob
        JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
       WHERE cob.scanned_at IS NULL
         AND ${nextCutoff(scope, "co.updated_at")}
         AND co.deleted_at IS NULL
         AND co.status IN ('LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED','DISPATCHED','SOLD')
    ), missing_scan AS MATERIALIZED (
      SELECT cob.bale_id FROM customer_order_bales cob
        JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
       WHERE cob.scanned_at IS NULL
      UNION
      SELECT coh.bale_id FROM customer_order_bales_history coh
        JOIN customer_orders co ON co.id = coh.order_id AND co.company_id = ${companyId}
       WHERE coh.scanned_at IS NULL
         AND NOT ${netPositionRecordedThrough(sql`coh.cancelled_at`, scope, "timestamptz")}
    ), candidate AS MATERIALIZED (
      SELECT b.id, b.product_id, b.status,
             COALESCE(p.production_price::numeric, 0) AS catalog_cost,
             COALESCE(p.selling_price::numeric, 0) AS catalog_selling,
             ${nextCutoff(scope, "b.updated_at")} AS unchanged,
             b.finalized_at IS NULL AS legacy_entry,
             (b.finalized_at IS NOT NULL AND ${nextCutoff(scope, "b.finalized_at")}) AS finalized_before,
             (allocated.bale_id IS NOT NULL) AS allocated_then,
             (b.waste_dispatch_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM factory_bale_waste_dispatches wd
                 WHERE wd.id = b.waste_dispatch_id
                   AND wd.dispatch_date <= ${scope.asOf}::date
                   AND ${nextCutoff(scope, "wd.created_at")}
             )) AS dispatched_then,
             (missing_scan.bale_id IS NOT NULL) AS missing_scan_time
        FROM factory_bales b
        LEFT JOIN factory_bale_products p ON p.id = b.product_id AND p.company_id = ${companyId}
        LEFT JOIN allocated ON allocated.bale_id = b.id
        LEFT JOIN missing_scan ON missing_scan.bale_id = b.id
       WHERE b.company_id = ${companyId}
         AND ${nextCutoff(scope, "b.created_at")}
         AND COALESCE(b.stock_entry_date, b.finalized_at::date, b.pressed_at::date, b.created_at::date) <= ${scope.asOf}::date
         AND (b.deleted_at IS NULL OR NOT ${nextCutoff(scope, "b.deleted_at")})
    ), in_stock AS (
      SELECT c.*,
             CASE
               WHEN c.unchanged THEN c.status = 'IN_STOCK' AND NOT c.allocated_then
               ELSE (c.finalized_before
                       OR (c.legacy_entry AND c.status NOT IN ('PENDING_PRESSING','LABEL_PRINTED','PRESSED','RESERVED')))
                    AND c.status NOT IN ('PENDING_PRESSING','LABEL_PRINTED','PRESSED','RESERVED')
                    AND NOT c.allocated_then
                    AND NOT c.dispatched_then
             END AS counted,
             (NOT c.unchanged AND c.status IN ('REPACKED','REMOVED','DELETED','SOLD','DISPATCHED')
               AND NOT c.allocated_then AND NOT c.dispatched_then) AS untimed_exit
        FROM candidate c
    )
    SELECT COALESCE(SUM(catalog_cost) FILTER (WHERE counted), 0)::text AS total_cost,
           COALESCE(SUM(catalog_selling) FILTER (WHERE counted), 0)::text AS total_selling,
           COUNT(*) FILTER (WHERE counted AND NOT unchanged AND legacy_entry)::text AS legacy_entry,
           COUNT(*) FILTER (WHERE missing_scan_time)::text AS missing_scan_time,
           COUNT(*) FILTER (WHERE counted AND untimed_exit)::text AS uncertain_removals,
           COUNT(*) FILTER (WHERE counted AND (catalog_cost > 0 OR catalog_selling > 0))::text AS priced,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', grp.product_id, 'qty', grp.qty)), '[]'::jsonb)
              FROM (SELECT product_id, COUNT(*)::integer AS qty FROM in_stock
                     WHERE counted GROUP BY product_id) grp) AS product_counts
      FROM in_stock
  `)
  );
  const row = rows[0] ?? {};
  const warnings: string[] = [];
  if (Number(row.legacy_entry || 0) > 0) warnings.push("HISTORICAL_STOCK_FINALIZATION_TIME_MISSING");
  if (Number(row.missing_scan_time || 0) > 0) warnings.push("HISTORICAL_STOCK_SCAN_TIME_MISSING");
  if (Number(row.uncertain_removals || 0) > 0) warnings.push("HISTORICAL_STOCK_REMOVAL_TIME_UNKNOWN");
  const productCounts = row.product_counts ?? [];
  if (!Array.isArray(productCounts)) throw new Error("HISTORICAL_STOCK_PRODUCT_GROUPS_INVALID");
  const productIds = productCounts.filter((item) => item.id != null).map((item) => Number(item.id));
  const productHistory = productIds.length
    ? await loadFactoryRowsKnownAt("factory_bale_products", companyId, scope, productIds)
    : null;
  let stockValue = cents(money(valuationMode === "selling" ? row.total_selling : row.total_cost));
  if (productHistory?.ready) {
    let historicalTotal: Decimal = ZERO;
    for (const group of productCounts) {
      if (group.id == null) continue; // As in today's LEFT JOIN, an unassigned product is zero-valued.
      const amount = Number(group.qty);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("HISTORICAL_STOCK_QUANTITY_INVALID");
      const product = productHistory.rows.get(Number(group.id));
      if (!product) throw new Error("HISTORICAL_STOCK_PRODUCT_HISTORY_MISSING");
      const rawPrice = valuationMode === "selling" ? product.selling_price : product.production_price;
      historicalTotal = historicalTotal.plus(money(rawPrice as string | number | null | undefined).times(amount));
    }
    stockValue = cents(historicalTotal);
  } else if (Number(row.priced || 0) > 0) {
    // A row's price was never recorded before the atomic history baseline.
    warnings.push(
      valuationMode === "selling"
        ? "HISTORICAL_STOCK_SELLING_PRICE_UNVERSIONED"
        : "HISTORICAL_STOCK_COST_EDITS_NOT_VERSIONED"
    );
  }
  return { value: stockValue, warnings };
}

export async function computeHistoricalFactoryInventory(
  companyId: number,
  scope: FactoryNetPositionAsOf,
  valuationMode: "cost" | "selling"
): Promise<HistoricalInventorySnapshot> {
  const [raw, stock, workInProcess] = await Promise.all([
    rawMaterialAt(companyId, scope),
    finishedStockAt(companyId, scope, valuationMode),
    getFactoryBalanceOnTableSnapshot(companyId, scope.asOf, scope),
  ]);
  return {
    inventoryValue: stock.value,
    rawMaterialValue: raw.value,
    balanceOnTableValue: workInProcess.value,
    // The cumulative WIP snapshot uses surviving bale status/weight records.
    // Historic removal/repack timestamps are not complete for legacy bales.
    warnings: [...new Set([...raw.warnings, ...stock.warnings, "HISTORICAL_WIP_BALE_LIFECYCLE_UNVERSIONED"])],
  };
}
