/**
 * Offload freight / other-charges expense accounts (2026-10 accounting audit,
 * wave 4). Costing resolved the expense account only on the supplier path, so an
 * own-account freight or other charge was posted with an expense line on no
 * account (13 such lines in production, about 39k of freight expense missing
 * from every balance).
 */
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";

const created: string[] = [];
vi.mock("../server/routes/factory/_helpers", () => ({
  getOrFetchFxRateToUsd: async () => "1",
  getOrCreateLedgerAccount: async (_companyId: number, code: string) => {
    created.push(code);
    return { FACTORY_CHARGES_PAYABLE: 10, FACTORY_FREIGHT_EXPENSE: 20, FACTORY_OC_EXPENSE: 30 }[code] ?? 99;
  },
}));
vi.mock("../server/services/factory/containerLandedCost", () => ({
  computeContainerLandedCost: () => ({
    fxUnresolved: false,
    costPerKg: "1",
    costPerKgUsd: "1",
    fullCost: "100",
    fullCostUsd: "100",
  }),
}));

import { computeOffloadCosting, type OffloadCostingContext } from "../server/routes/factory/raw-stock/offloadCosting";

const base: OffloadCostingContext = {
  companyId: 1,
  containerId: 2,
  container: { totalKg: "100" },
  currencyCode: "USD",
  fxRate: 1,
  offloadDate: "2026-10-01",
  declaredKg: "100",
  dReceivedKg: new Decimal(100),
  baseCostPerKg: "1",
  commission: null,
  freightVal: 0,
  otherChargesVal: 0,
  additionalChargesArr: [],
  dutyVal: 0,
  dutyStatus: "NONE",
  effectiveFreightSupplierId: null,
};

async function accounts(ctx: Partial<OffloadCostingContext>) {
  const result = await computeOffloadCosting({ ...base, ...ctx });
  if (!result.ok) throw new Error(result.body.message);
  return { freight: result.freightExpenseAcctId, oc: result.ocExpenseAcctId };
}

describe("offload costing expense accounts", () => {
  it("resolves the system expense account for own-account freight and other charges", async () => {
    expect(
      await accounts({ freightVal: 500, reqFreightAccountId: "7", otherChargesVal: 40, reqOtherChargesAccountId: "8" })
    ).toEqual({ freight: 20, oc: 30 });
  });

  it("uses the chosen expense account on the supplier path", async () => {
    expect(
      await accounts({
        freightVal: 500,
        effectiveFreightSupplierId: 5,
        reqFreightAccountId: "7",
        otherChargesVal: 40,
        reqOtherChargesSupplierId: "6",
        reqOtherChargesAccountId: "8",
      })
    ).toEqual({ freight: 7, oc: 8 });
  });

  it("falls back to the system expense account on the supplier path without a chosen account", async () => {
    expect(await accounts({ freightVal: 500, effectiveFreightSupplierId: 5 })).toEqual({ freight: 20, oc: null });
  });

  it("resolves nothing when there is no amount", async () => {
    expect(await accounts({})).toEqual({ freight: null, oc: null });
  });
});
