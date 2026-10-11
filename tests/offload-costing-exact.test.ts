/**
 * Offload costing posts the commission total and the freight / other-charge USD
 * amounts as strings (String(x)) into the commission row and journal lines.
 * They were float products, so 1.1 freight at an FX rate of 3 posted as
 * 3.3000000000000003 USD.
 */
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/routes/factory/_helpers", () => ({
  getOrFetchFxRateToUsd: vi.fn(async () => "0.0016"),
  getOrCreateLedgerAccount: vi.fn(async () => 1),
}));

import { computeOffloadCosting, type OffloadCostingContext } from "../server/routes/factory/raw-stock/offloadCosting";

function ctx(overrides: Partial<OffloadCostingContext> = {}): OffloadCostingContext {
  return {
    companyId: 1,
    containerId: 7,
    container: { totalKg: "31000", costPerKg: "1.1", currencyCode: "USD", fxRateToUsd: "1" },
    currencyCode: "USD",
    fxRate: 1,
    offloadDate: "2026-10-01",
    declaredKg: "31000",
    dReceivedKg: new Decimal(31000),
    baseCostPerKg: "1.1",
    commission: null,
    freightVal: 0,
    otherChargesVal: 0,
    additionalChargesArr: [],
    dutyVal: 0,
    dutyStatus: "NONE",
    effectiveFreightSupplierId: null,
    ...overrides,
  };
}

describe("computeOffloadCosting exact amounts", () => {
  it("computes a per-kg commission total without float residue", async () => {
    const result = await computeOffloadCosting(
      ctx({
        declaredKg: "3",
        dReceivedKg: new Decimal(3),
        commission: { personName: "Agent", commissionRate: "0.1", commissionType: "PER_KG" } as never,
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commTotalVal).toBe(0.3);
    expect(result.commInsertValues?.commissionTotal).toBe("0.3");
  });

  it("converts freight and other charges to USD exactly", async () => {
    const result = await computeOffloadCosting(
      ctx({
        freightVal: 1.1,
        reqFreightCurrencyCode: "EUR",
        reqFreightFxRate: "3",
        otherChargesVal: 0.1,
        reqOtherChargesCurrencyCode: "EUR",
        reqOtherChargesFxRate: "3",
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.freightUsd).toBe(3.3);
    expect(result.ocUsd).toBe(0.3);
  });

  it("rejects a malformed freight FX rate", async () => {
    const result = await computeOffloadCosting(
      ctx({ freightVal: 100, reqFreightCurrencyCode: "EUR", reqFreightFxRate: "abc" })
    );
    expect(result).toMatchObject({ ok: false, httpStatus: 400 });
  });
});
