// Extracted from ./netPositionHistoricalPipeline.ts to keep that module under the source-size cap.
/**
 * Read-only Phase 5 reconstruction for Factory Net Position.
 *
 * Uses event time + document time, NOT today's mutable container/order state.
 * Old orders, container amount edits and missing scan timestamps are surfaced
 * as limitations; never infer a past transaction from a future scan or offload.
 */
import { sql, type SQL } from "drizzle-orm";
import type Decimal from "decimal.js";
import { type FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal } from "../../lib/money";
import { netPositionRecordedThrough } from "./netPositionAsOf";
import {
  cents,
  historicalContainerOtw,
  recordedOtwAt,
  type HistoricalOrderStage,
  type ContainerRow,
} from "./netPositionHistoricalOtwHelpers";
export {
  decimal,
  cents,
  OTW_CONTAINER_STATUSES,
  historicalContainerOtw,
  type DatedPipelineOrder,
  type DatedPipelineSnapshot,
  type HistoricalOrderStage,
  type HistoricalOtwContainer,
} from "./netPositionHistoricalOtwHelpers";

export const isBefore = (
  scope: FactoryNetPositionAsOf,
  fragment: string,
  kind: "timestamptz" | "utc-naive-timestamp" = "utc-naive-timestamp"
) => netPositionRecordedThrough(sql.raw(fragment), scope, kind);

/**
 * A voucher of the order's company numbered `number` was in the ledger by the
 * cutoff: under that number then, or retired after it (renamed
 * `{number}~DEL{id}`, original_voucher_number kept). Two EXISTS, not one OR
 * across both columns, so the number index is used.
 */
export const voucherKnownBy = (scope: FactoryNetPositionAsOf, number: SQL) => {
  const known = (alias: string) =>
    sql.raw(`${alias}.company_id = o.company_id`).append(sql`
       AND ${isBefore(scope, `${alias}.created_at`)}
       AND (${sql.raw(`${alias}.deleted_at`)} IS NULL OR NOT ${isBefore(scope, `${alias}.deleted_at`)})`);
  return sql`(EXISTS (SELECT 1 FROM vouchers nv WHERE nv.voucher_number = ${number} AND ${known("nv")})
    OR EXISTS (SELECT 1 FROM vouchers rv WHERE rv.voucher_number LIKE '%~DEL%'
                AND rv.original_voucher_number = ${number} AND ${known("rv")}))`;
};

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

export async function getHistoricalOtw(
  companyId: number,
  scope: FactoryNetPositionAsOf,
  getConfigFx: (currency: string) => number
): Promise<{ value: number; warnings: string[] }> {
  const recorded = await recordedOtwAt(companyId, scope, getConfigFx);
  if (recorded) return recorded;
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
