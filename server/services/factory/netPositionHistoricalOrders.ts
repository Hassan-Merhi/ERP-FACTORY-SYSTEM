/** Read-only historical Factory customer-order reconstruction. */
import { sql } from "drizzle-orm";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { netPositionLegacyScanKnown } from "./netPositionAsOf";
import { loadFactoryRowsKnownAt } from "./netPositionRowHistoryReader";
import { sqlArray } from "../../lib/sqlArray";
import {
  decimal,
  cents,
  isBefore,
  voucherKnownBy,
  orderStageAt,
  type DatedPipelineOrder,
  type HistoricalOrderStage,
} from "./netPositionHistoricalOtw";

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
  known_charges: string;
  unknown_scans: string;
  had_charges: boolean;
  had_unknown_restores: boolean;
  unproven_verification: boolean;
  unchanged_since_cutoff: boolean;
};

// On and after the baseline, a recorded order image is a better source than
// inferring yesterday's stage from today's mutable flags and old daybook events.
// It also restores orders subsequently hard-deleted or rewritten. grand_total
// and total_qty_bales come from the same recorded version, avoiding today's
// revised charges and scan prices in an earlier date.
async function recordedOrdersAt(
  companyId: number,
  scope: FactoryNetPositionAsOf
): Promise<{
  pendingOrders: DatedPipelineOrder[];
  verifiedOrders: DatedPipelineOrder[];
  loadingOrders: DatedPipelineOrder[];
  warnings: string[];
} | null> {
  const snapshot = await loadFactoryRowsKnownAt("customer_orders", companyId, scope);
  if (!snapshot.ready) return null;
  const orders = [...snapshot.rows.values()]
    .filter(
      (row) => row.deleted_at == null && typeof row.order_date === "string" && row.order_date.slice(0, 10) <= scope.asOf
    )
    .sort((a, b) => String(b.order_date).localeCompare(String(a.order_date)) || Number(b.id) - Number(a.id));
  const customerIds = [
    ...new Set(orders.map((row) => Number(row.customer_id)).filter((id) => Number.isSafeInteger(id) && id > 0)),
  ];
  const customerNames = new Map<number, string>();
  if (customerIds.length) {
    const names = resultRows<{ id: number; legal_name: string | null }>(
      await db.execute(sql`SELECT id, legal_name FROM customers
        WHERE company_id = ${companyId} AND id = ANY(${sqlArray(customerIds)})`)
    );
    for (const c of names) if (c.legal_name) customerNames.set(Number(c.id), c.legal_name);
  }
  const pendingOrders: DatedPipelineOrder[] = [];
  const verifiedOrders: DatedPipelineOrder[] = [];
  const loadingOrders: DatedPipelineOrder[] = [];
  const warnings = new Set<string>();
  for (const row of orders) {
    const status = String(row.status ?? "").toUpperCase();
    if (!["PENDING_VERIFICATION", "VERIFIED", "LOADING"].includes(status)) {
      if (!["FINALIZED", "DISPATCHED", "SOLD", "CANCELLED", "DELETED"].includes(status)) {
        warnings.add("HISTORICAL_ORDER_LIFECYCLE_UNVERSIONED");
      }
      continue;
    }
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("HISTORICAL_ORDER_ROW_HISTORY_INVALID");
    const customerId = Number(row.customer_id);
    const item: DatedPipelineOrder = {
      id,
      customerName: customerNames.get(customerId) ?? `Customer #${customerId}`,
      orderDate: String(row.order_date).slice(0, 10),
      grandTotal: cents(decimal(row.grand_total)),
      totalQtyBales: Number(row.total_qty_bales ?? 0),
    };
    if (!Number.isSafeInteger(item.totalQtyBales) || item.totalQtyBales < 0) {
      throw new Error("HISTORICAL_ORDER_ROW_HISTORY_QUANTITY_INVALID");
    }
    if (status === "VERIFIED") verifiedOrders.push(item);
    else if (status === "LOADING") loadingOrders.push(item);
    else pendingOrders.push(item);
  }
  return { pendingOrders, verifiedOrders, loadingOrders, warnings: [...warnings] };
}

export async function getHistoricalOrders(
  companyId: number,
  scope: FactoryNetPositionAsOf
): Promise<{
  pendingOrders: DatedPipelineOrder[];
  verifiedOrders: DatedPipelineOrder[];
  loadingOrders: DatedPipelineOrder[];
  warnings: string[];
}> {
  const recorded = await recordedOrdersAt(companyId, scope);
  if (recorded) return recorded;
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
           -- finalized_at survives an invoice reversal (and was written
           -- before verification on some legacy orders): an order back in a
           -- pre-invoice status was invoiced that day only if its invoice
           -- voucher was in the ledger then.
           (COALESCE(${isBefore(scope, "o.finalized_at")},false)
             AND (o.status NOT IN ('PENDING_VERIFICATION', 'VERIFIED', 'LOADING')
               OR ${voucherKnownBy(scope, `'INV-GL-' || o.company_id::text || '-' || o.id::text`)})) AS finalized_before,
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
           -- Charges carry no timestamp of their own; one posted to a voucher
           -- (CHARGE-PRE-{order}-{charge} before invoicing) is known from it.
           COALESCE((SELECT SUM(ch.amount::numeric) FROM customer_order_charges ch
                      WHERE ch.order_id = o.id
                        AND (EXISTS (SELECT 1 FROM vouchers cv
                                     WHERE cv.id = ch.voucher_id AND cv.company_id = o.company_id
                                       AND ${isBefore(scope, "cv.created_at")}
                                       AND (cv.deleted_at IS NULL OR NOT ${isBefore(scope, "cv.deleted_at")}))
                          OR (ch.voucher_id IS NULL
                            AND ${voucherKnownBy(scope, `'CHARGE-PRE-' || o.id::text || '-' || ch.id::text`)}))), 0)::text AS known_charges,
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
     ORDER BY o.order_date DESC, o.id
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
    // historic subtotal is the individually recorded bale scans plus the
    // charges posted by then, never today's mutable grand_total /
    // total_qty_bales.
    const exact = Boolean(r.unchanged_since_cutoff);
    if (!exact) {
      if (r.had_charges) warnings.add("HISTORICAL_ORDER_CHARGES_UNVERSIONED");
      if (decimal(r.scanned_value).gt(0)) warnings.add("HISTORICAL_ORDER_SCAN_PRICE_EDITS_UNVERSIONED");
    }
    const item: DatedPipelineOrder = {
      id: Number(r.id),
      customerName: r.customer_name,
      orderDate: r.order_date,
      grandTotal: cents(exact ? decimal(r.grand_total) : decimal(r.scanned_value).plus(decimal(r.known_charges))),
      totalQtyBales: exact ? Number(r.total_qty_bales ?? 0) : Number(r.scanned_qty),
    };
    if (stage === "VERIFIED") verifiedOrders.push(item);
    else if (stage === "LOADING") loadingOrders.push(item);
    else pendingOrders.push(item);
  }
  return { pendingOrders, verifiedOrders, loadingOrders, warnings: [...warnings] };
}
