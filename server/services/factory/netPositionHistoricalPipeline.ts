/**
 * Read-only Phase 5 reconstruction for Factory Net Position.
 *
 * Uses event time + document time, NOT today's mutable container/order state.
 * Old orders, container amount edits and missing scan timestamps are surfaced
 * as limitations; never infer a past transaction from a future scan or offload.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { netPositionLegacyScanKnown, netPositionRecordedThrough } from "./netPositionAsOf";

const decimal = (v: unknown): Decimal => toMoney(v as string | number | null | undefined);
const cents = (v: Decimal): number => v.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();
const isBefore = (
  scope: FactoryNetPositionAsOf,
  fragment: string,
  kind: "timestamptz" | "utc-naive-timestamp" = "utc-naive-timestamp"
) => netPositionRecordedThrough(sql.raw(fragment), scope, kind);

export type DatedPipelineOrder = {
  id: number;
  customerName: string;
  orderDate: string;
  grandTotal: number;
  totalQtyBales: number;
};
export type DatedPipelineSnapshot = {
  stockOtwValue: number;
  pendingOrders: DatedPipelineOrder[];
  verifiedOrders: DatedPipelineOrder[];
  loadingOrders: DatedPipelineOrder[];
  pendingTotal: number;
  verifiedTotal: number;
  loadingTotal: number;
  warnings: string[];
};

export type HistoricalOrderStage = "PENDING_VERIFICATION" | "LOADING" | "VERIFIED" | "FINALIZED" | "UNKNOWN";

/** Derive stage from recorded transitions, never the row's current status. */
export function orderStageAt(events: {
  created: boolean;
  loadingStarted: boolean;
  verified: boolean;
  invoiced: boolean;
  currentStatus: string;
  currentStateKnown?: boolean;
  loadingStartedAt?: string | null;
  verifiedAt?: string | null;
}): HistoricalOrderStage {
  if (!events.created) return "UNKNOWN";
  if (events.invoiced) return "FINALIZED";
  // Reopened orders can move VERIFIED -> LOADING -> VERIFIED. The latest
  // recorded qualifying transition must win; current status is not history.
  if (
    events.loadingStarted &&
    events.verified &&
    events.loadingStartedAt &&
    events.verifiedAt &&
    events.loadingStartedAt > events.verifiedAt
  )
    return "LOADING";
  if (events.verified) return "VERIFIED";
  if (events.loadingStarted) return "LOADING";
  if (events.currentStatus === "PENDING_VERIFICATION" && events.currentStateKnown) {
    return "PENDING_VERIFICATION";
  }
  return "UNKNOWN";
}

/** Container statuses today's Net Position values as Factory Stock OTW. */
export const OTW_CONTAINER_STATUSES = new Set(["PENDING", "IN_TRANSIT", "ARRIVED"]);
const OFFLOADED_CONTAINER_STATUSES = new Set(["PARTIALLY_RECEIVED", "OFFLOADED", "RECEIVED"]);

export type HistoricalOtwContainer = {
  status: string;
  preOffloadStatus: string | null;
  /** A receipt (or legacy offload) with business date AND recorded time by the cutoff. */
  receivedByCutoff: boolean;
  updatedAfterCutoff: boolean;
  currencyCode: string;
  totalKg: string;
  ratePerKg: string;
  finalPayable: string;
  freight: string;
  freightCurrencyCode: string | null;
  commission: string;
  commissionCurrencyCode: string | null;
  otherCharges: string;
  preOffloadFreight: string | null;
  preOffloadFreightCurrencyCode: string | null;
  preOffloadCommission: string | null;
  preOffloadCommissionCurrencyCode: string | null;
  preOffloadOtherCharges: string | null;
};

/**
 * Today's rule (netPositionInventory.ts): a container is Factory Stock OTW
 * while its status is PENDING / IN_TRANSIT / ARRIVED, valued at its final
 * payable (or rate x kg) plus freight, commission and other charges. The
 * first receipt moves it to PARTIALLY_RECEIVED / OFFLOADED, after which it
 * is raw stock and a supplier payable, never OTW again.
 *
 * The dated equivalent asks whether a qualifying receipt existed by the
 * cutoff. A container offloaded later was still in transit; the offload
 * overwrote its final payable and charges, so the pre-offload snapshot is
 * used for those amounts. Returns native-currency amounts, or null when the
 * container was not OTW on the selected day.
 */
export function historicalContainerOtw(c: HistoricalOtwContainer): {
  amounts: Array<{ currency: string; amount: Decimal }>;
  warnings: string[];
} | null {
  if (c.receivedByCutoff) return null;
  const warnings: string[] = [];
  const status = (c.status || "").toUpperCase();
  const offloadedLater = OFFLOADED_CONTAINER_STATUSES.has(status);
  if (!OTW_CONTAINER_STATUSES.has(status)) {
    if (!offloadedLater) {
      // OPENING_BALANCE or any other non-transit status is not OTW today.
      // A later status edit has no dated history; say so rather than guess.
      if (c.updatedAfterCutoff) warnings.push("HISTORICAL_OTW_STATUS_HISTORY_MISSING");
      return warnings.length ? { amounts: [], warnings } : null;
    }
    const prior = (c.preOffloadStatus || "").toUpperCase();
    if (prior && !OTW_CONTAINER_STATUSES.has(prior)) return null;
    if (!prior) warnings.push("HISTORICAL_OTW_STATUS_HISTORY_MISSING");
  }
  if (c.updatedAfterCutoff) warnings.push("HISTORICAL_OTW_MASTER_VALUES_UNVERSIONED");

  const containerCcy = (c.currencyCode || "USD").trim().toUpperCase();
  const amounts: Array<{ currency: string; amount: Decimal }> = [];
  const add = (currency: string | null | undefined, amount: Decimal) => {
    if (amount.gt(0)) amounts.push({ currency: (currency || containerCcy).trim().toUpperCase(), amount });
  };
  const rateGoods = decimal(c.ratePerKg).times(decimal(c.totalKg));
  if (offloadedLater) {
    // final_payable_amount now holds the RECEIVED value set at offload.
    if (rateGoods.gt(0)) add(containerCcy, rateGoods);
    else {
      warnings.push("HISTORICAL_OTW_GOODS_RATE_UNVERSIONED");
      add(containerCcy, decimal(c.finalPayable));
    }
    const snapshotMissing =
      c.preOffloadFreight == null && c.preOffloadCommission == null && c.preOffloadOtherCharges == null;
    if (snapshotMissing) {
      warnings.push("HISTORICAL_OTW_CHARGES_UNVERSIONED");
      add(c.freightCurrencyCode, decimal(c.freight));
      add(c.commissionCurrencyCode || "USD", decimal(c.commission));
      add(containerCcy, decimal(c.otherCharges));
    } else {
      add(c.preOffloadFreightCurrencyCode, decimal(c.preOffloadFreight));
      add(c.preOffloadCommissionCurrencyCode || "USD", decimal(c.preOffloadCommission));
      add(containerCcy, decimal(c.preOffloadOtherCharges));
    }
  } else {
    const finalPayable = decimal(c.finalPayable);
    add(containerCcy, finalPayable.gt(0) ? finalPayable : rateGoods);
    add(c.freightCurrencyCode, decimal(c.freight));
    add(c.commissionCurrencyCode || "USD", decimal(c.commission));
    add(containerCcy, decimal(c.otherCharges));
  }
  return { amounts, warnings };
}

type ContainerRow = {
  id: number;
  status: string;
  pre_offload_status: string | null;
  currency_code: string | null;
  total_kg: string;
  rate_per_kg: string;
  final_payable: string;
  freight: string;
  freight_ccy: string | null;
  commission: string;
  commission_ccy: string | null;
  other_charges: string;
  pre_freight: string | null;
  pre_freight_ccy: string | null;
  pre_commission: string | null;
  pre_commission_ccy: string | null;
  pre_other_charges: string | null;
  received_by_cutoff: boolean;
  updated_after_cutoff: boolean;
};

async function getHistoricalOtw(
  companyId: number,
  scope: FactoryNetPositionAsOf,
  getConfigFx: (currency: string) => number
): Promise<{ value: number; warnings: string[] }> {
  const receiptKnown = sql`r.receipt_date <= ${scope.asOf}::date
                AND ${isBefore(scope, "r.created_at")}
                AND (r.deleted_at IS NULL OR NOT ${isBefore(scope, "r.deleted_at")})`;
  const rows = resultRows<ContainerRow>(
    await db.execute(sql`
    SELECT fc.id, fc.status, fc.pre_offload_status, fc.currency_code,
           COALESCE(fc.total_kg, 0)::text AS total_kg,
           COALESCE(fc.rate_per_kg, 0)::text AS rate_per_kg,
           COALESCE(fc.final_payable_amount, 0)::text AS final_payable,
           COALESCE(fc.freight, 0)::text AS freight,
           COALESCE(fc.freight_currency_code, fc.currency_code) AS freight_ccy,
           COALESCE(fc.commission_amount, 0)::text AS commission,
           fc.commission_currency_code AS commission_ccy,
           COALESCE(fc.other_charges, 0)::text AS other_charges,
           fc.pre_offload_freight::text AS pre_freight,
           COALESCE(fc.pre_offload_freight_currency_code, fc.currency_code) AS pre_freight_ccy,
           fc.pre_offload_commission_amount::text AS pre_commission,
           fc.pre_offload_commission_currency_code AS pre_commission_ccy,
           fc.pre_offload_other_charges::text AS pre_other_charges,
           (EXISTS (
              SELECT 1 FROM factory_container_receipts r
               WHERE r.company_id = fc.company_id AND r.container_id = fc.id AND ${receiptKnown})
            OR (
              NOT EXISTS (SELECT 1 FROM factory_container_receipts r
                           WHERE r.company_id = fc.company_id AND r.container_id = fc.id)
              AND EXISTS (
                SELECT 1 FROM factory_raw_stock rs
                 WHERE rs.company_id = fc.company_id AND rs.container_id = fc.id
                   AND COALESCE(rs.offloaded_at, rs.created_at)::date <= ${scope.asOf}::date
                   AND ${isBefore(scope, "rs.created_at")}
                   AND (rs.deleted_at IS NULL OR NOT ${isBefore(scope, "rs.deleted_at")})))
           ) AS received_by_cutoff,
           NOT ${isBefore(scope, "fc.updated_at")} AS updated_after_cutoff
      FROM factory_containers fc
     WHERE fc.company_id = ${companyId}
       AND ${isBefore(scope, "fc.created_at")}
       AND (fc.deleted_at IS NULL OR NOT ${isBefore(scope, "fc.deleted_at")})
  `)
  );
  const warnings = new Set<string>();
  const buckets = new Map<string, Decimal>();
  for (const c of rows) {
    const otw = historicalContainerOtw({
      status: c.status,
      preOffloadStatus: c.pre_offload_status,
      receivedByCutoff: Boolean(c.received_by_cutoff),
      updatedAfterCutoff: Boolean(c.updated_after_cutoff),
      currencyCode: c.currency_code || "USD",
      totalKg: c.total_kg,
      ratePerKg: c.rate_per_kg,
      finalPayable: c.final_payable,
      freight: c.freight,
      freightCurrencyCode: c.freight_ccy,
      commission: c.commission,
      commissionCurrencyCode: c.commission_ccy,
      otherCharges: c.other_charges,
      preOffloadFreight: c.pre_freight,
      preOffloadFreightCurrencyCode: c.pre_freight_ccy,
      preOffloadCommission: c.pre_commission,
      preOffloadCommissionCurrencyCode: c.pre_commission_ccy,
      preOffloadOtherCharges: c.pre_other_charges,
    });
    if (!otw) continue;
    otw.warnings.forEach((w) => warnings.add(w));
    for (const { currency, amount } of otw.amounts) {
      buckets.set(currency, (buckets.get(currency) ?? new MoneyDecimal(0)).plus(amount));
    }
  }
  // Same per-currency aggregation and manual-rate conversion as today's OTW.
  let total: Decimal = new MoneyDecimal(0);
  for (const [currency, amount] of buckets) {
    total = total.plus(amount.times(currency === "USD" ? 1 : getConfigFx(currency)));
  }
  return { value: cents(total), warnings: [...warnings] };
}

type OrderRow = {
  id: number;
  customer_name: string;
  order_date: string;
  current_status: string;
  grand_total: string;
  total_qty_bales: number;
  loading_started_at: string | null;
  verified_at: string | null;
  finalized_at: string | null;
  updated_at: string;
  loading_before: boolean;
  verified_before: boolean;
  finalized_before: boolean;
  state_known_before: boolean;
  scanned_qty: string;
  scanned_value: string;
  unknown_scans: string;
  had_charges: boolean;
  had_unknown_restores: boolean;
  unproven_verification: boolean;
  unchanged_since_cutoff: boolean;
};

async function getHistoricalOrders(
  companyId: number,
  scope: FactoryNetPositionAsOf
): Promise<{
  pendingOrders: DatedPipelineOrder[];
  verifiedOrders: DatedPipelineOrder[];
  loadingOrders: DatedPipelineOrder[];
  warnings: string[];
}> {
  const rows = resultRows<OrderRow>(
    await db.execute(sql`
    WITH scan_events AS (
      SELECT cob.order_id, cob.bale_id, cob.scanned_at, cob.price_used, 0 AS archived
        FROM customer_order_bales cob
        JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
       WHERE cob.scanned_at IS NOT NULL
         AND ${isBefore(scope, "cob.scanned_at", "timestamptz")}
         AND NOT EXISTS (
           -- Restoration reuses the original scanned_at; once that scan
           -- was cancelled, an undated later restoration must NOT magically
           -- make it eligible again on the cancellation date.
           SELECT 1 FROM customer_order_bales_history prior
            WHERE prior.order_id = cob.order_id
              AND prior.bale_id = cob.bale_id
              AND ${isBefore(scope, "prior.cancelled_at", "timestamptz")}
         )
      UNION ALL
      SELECT cob.order_id, cob.bale_id, cob.scanned_at, cob.price_used, 0 AS archived
        FROM customer_order_bales cob
        JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
       WHERE ${netPositionLegacyScanKnown("cob", "co", companyId, scope)}
      UNION ALL
      SELECT h.order_id, h.bale_id, h.scanned_at, h.price_used, 1 AS archived
        FROM customer_order_bales_history h
        JOIN customer_orders co ON co.id = h.order_id AND co.company_id = ${companyId}
       WHERE h.scanned_at IS NOT NULL
         AND ${isBefore(scope, "h.scanned_at", "timestamptz")}
         AND NOT ${isBefore(scope, "h.cancelled_at", "timestamptz")}
    ), active_scans AS (
      SELECT DISTINCT ON (order_id, bale_id)
             order_id, bale_id, price_used
        FROM scan_events
       ORDER BY order_id, bale_id, archived DESC
    ), totals AS (
      SELECT order_id, COUNT(*)::text AS qty,
             COALESCE(SUM(price_used::numeric),0)::text AS scanned_value
        FROM active_scans GROUP BY order_id
    )
    SELECT o.id, COALESCE(c.legal_name, 'Customer #' || o.customer_id::text) AS customer_name,
           o.order_date::text AS order_date, o.status AS current_status,
           o.grand_total::text AS grand_total, o.total_qty_bales, o.updated_at::text,
           o.loading_started_at::text AS loading_started_at,
           COALESCE(verify_event.recorded_at,
             CASE WHEN ${isBefore(scope, "o.updated_at")}
                   AND (COALESCE(${isBefore(scope, "o.verified_at")},false)
                     OR COALESCE(${isBefore(scope, "o.loading_finalized_at")},false))
                  THEN o.updated_at ELSE NULL END)::text AS verified_at,
           o.finalized_at::text AS finalized_at,
           COALESCE(${isBefore(scope, "o.updated_at")},false) AS state_known_before,
           COALESCE(${isBefore(scope, "o.loading_started_at")},false) AS loading_before,
           (verify_event.recorded_at IS NOT NULL OR
             (COALESCE(${isBefore(scope, "o.updated_at")},false) AND
               (COALESCE(${isBefore(scope, "o.verified_at")},false)
                 OR COALESCE(${isBefore(scope, "o.loading_finalized_at")},false)))) AS verified_before,
           (verify_event.recorded_at IS NULL
             AND (COALESCE(${isBefore(scope, "o.verified_at")},false)
               OR COALESCE(${isBefore(scope, "o.loading_finalized_at")},false))
             AND NOT COALESCE(${isBefore(scope, "o.updated_at")},false)) AS unproven_verification,
           COALESCE(${isBefore(scope, "o.finalized_at")},false) AS finalized_before,
           -- The order row was last written before the cutoff and no scan was
           -- added or cancelled since: its stored totals ARE its value that day.
           (COALESCE(${isBefore(scope, "o.updated_at")},false)
             AND NOT EXISTS (SELECT 1 FROM customer_order_bales cob
                              WHERE cob.order_id = o.id
                                AND (cob.scanned_at IS NULL OR NOT ${isBefore(scope, "cob.scanned_at", "timestamptz")})
                                AND NOT ${netPositionLegacyScanKnown("cob", "o", companyId, scope)})
             AND NOT EXISTS (SELECT 1 FROM customer_order_bales_history h
                              WHERE h.order_id = o.id
                                AND (h.cancelled_at IS NULL OR NOT ${isBefore(scope, "h.cancelled_at", "timestamptz")}))
           ) AS unchanged_since_cutoff,
           COALESCE(t.qty, '0') AS scanned_qty,
           COALESCE(t.scanned_value, '0') AS scanned_value,
           (SELECT COUNT(*)::text FROM customer_order_bales cob
             WHERE cob.order_id = o.id AND cob.scanned_at IS NULL
               AND NOT ${netPositionLegacyScanKnown("cob", "o", companyId, scope)}) AS unknown_scans,
           (EXISTS (SELECT 1 FROM customer_order_charges ch WHERE ch.order_id = o.id)
             OR COALESCE(o.freight_amount,0)::numeric <> 0
             OR COALESCE(o.other_charges_total,0)::numeric <> 0) AS had_charges,
           EXISTS (
             SELECT 1 FROM customer_order_bales_history h
             JOIN customer_order_bales live ON live.order_id = h.order_id AND live.bale_id = h.bale_id
              WHERE h.order_id = o.id
                AND ${isBefore(scope, "h.cancelled_at", "timestamptz")}
                AND live.scanned_at IS NOT NULL
                AND ${isBefore(scope, "live.scanned_at", "timestamptz")}
           ) AS had_unknown_restores
      FROM customer_orders o
      JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
      LEFT JOIN LATERAL (
        SELECT MAX(d.created_at) AS recorded_at
          FROM factory_daybook_entries d
         WHERE d.company_id = o.company_id AND d.reference_table = 'customer_orders'
           AND d.reference_id = o.id
           AND d.tx_type IN ('ORDER_VERIFIED', 'LOADING_SUBMITTED')
           AND d.tx_date <= ${scope.asOf}::date
           AND ${isBefore(scope, "d.created_at")}
      ) verify_event ON TRUE
      LEFT JOIN totals t ON t.order_id = o.id
     WHERE o.company_id = ${companyId}
       AND o.order_date <= ${scope.asOf}::date
       AND ${isBefore(scope, "o.created_at")}
       AND (o.deleted_at IS NULL OR NOT ${isBefore(scope, "o.deleted_at")})
  `)
  );
  const pendingOrders: DatedPipelineOrder[] = [];
  const verifiedOrders: DatedPipelineOrder[] = [];
  const loadingOrders: DatedPipelineOrder[] = [];
  const warnings = new Set<string>();
  for (const r of rows) {
    // Every status change writes customer_orders.updated_at, so a row last
    // updated before the cutoff still shows its status on that day (a
    // CANCELLED or FINALIZED order is then never revived as LOADING).
    const stage: HistoricalOrderStage = r.state_known_before
      ? ["PENDING_VERIFICATION", "VERIFIED", "LOADING"].includes(r.current_status)
        ? (r.current_status as HistoricalOrderStage)
        : "FINALIZED"
      : orderStageAt({
          created: true,
          loadingStarted: r.loading_before,
          verified: r.verified_before,
          invoiced: r.finalized_before,
          currentStatus: r.current_status,
          currentStateKnown: r.state_known_before,
          loadingStartedAt: r.loading_started_at,
          verifiedAt: r.verified_at,
        });
    if (stage === "FINALIZED") continue;
    if (r.unproven_verification) warnings.add("HISTORICAL_ORDER_BACKDATED_VERIFICATION_UNPROVEN");
    if (stage === "UNKNOWN") {
      warnings.add("HISTORICAL_ORDER_LIFECYCLE_UNVERSIONED");
      continue;
    }
    if (r.current_status === "FINALIZED" && !r.finalized_at) {
      warnings.add("HISTORICAL_ORDER_FINALIZATION_MISSING");
    }
    if (r.had_unknown_restores) warnings.add("HISTORICAL_ORDER_RESTORE_TIME_UNKNOWN");
    if (Number(r.unknown_scans) > 0) warnings.add("HISTORICAL_ORDER_SCAN_TIME_MISSING");
    // An order untouched since the cutoff keeps today's valuation rule
    // (grand_total incl. freight/charges and per-kg pricing). Otherwise the
    // historic subtotal is the individually recorded bale scans, never
    // today's mutable grand_total / total_qty_bales.
    const exact = Boolean(r.unchanged_since_cutoff);
    if (!exact) {
      if (r.had_charges) warnings.add("HISTORICAL_ORDER_CHARGES_UNVERSIONED");
      if (decimal(r.scanned_value).gt(0)) warnings.add("HISTORICAL_ORDER_SCAN_PRICE_EDITS_UNVERSIONED");
    }
    const item: DatedPipelineOrder = {
      id: Number(r.id),
      customerName: r.customer_name,
      orderDate: r.order_date,
      grandTotal: cents(decimal(exact ? r.grand_total : r.scanned_value)),
      totalQtyBales: exact ? Number(r.total_qty_bales ?? 0) : Number(r.scanned_qty),
    };
    if (stage === "VERIFIED") verifiedOrders.push(item);
    else if (stage === "LOADING") loadingOrders.push(item);
    else pendingOrders.push(item);
  }
  return { pendingOrders, verifiedOrders, loadingOrders, warnings: [...warnings] };
}

export async function loadHistoricalFactoryPipeline(
  companyId: number,
  scope: FactoryNetPositionAsOf,
  getConfigFx: (cc: string) => number
): Promise<DatedPipelineSnapshot> {
  let otw: Awaited<ReturnType<typeof getHistoricalOtw>>;
  let orders: Awaited<ReturnType<typeof getHistoricalOrders>>;
  try {
    [otw, orders] = await Promise.all([
      getHistoricalOtw(companyId, scope, getConfigFx),
      getHistoricalOrders(companyId, scope),
    ]);
  } catch (cause) {
    // Never substitute today's container or order totals for a failed date.
    throw new Error("HISTORICAL_NET_POSITION_PIPELINE_FAILED", { cause });
  }
  const sum = (items: readonly DatedPipelineOrder[]) =>
    cents(items.reduce((acc, item) => acc.plus(decimal(item.grandTotal)), new MoneyDecimal(0)));
  return {
    stockOtwValue: otw.value,
    ...orders,
    pendingTotal: sum(orders.pendingOrders),
    verifiedTotal: sum(orders.verifiedOrders),
    loadingTotal: sum(orders.loadingOrders),
    warnings: [...new Set([...otw.warnings, ...orders.warnings])],
  };
}
