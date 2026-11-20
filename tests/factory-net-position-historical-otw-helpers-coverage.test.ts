/**
 * Dated Factory Stock OTW valuation
 * (server/services/factory/netPositionHistoricalOtwHelpers.ts):
 * historicalContainerOtw for every status path (received by the cutoff,
 * non-transit, offloaded later with or without the pre-offload snapshot,
 * still in transit) and recordedOtwAt over recorded row versions. The row
 * history reader is mocked at its module boundary; its own behaviour is
 * covered by the net-position row-history tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const history = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../server/services/factory/netPositionRowHistoryReader", () => ({
  loadFactoryRowsKnownAt: history.load,
}));

import {
  cents,
  decimal,
  historicalContainerOtw,
  recordedOtwAt,
  type HistoricalOtwContainer,
} from "../server/services/factory/netPositionHistoricalOtwHelpers";
import type { FactoryNetPositionAsOf } from "../shared/factoryNetPositionAsOf";

const base: HistoricalOtwContainer = {
  status: "IN_TRANSIT",
  preOffloadStatus: null,
  receivedByCutoff: false,
  updatedAfterCutoff: false,
  currencyCode: "usd",
  totalKg: "1000",
  ratePerKg: "0.5",
  finalPayable: "0",
  freight: "100",
  freightCurrencyCode: null,
  commission: "20",
  commissionCurrencyCode: null,
  otherCharges: "5",
  preOffloadFreight: null,
  preOffloadFreightCurrencyCode: null,
  preOffloadCommission: null,
  preOffloadCommissionCurrencyCode: null,
  preOffloadOtherCharges: null,
};

const shown = (result: ReturnType<typeof historicalContainerOtw>) =>
  result && {
    amounts: result.amounts.map((a) => [a.currency, a.amount.toNumber()]),
    warnings: result.warnings,
  };

describe("historicalContainerOtw", () => {
  it("is not OTW once received by the cutoff, or for a non-transit status with no later edit", () => {
    expect(historicalContainerOtw({ ...base, receivedByCutoff: true })).toBeNull();
    expect(historicalContainerOtw({ ...base, status: "OPENING_BALANCE" })).toBeNull();
    expect(historicalContainerOtw({ ...base, status: "" })).toBeNull();
  });

  it("warns instead of guessing when a non-transit status was edited after the cutoff", () => {
    expect(shown(historicalContainerOtw({ ...base, status: "cancelled", updatedAfterCutoff: true }))).toEqual({
      amounts: [],
      warnings: ["HISTORICAL_OTW_STATUS_HISTORY_MISSING"],
    });
  });

  it("values a container still in transit at final payable or rate x kg plus charges", () => {
    expect(shown(historicalContainerOtw(base))).toEqual({
      amounts: [
        ["USD", 500],
        ["USD", 100],
        ["USD", 20],
        ["USD", 5],
      ],
      warnings: [],
    });
    const payable = historicalContainerOtw({
      ...base,
      currencyCode: "",
      finalPayable: "650",
      freightCurrencyCode: "cfa",
      commission: "0",
      commissionCurrencyCode: "ZMW",
      otherCharges: "0",
      updatedAfterCutoff: true,
    });
    expect(shown(payable)).toEqual({
      amounts: [
        ["USD", 650],
        ["CFA", 100],
      ],
      warnings: ["HISTORICAL_OTW_MASTER_VALUES_UNVERSIONED"],
    });
  });

  it("uses the pre-offload snapshot for a container offloaded after the cutoff", () => {
    const result = historicalContainerOtw({
      ...base,
      status: "OFFLOADED",
      preOffloadStatus: "arrived",
      currencyCode: "CFA",
      finalPayable: "999999",
      preOffloadFreight: "70",
      preOffloadFreightCurrencyCode: "USD",
      preOffloadCommission: "10",
      preOffloadCommissionCurrencyCode: null,
      preOffloadOtherCharges: "3",
    });
    expect(shown(result)).toEqual({
      amounts: [
        ["CFA", 500],
        ["USD", 70],
        ["USD", 10],
        ["CFA", 3],
      ],
      warnings: [],
    });
  });

  it("falls back to final payable and live charges, with warnings, when history is missing", () => {
    const result = historicalContainerOtw({
      ...base,
      status: "PARTIALLY_RECEIVED",
      ratePerKg: "0",
      finalPayable: "480",
      commissionCurrencyCode: "CFA",
    });
    expect(shown(result)).toEqual({
      amounts: [
        ["USD", 480],
        ["USD", 100],
        ["CFA", 20],
        ["USD", 5],
      ],
      warnings: [
        "HISTORICAL_OTW_STATUS_HISTORY_MISSING",
        "HISTORICAL_OTW_GOODS_RATE_UNVERSIONED",
        "HISTORICAL_OTW_CHARGES_UNVERSIONED",
      ],
    });
  });

  it("is not OTW when the container was offloaded from a non-transit status", () => {
    expect(historicalContainerOtw({ ...base, status: "RECEIVED", preOffloadStatus: "OPENING_BALANCE" })).toBeNull();
  });

  it("rounds cents half up and reads empty values as zero", () => {
    expect(cents(decimal("1.005"))).toBe(1.01);
    expect(decimal(null).toNumber()).toBe(0);
  });
});

const scope: FactoryNetPositionAsOf = {
  asOf: "2026-03-10",
  businessToday: "2026-03-20",
  timeZone: "Africa/Lubumbashi",
  isHistorical: true,
} as FactoryNetPositionAsOf;

const ready = (rows: Array<Record<string, unknown>>) => ({
  ready: true as const,
  baselineAt: "2026-01-01T00:00:00Z",
  rows: new Map(rows.map((row, i) => [Number(row.id ?? i + 1), row])),
});

function containerRow(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "IN_TRANSIT",
    currency_code: "USD",
    total_kg: "100",
    rate_per_kg: "1",
    final_payable_amount: null,
    freight: null,
    commission_amount: null,
    other_charges: null,
    ...extra,
  };
}

describe("recordedOtwAt", () => {
  beforeEach(() => history.load.mockReset());

  it("returns null until every source table has a recorded baseline", async () => {
    history.load.mockImplementation(async (table: string) =>
      table === "factory_raw_stock" ? { ready: false, reason: "HISTORICAL_ROW_HISTORY_PRE_BASELINE" } : ready([])
    );
    expect(await recordedOtwAt(7, scope, () => 1)).toBeNull();
    expect(history.load).toHaveBeenCalledWith("factory_containers", 7, scope);
  });

  it("values recorded containers not received by the cutoff, converting each currency", async () => {
    const containers = [
      containerRow(1),
      containerRow(2, { currency_code: "CFA", rate_per_kg: "600", freight: "50", freight_currency_code: "USD" }),
      containerRow(3),
      containerRow(4),
      containerRow(5, { deleted_at: "2026-03-01" }),
      containerRow(6, {
        status: "OFFLOADED",
        pre_offload_status: "IN_TRANSIT",
        commission_currency_code: "USD",
        pre_offload_freight: "10",
        pre_offload_freight_currency_code: "USD",
        pre_offload_commission_amount: "2",
        pre_offload_commission_currency_code: "USD",
        pre_offload_other_charges: "1",
      }),
      containerRow(7, { status: "OFFLOADED" }),
    ];
    const receipts = [
      { id: 1, container_id: 3, receipt_date: "2026-03-05" },
      { id: 2, container_id: 1, receipt_date: "2026-03-15" },
      { id: 3, container_id: 1, receipt_date: "2026-03-01", deleted_at: "2026-03-02" },
    ];
    const stock = [
      { id: 1, container_id: 4, offloaded_at: "2026-03-09 21:30:00" },
      { id: 2, container_id: 1, offloaded_at: null, created_at: "2026-03-10T22:30:00Z" },
      { id: 3, container_id: 2, offloaded_at: null, created_at: null },
      { id: 4, container_id: 2, offloaded_at: "2026-03-01 00:00:00", deleted_at: "2026-03-02" },
    ];
    history.load.mockImplementation(async (table: string) =>
      ready(table === "factory_containers" ? containers : table === "factory_container_receipts" ? receipts : stock)
    );
    const fx = vi.fn((currency: string) => (currency === "CFA" ? 0.002 : 1));
    const result = await recordedOtwAt(7, scope, fx);
    // #1: 100 (its raw row lands on 11 March in Lubumbashi). #2: 60000 CFA = 120 + 50 USD freight.
    // #6: 100 goods + 10 + 2 + 1 snapshot charges. #7: 100 goods, status history missing.
    expect(result).toEqual({
      value: 100 + 120 + 50 + 113 + 100,
      warnings: ["HISTORICAL_OTW_STATUS_HISTORY_MISSING", "HISTORICAL_OTW_CHARGES_UNVERSIONED"],
    });
    expect(fx).toHaveBeenCalledWith("CFA");
  });

  it("refuses a raw-stock row whose offload timestamp cannot be read", async () => {
    history.load.mockImplementation(async (table: string) =>
      ready(table === "factory_raw_stock" ? [{ id: 1, container_id: 1, offloaded_at: "not a time" }] : [])
    );
    await expect(recordedOtwAt(7, scope, () => 1)).rejects.toThrow("HISTORICAL_RAW_OFFLOAD_TIMESTAMP_INVALID");
  });
});
