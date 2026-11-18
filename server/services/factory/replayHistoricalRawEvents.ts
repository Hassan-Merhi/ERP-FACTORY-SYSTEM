// Extracted from ./netPositionHistoricalInventory.ts to keep that module under the source-size cap.
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { netPositionRecordedThrough } from "./netPositionAsOf";
import { getLockedSupplierRatesReadOnlyBulk } from "./rawStockLockedRateBulk";
import { sqlArray } from "../../lib/sqlArray";
import { loadFactoryRowsKnownAt } from "./netPositionRowHistoryReader";

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

export const ZERO = new MoneyDecimal(0);

export const money = (value: unknown): Decimal => toMoney(value as string | number | null | undefined);

export const cents = (value: Decimal): number => value.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();

export const nextCutoff = (scope: FactoryNetPositionAsOf, column: string) =>
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
export async function rawMaterialAt(companyId: number, scope: FactoryNetPositionAsOf) {
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
    owner_conflict: boolean;
  }>(
    await db.execute(sql`
    -- A source whose container has a raw-stock row drew down that row's
    -- used_kg, which is where today's report counts it: it consumes the
    -- container supplier's stock even when the row names another owner
    -- (flagged). A container kept only as provenance changes nothing.
    SELECT CASE WHEN COALESCE(drawn.supplier_id, ms.inventory_supplier_id, ms.supplier_id, fc.supplier_id) IS NOT NULL
                THEN 's' || COALESCE(drawn.supplier_id, ms.inventory_supplier_id, ms.supplier_id, fc.supplier_id)::text
                WHEN ms.container_id IS NOT NULL THEN 'u' || ms.container_id::text
                ELSE NULL END AS key,
           (drawn.supplier_id IS NOT NULL
             AND COALESCE(ms.inventory_supplier_id, ms.supplier_id) IS NOT NULL
             AND drawn.supplier_id <> COALESCE(ms.inventory_supplier_id, ms.supplier_id)) AS owner_conflict,
           -- Never earlier than the source row was recorded: a top-up added
           -- later to an older batch consumes stock from when it was entered.
           GREATEST(COALESCE(mb.batch_date, mb.created_at::date), ms.created_at::date)::text AS day,
           GREATEST(ms.created_at, mb.created_at)::text AS recorded_at,
           ms.id AS stable_id, ms.weight_kg::text AS kg
      FROM factory_mix_batch_sources ms
      JOIN factory_mix_batches mb ON mb.id = ms.mix_batch_id
       AND mb.company_id = ${companyId}
      LEFT JOIN factory_containers fc ON fc.id = ms.container_id AND fc.company_id = ${companyId}
      LEFT JOIN LATERAL (
        SELECT fc.supplier_id
         WHERE fc.supplier_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM factory_raw_stock drawn_rs
                        WHERE drawn_rs.container_id = ms.container_id AND drawn_rs.company_id = ${companyId})
      ) drawn ON true
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
  // Before a table's atomic baseline, the original supplier rate is unknown:
  // preserve the existing replay and uncertainty warning. At/after baseline,
  // use recorded supplier row versions rather than today's mutable rate.
  const supplierHistory = supplierIds.length
    ? await loadFactoryRowsKnownAt("factory_suppliers", companyId, scope, supplierIds)
    : null;
  let supplierRatesReconstructed = false;
  if (supplierHistory?.ready) {
    supplierRatesReconstructed = true;
    lockedRates.clear();
    for (const id of supplierIds) {
      const record = supplierHistory.rows.get(id);
      if (!record) throw new Error("HISTORICAL_RAW_SUPPLIER_STATE_MISSING");
      const rate = record.current_raw_material_cost_per_kg_usd;
      if (rate !== null && rate !== undefined && toMoney(rate as string | number).gt(0)) {
        lockedRates.set(id, toMoney(rate as string | number).toNumber());
      }
    }
  }
  const legacyIds = supplierRatesReconstructed ? [] : supplierIds.filter((id) => !lockedRates.has(id));
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
  const valued = valueHistoricalRawStates(
    replay.states,
    lockedRates,
    supplierRatesReconstructed ? new Set<number>() : new Set(later.map((r) => Number(r.supplier_id)))
  );
  if (valued.rateUnversioned || (supplierHistory && !supplierHistory.ready)) {
    warnings.add("HISTORICAL_RAW_LOCKED_RATE_UNVERSIONED");
  }
  if (receipts.some((r) => r.fallback)) warnings.add("HISTORICAL_RAW_LEGACY_RECEIPT_FALLBACK");
  if (sources.some((r) => r.key == null)) warnings.add("HISTORICAL_RAW_SOURCE_OWNER_UNKNOWN");
  if (sources.some((r) => r.owner_conflict)) warnings.add("HISTORICAL_RAW_SOURCE_OWNER_CONFLICT");
  if (adjustments.some((r) => r.type === "DEDUCT" && fallbackKeys.has(r.key))) {
    warnings.add("HISTORICAL_RAW_LEGACY_DEDUCT_MUTATED_RECEIPT");
  }
  return { value: valued.value, warnings: [...warnings] };
}
