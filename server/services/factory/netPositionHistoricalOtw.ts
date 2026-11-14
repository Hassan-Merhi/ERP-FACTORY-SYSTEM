/**
 * Read-only Phase 5 reconstruction for Factory Net Position.
 *
 * Uses event time + document time, NOT today's mutable container/order state.
 * Old orders, container amount edits and missing scan timestamps are surfaced
 * as limitations; never infer a past transaction from a future scan or offload.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { netPositionBusinessDay, type FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { netPositionRecordedThrough } from "./netPositionAsOf";
import { loadFactoryRowsKnownAt, type HistoricalRow } from "./netPositionRowHistoryReader";

export const decimal = (v: unknown): Decimal => toMoney(v as string | number | null | undefined);
export const cents = (v: Decimal): number => v.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();
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
export const voucherKnownBy = (scope: FactoryNetPositionAsOf, number: string) => {
  const known = (alias: string) =>
    sql.raw(`${alias}.company_id = o.company_id`).append(sql`
       AND ${isBefore(scope, `${alias}.created_at`)}
       AND (${sql.raw(`${alias}.deleted_at`)} IS NULL OR NOT ${isBefore(scope, `${alias}.deleted_at`)})`);
  return sql`(EXISTS (SELECT 1 FROM vouchers nv WHERE nv.voucher_number = ${sql.raw(number)} AND ${known("nv")})
    OR EXISTS (SELECT 1 FROM vouchers rv WHERE rv.voucher_number LIKE '%~DEL%'
                AND rv.original_voucher_number = ${sql.raw(number)} AND ${known("rv")}))`;
};

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

// The live container master, receipts and cumulative raw stock are mutable.
// Once ALL three source baselines exist, derive the OTW stage and amounts
// from their recorded row versions, including subsequently deleted rows.
// Earlier dates still use the existing legacy reconstruction and warnings.
async function recordedOtwAt(
  companyId: number,
  scope: FactoryNetPositionAsOf,
  getConfigFx: (currency: string) => number
): Promise<{ value: number; warnings: string[] } | null> {
  const [containers, receipts, stock] = await Promise.all([
    loadFactoryRowsKnownAt("factory_containers", companyId, scope),
    loadFactoryRowsKnownAt("factory_container_receipts", companyId, scope),
    loadFactoryRowsKnownAt("factory_raw_stock", companyId, scope),
  ]);
  if (!containers.ready || !receipts.ready || !stock.ready) return null;
  const text = (row: HistoricalRow, key: string, fallback = ""): string =>
    row[key] == null ? fallback : String(row[key]);
  const onDate = (value: unknown) => typeof value === "string" && value.slice(0, 10) <= scope.asOf;
  const validReceiptContainers = new Set<number>();
  const rawContainers = new Set<number>();
  for (const r of receipts.rows.values()) {
    if (onDate(r.receipt_date) && !r.deleted_at) validReceiptContainers.add(Number(r.container_id));
  }
  for (const r of stock.rows.values()) {
    const rawTimestamp = r.offloaded_at ?? r.created_at;
    if (rawTimestamp == null || r.deleted_at) continue;
    // factory_raw_stock.offloaded_at is a UTC-naive timestamp, not a
    // company-local DATE. Do not use its UTC string prefix as business date.
    const iso = String(rawTimestamp).trim();
    const asInstant = new Date(/[zZ]$|[+-][0-9]{2}:?[0-9]{2}$/.test(iso) ? iso : iso.replace(" ", "T") + "Z");
    if (Number.isNaN(asInstant.getTime())) {
      throw new Error("HISTORICAL_RAW_OFFLOAD_TIMESTAMP_INVALID");
    }
    if (netPositionBusinessDay(asInstant, scope.timeZone) <= scope.asOf) {
      rawContainers.add(Number(r.container_id));
    }
  }
  const buckets = new Map<string, Decimal>();
  const warnings = new Set<string>();
  for (const c of containers.rows.values()) {
    if (c.deleted_at) continue;
    const id = Number(c.id);
    const valued = historicalContainerOtw({
      status: text(c, "status"),
      preOffloadStatus: c.pre_offload_status == null ? null : text(c, "pre_offload_status"),
      receivedByCutoff: validReceiptContainers.has(id) || rawContainers.has(id),
      updatedAfterCutoff: false,
      currencyCode: text(c, "currency_code", "USD"),
      totalKg: text(c, "total_kg", "0"),
      ratePerKg: text(c, "rate_per_kg", "0"),
      finalPayable: text(c, "final_payable_amount", "0"),
      freight: text(c, "freight", "0"),
      freightCurrencyCode: text(c, "freight_currency_code") || text(c, "currency_code", "USD"),
      commission: text(c, "commission_amount", "0"),
      commissionCurrencyCode: text(c, "commission_currency_code", "USD"),
      otherCharges: text(c, "other_charges", "0"),
      preOffloadFreight: c.pre_offload_freight == null ? null : text(c, "pre_offload_freight"),
      preOffloadFreightCurrencyCode:
        c.pre_offload_freight_currency_code == null ? null : text(c, "pre_offload_freight_currency_code"),
      preOffloadCommission: c.pre_offload_commission_amount == null ? null : text(c, "pre_offload_commission_amount"),
      preOffloadCommissionCurrencyCode:
        c.pre_offload_commission_currency_code == null ? null : text(c, "pre_offload_commission_currency_code"),
      preOffloadOtherCharges: c.pre_offload_other_charges == null ? null : text(c, "pre_offload_other_charges"),
    });
    if (!valued) continue;
    valued.warnings.forEach((warning) => warnings.add(warning));
    for (const { currency, amount } of valued.amounts) {
      buckets.set(currency, (buckets.get(currency) ?? new MoneyDecimal(0)).plus(amount));
    }
  }
  let total: Decimal = new MoneyDecimal(0);
  for (const [currency, amount] of buckets) {
    total = total.plus(amount.times(currency === "USD" ? 1 : getConfigFx(currency)));
  }
  return { value: cents(total), warnings: [...warnings] };
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

