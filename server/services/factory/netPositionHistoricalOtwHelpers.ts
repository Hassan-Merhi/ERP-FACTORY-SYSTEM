// Extracted from ./netPositionHistoricalOtw.ts
import type Decimal from "decimal.js";
import { netPositionBusinessDay, type FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { loadFactoryRowsKnownAt, type HistoricalRow } from "./netPositionRowHistoryReader";

export const decimal = (v: unknown): Decimal => toMoney(v as string | number | null | undefined);

export const cents = (v: Decimal): number => v.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();

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

export type ContainerRow = {
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
export async function recordedOtwAt(
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
