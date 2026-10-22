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
import { MoneyDecimal, toMoney } from "../../lib/money";
import { getFactoryBalanceOnTableSnapshot } from "./productionBalanceOnTable";
import { netPositionLegacyScanKnown, netPositionRecordedThrough } from "./netPositionAsOf";
import { getLockedSupplierRatesReadOnlyBulk } from "./rawStockLockedRateBulk";
import { sqlArray } from "../../lib/sqlArray";

type Event = {
  key: string;
  kind: "RECEIPT" | "ADD" | "DEDUCT" | "CONSUME";
  day: string;
  recordedAt: string;
  stableId: number;
  kg: string;
  usdRate: string | null;
  basis?: string | null;
};
type Stock = { kg: Decimal; value: Decimal; events: number };
const ZERO = new MoneyDecimal(0);
const money = (value: unknown): Decimal => toMoney(value as string | number | null | undefined);
const cents = (value: Decimal): number => value.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();

const nextCutoff = (scope: FactoryNetPositionAsOf, column: string) =>
  netPositionRecordedThrough(sql.raw(column), scope, "utc-naive-timestamp");

export interface HistoricalInventorySnapshot {
  inventoryValue: number;
  rawMaterialValue: number;
  balanceOnTableValue: number;
  warnings: string[];
}

/** Pure date-ordered, deterministic supplier stock replay. Exported for focused tests. */
export function replayHistoricalRawEvents(events: readonly Event[]): {
  value: number;
  warnings: string[];
  states: Map<string, { kg: Decimal; value: Decimal }>;
} {
  const states = new Map<string, Stock>();
  const warnings = new Set<string>();
  const sorted = [...events].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      a.recordedAt.localeCompare(b.recordedAt) ||
      a.stableId - b.stableId ||
      a.kind.localeCompare(b.kind)
  );

  for (const event of sorted) {
    const state = states.get(event.key) ?? { kg: ZERO, value: ZERO, events: 0 };
    const kg = money(event.kg);
    if (kg.lt(0)) {
      warnings.add("HISTORICAL_RAW_NEGATIVE_MOVEMENT");
      continue;
    }
    const price = event.usdRate == null ? null : money(event.usdRate);
    if (event.kind === "RECEIPT") {
      if (!price || price.lte(0)) warnings.add("HISTORICAL_RAW_UNPRICED_RECEIPT");
      state.value = state.value.plus(kg.times(price ?? ZERO));
      state.kg = state.kg.plus(kg);
    } else if (event.kind === "ADD") {
      if (event.basis == null && price?.gt(0)) warnings.add("HISTORICAL_RAW_ADJUSTMENT_BASIS_MISSING");
      const effectivePrice =
        event.basis === "QUANTITY_ONLY"
          ? state.kg.gt(0)
            ? state.value.div(state.kg)
            : ZERO
          : (price ?? (state.kg.gt(0) ? state.value.div(state.kg) : ZERO));
      state.kg = state.kg.plus(kg);
      state.value = state.value.plus(kg.times(effectivePrice));
    } else {
      if (kg.gt(state.kg.plus("0.001"))) {
        warnings.add("HISTORICAL_RAW_CONSUMPTION_EXCEEDS_RECEIPTS");
      }
      const used = MoneyDecimal.min(kg, MoneyDecimal.max(state.kg, ZERO));
      const rate = state.kg.gt(0) ? state.value.div(state.kg) : ZERO;
      state.kg = MoneyDecimal.max(state.kg.minus(used), ZERO);
      state.value = MoneyDecimal.max(state.value.minus(used.times(rate)), ZERO);
    }
    state.events += 1;
    states.set(event.key, state);
  }
  // Match the raw-stock listing's per supplier/material-cent rounding.
  let total: Decimal = ZERO;
  for (const state of states.values()) total = total.plus(money(cents(state.value)));
  return { value: cents(total), warnings: [...warnings], states };
}

/**
 * Today's Raw Material value is each supplier's remaining kg at its current
 * locked rate (netPositionInventory.ts), with suppliers that have no locked
 * rate and unassigned containers at their remaining cost. The locked rate
 * moves only when a receipt is offloaded, so it is the rate on the selected
 * day whenever the supplier has no receipt recorded after the cutoff; then
 * the replayed kg is valued exactly as today. Otherwise the replay's moving
 * average (the same formula the locked rate follows) stands in, flagged.
 */
export function valueHistoricalRawStates(
  states: ReadonlyMap<string, { kg: Decimal; value: Decimal }>,
  lockedRates: ReadonlyMap<number, number>,
  suppliersReceivedLater: ReadonlySet<number>
): { value: number; rateUnversioned: boolean } {
  let total: Decimal = ZERO;
  let rateUnversioned = false;
  for (const [key, state] of states) {
    const supplierId = key.startsWith("s") ? Number(key.slice(1)) : null;
    const rate = supplierId != null ? lockedRates.get(supplierId) : undefined;
    let rowValue = state.value;
    if (supplierId != null && rate != null) {
      if (suppliersReceivedLater.has(supplierId)) rateUnversioned = true;
      else rowValue = money(state.kg.toFixed(3)).times(money(rate));
    }
    total = total.plus(rowValue.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP));
  }
  return { value: cents(total), rateUnversioned };
}

/**
 * Record-time and business-time filters apply to every individual receipt,
 * ADD/DEDUCT, and mix source. The cumulative factory_raw_stock.used_kg and
 * supplier.current_raw_material_cost_per_kg_usd MUST NOT appear here.
 */
async function rawMaterialAt(companyId: number, scope: FactoryNetPositionAsOf) {
  const receipts = resultRows<{
    key: string;
    day: string;
    recorded_at: string;
    stable_id: number;
    kg: string;
    usd_rate: string | null;
    fallback: boolean;
  }>(
    await db.execute(sql`
    WITH candidate AS (
      SELECT COALESCE('s' || fc.supplier_id::text, 'u' || fc.id::text) AS key,
             cr.receipt_date::text AS day,
             cr.created_at::text AS recorded_at, cr.id AS stable_id,
             cr.received_kg::text AS kg,
             COALESCE(NULLIF(cr.fixed_cost_per_kg_usd, 0),
                      CASE WHEN UPPER(COALESCE(fc.currency_code,'USD')) = 'USD'
                           THEN cr.fixed_cost_per_kg ELSE NULL END)::text AS usd_rate,
             false AS fallback
        FROM factory_container_receipts cr
        JOIN factory_containers fc ON fc.id = cr.container_id AND fc.company_id = cr.company_id
       WHERE cr.company_id = ${companyId}
         AND cr.receipt_date <= ${scope.asOf}::date
         AND ${nextCutoff(scope, "cr.created_at")}
         AND (cr.deleted_at IS NULL OR NOT ${nextCutoff(scope, "cr.deleted_at")})
         AND ${nextCutoff(scope, "fc.created_at")}
         AND (fc.deleted_at IS NULL OR NOT ${nextCutoff(scope, "fc.deleted_at")})
      UNION ALL
      SELECT COALESCE('s' || fc.supplier_id::text, 'u' || fc.id::text) AS key,
             rs.offloaded_at::date::text, rs.created_at::text, -rs.id,
             rs.received_kg::text,
             COALESCE(NULLIF(rs.cost_per_kg_usd, 0),
                      CASE WHEN UPPER(COALESCE(fc.currency_code,'USD')) = 'USD'
                           THEN rs.cost_per_kg ELSE NULL END)::text,
             true
        FROM factory_raw_stock rs
        JOIN factory_containers fc ON fc.id = rs.container_id AND fc.company_id = rs.company_id
       WHERE rs.company_id = ${companyId}
         AND rs.offloaded_at::date <= ${scope.asOf}::date
         AND ${nextCutoff(scope, "rs.created_at")}
         AND ${nextCutoff(scope, "fc.created_at")}
         AND (rs.deleted_at IS NULL OR NOT ${nextCutoff(scope, "rs.deleted_at")})
         AND (fc.deleted_at IS NULL OR NOT ${nextCutoff(scope, "fc.deleted_at")})
         AND NOT EXISTS (
           SELECT 1 FROM factory_container_receipts all_receipts
            WHERE all_receipts.company_id = rs.company_id
              AND all_receipts.container_id = rs.container_id
         )
    )
    SELECT * FROM candidate ORDER BY day, recorded_at, stable_id
  `)
  );
  const adjustments = resultRows<{
    key: string;
    day: string;
    recorded_at: string;
    stable_id: number;
    kg: string;
    usd_rate: string | null;
    type: string;
    basis: string | null;
  }>(
    await db.execute(sql`
    SELECT COALESCE('s' || a.supplier_id::text, 'm' || COALESCE(a.material_label,'unknown')) AS key,
           LEFT(a.date, 10) AS day, a.created_at::text AS recorded_at, a.id AS stable_id,
           a.kg::text AS kg,
           CASE WHEN UPPER(COALESCE(a.currency_code,'USD')) = 'USD'
                THEN a.cost_per_kg::text ELSE NULL END AS usd_rate,
           UPPER(a.type) AS type, a.valuation_basis AS basis
      FROM factory_raw_material_adjustments a
     WHERE a.company_id = ${companyId}
       AND LEFT(a.date, 10) <= ${scope.asOf}
       AND ${nextCutoff(scope, "a.created_at")}
       AND (a.deleted_at IS NULL OR NOT ${nextCutoff(scope, "a.deleted_at")})
  `)
  );
  const sources = resultRows<{
    key: string | null;
    day: string;
    recorded_at: string;
    stable_id: number;
    kg: string;
  }>(
    await db.execute(sql`
    SELECT CASE WHEN COALESCE(ms.inventory_supplier_id, ms.supplier_id, fc.supplier_id) IS NOT NULL
                THEN 's' || COALESCE(ms.inventory_supplier_id, ms.supplier_id, fc.supplier_id)::text
                WHEN ms.container_id IS NOT NULL THEN 'u' || ms.container_id::text
                ELSE NULL END AS key,
           -- Never earlier than the source row was recorded: a top-up added
           -- later to an older batch consumes stock from when it was entered.
           GREATEST(COALESCE(mb.batch_date, mb.created_at::date), ms.created_at::date)::text AS day,
           GREATEST(ms.created_at, mb.created_at)::text AS recorded_at,
           ms.id AS stable_id, ms.weight_kg::text AS kg
      FROM factory_mix_batch_sources ms
      JOIN factory_mix_batches mb ON mb.id = ms.mix_batch_id
       AND mb.company_id = ${companyId}
      LEFT JOIN factory_containers fc ON fc.id = ms.container_id AND fc.company_id = ${companyId}
     WHERE ms.source_batch_id IS NULL
       AND UPPER(COALESCE(ms.source_type,'')) <> 'BATCH'
       AND COALESCE(mb.batch_date, mb.created_at::date) <= ${scope.asOf}::date
       -- Same rule as Balance on Table: a batch whose every source row was
       -- re-inserted by a later edit still consumed its material that day.
       AND (${nextCutoff(scope, "ms.created_at")}
            OR NOT EXISTS (SELECT 1 FROM factory_mix_batch_sources known_ms
                            WHERE known_ms.mix_batch_id = ms.mix_batch_id
                              AND ${nextCutoff(scope, "known_ms.created_at")}))
       AND ${nextCutoff(scope, "mb.created_at")}
       AND (mb.deleted_at IS NULL OR NOT ${nextCutoff(scope, "mb.deleted_at")})
  `)
  );

  // A legacy cumulative raw-stock row has already had its received_kg
  // reduced by a recorded DEDUCT. Reapplying that DEDUCT would remove it
  // twice. The earlier quantity is not fully recoverable without an original
  // receipt event, so do not invent it: retain the known cumulative amount
  // and expose the explicit reconstruction limitation.
  const fallbackKeys = new Set(receipts.filter((r) => r.fallback).map((r) => r.key));
  const datedAdjustments = adjustments.filter((r) => !(r.type === "DEDUCT" && fallbackKeys.has(r.key)));

  const events: Event[] = [
    ...receipts.map((r) => ({
      key: r.key,
      kind: "RECEIPT" as const,
      day: r.day,
      recordedAt: r.recorded_at,
      stableId: Number(r.stable_id),
      kg: r.kg,
      usdRate: r.usd_rate,
    })),
    ...datedAdjustments.map((r) => ({
      key: r.key,
      kind: (r.type === "ADD" ? "ADD" : "DEDUCT") as "ADD" | "DEDUCT",
      day: r.day,
      recordedAt: r.recorded_at,
      stableId: Number(r.stable_id),
      kg: r.kg,
      usdRate: r.usd_rate,
      basis: r.basis,
    })),
    ...sources
      .filter((r) => r.key != null)
      .map((r) => ({
        key: r.key!,
        kind: "CONSUME" as const,
        day: r.day,
        recordedAt: r.recorded_at,
        stableId: Number(r.stable_id),
        kg: r.kg,
        usdRate: null,
      })),
  ];
  const replay = replayHistoricalRawEvents(events);
  const warnings = new Set(replay.warnings);
  const supplierIds = [...replay.states.keys()].filter((k) => k.startsWith("s")).map((k) => Number(k.slice(1)));
  const persisted = supplierIds.length
    ? resultRows<{ id: number; rate: string | null }>(
        await db.execute(sql`
    SELECT id, current_raw_material_cost_per_kg_usd::text AS rate
      FROM factory_suppliers WHERE company_id = ${companyId} AND id = ANY(${sqlArray(supplierIds)})
  `)
      )
    : [];
  const lockedRates = new Map<number, number>();
  for (const r of persisted) if (r.rate != null) lockedRates.set(Number(r.id), toMoney(r.rate).toNumber());
  const legacyIds = supplierIds.filter((id) => !lockedRates.has(id));
  if (legacyIds.length) {
    for (const [id, rate] of await getLockedSupplierRatesReadOnlyBulk(db, companyId, legacyIds))
      lockedRates.set(id, rate);
  }
  const later = supplierIds.length
    ? resultRows<{ supplier_id: number }>(
        await db.execute(sql`
    SELECT DISTINCT fc.supplier_id
      FROM factory_containers fc
     WHERE fc.company_id = ${companyId} AND fc.supplier_id = ANY(${sqlArray(supplierIds)})
       AND (EXISTS (SELECT 1 FROM factory_container_receipts r
                     WHERE r.container_id = fc.id AND r.company_id = fc.company_id
                       AND NOT ${nextCutoff(scope, "r.created_at")})
         OR EXISTS (SELECT 1 FROM factory_raw_stock rs
                     WHERE rs.container_id = fc.id AND rs.company_id = fc.company_id
                       AND NOT ${nextCutoff(scope, "rs.created_at")}))
  `)
      )
    : [];
  const valued = valueHistoricalRawStates(replay.states, lockedRates, new Set(later.map((r) => Number(r.supplier_id))));
  if (valued.rateUnversioned) warnings.add("HISTORICAL_RAW_LOCKED_RATE_UNVERSIONED");
  if (receipts.some((r) => r.fallback)) warnings.add("HISTORICAL_RAW_LEGACY_RECEIPT_FALLBACK");
  if (sources.some((r) => r.key == null)) warnings.add("HISTORICAL_RAW_SOURCE_OWNER_UNKNOWN");
  if (adjustments.some((r) => r.type === "DEDUCT" && fallbackKeys.has(r.key))) {
    warnings.add("HISTORICAL_RAW_LEGACY_DEDUCT_MUTATED_RECEIPT");
  }
  return { value: valued.value, warnings: [...warnings] };
}

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
  }>(
    await db.execute(sql`
    WITH candidate AS (
      SELECT b.id, b.status,
             COALESCE(p.production_price::numeric, 0) AS catalog_cost,
             COALESCE(p.selling_price::numeric, 0) AS catalog_selling,
             ${nextCutoff(scope, "b.updated_at")} AS unchanged,
             b.finalized_at IS NULL AS legacy_entry,
             (b.finalized_at IS NOT NULL AND ${nextCutoff(scope, "b.finalized_at")}) AS finalized_before,
             (EXISTS (
                SELECT 1 FROM customer_order_bales cob
                JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
                WHERE cob.bale_id = b.id
                  AND cob.scanned_at IS NOT NULL
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
             ) OR EXISTS (
                -- A scan cancelled after the selected day was still allocated
                -- on the selected day; archived history retains that interval.
                SELECT 1 FROM customer_order_bales_history coh
                JOIN customer_orders co ON co.id = coh.order_id AND co.company_id = ${companyId}
                WHERE coh.bale_id = b.id
                  AND coh.scanned_at IS NOT NULL
                  AND ${netPositionRecordedThrough(sql`coh.scanned_at`, scope, "timestamptz")}
                  AND NOT ${netPositionRecordedThrough(sql`coh.cancelled_at`, scope, "timestamptz")}
                  AND ${orderLiveThen}
             ) OR EXISTS (
                SELECT 1 FROM customer_order_bales cob
                JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
                WHERE cob.bale_id = b.id
                  AND ${netPositionLegacyScanKnown("cob", "co", companyId, scope)}
                  AND ${orderLiveThen}
             ) OR EXISTS (
                -- Legacy scan without a time: allocated then only when its
                -- order row (whose totals every scan rewrites) is itself
                -- unchanged since the cutoff and in today's allocating statuses.
                SELECT 1 FROM customer_order_bales cob
                JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
                WHERE cob.bale_id = b.id AND cob.scanned_at IS NULL
                  AND ${nextCutoff(scope, "co.updated_at")}
                  AND co.deleted_at IS NULL
                  AND co.status IN ('LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED','DISPATCHED','SOLD')
             )) AS allocated_then,
             (b.waste_dispatch_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM factory_bale_waste_dispatches wd
                 WHERE wd.id = b.waste_dispatch_id
                   AND wd.dispatch_date <= ${scope.asOf}::date
                   AND ${nextCutoff(scope, "wd.created_at")}
             )) AS dispatched_then,
             (EXISTS (
                SELECT 1 FROM customer_order_bales cob
                JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
                WHERE cob.bale_id = b.id AND cob.scanned_at IS NULL
             ) OR EXISTS (
                SELECT 1 FROM customer_order_bales_history coh
                JOIN customer_orders co ON co.id = coh.order_id AND co.company_id = ${companyId}
                WHERE coh.bale_id = b.id AND coh.scanned_at IS NULL
                  AND NOT ${netPositionRecordedThrough(sql`coh.cancelled_at`, scope, "timestamptz")}
             )) AS missing_scan_time
        FROM factory_bales b
        LEFT JOIN factory_bale_products p ON p.id = b.product_id AND p.company_id = ${companyId}
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
           COUNT(*) FILTER (WHERE counted AND (catalog_cost > 0 OR catalog_selling > 0))::text AS priced
      FROM in_stock
  `)
  );
  const row = rows[0] ?? {};
  const warnings: string[] = [];
  if (Number(row.legacy_entry || 0) > 0) warnings.push("HISTORICAL_STOCK_FINALIZATION_TIME_MISSING");
  if (Number(row.missing_scan_time || 0) > 0) warnings.push("HISTORICAL_STOCK_SCAN_TIME_MISSING");
  if (Number(row.uncertain_removals || 0) > 0) warnings.push("HISTORICAL_STOCK_REMOVAL_TIME_UNKNOWN");
  if (Number(row.priced || 0) > 0) {
    // Same catalogue prices as today's figure; the catalogue is not versioned.
    warnings.push(
      valuationMode === "selling"
        ? "HISTORICAL_STOCK_SELLING_PRICE_UNVERSIONED"
        : "HISTORICAL_STOCK_COST_EDITS_NOT_VERSIONED"
    );
  }
  return {
    value: cents(money(valuationMode === "selling" ? row.total_selling : row.total_cost)),
    warnings,
  };
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
