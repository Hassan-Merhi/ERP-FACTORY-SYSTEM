import { describe, expect, it } from "vitest";

import {
  canUseFactorySurface,
  factoryPageOwnsAccountsAllRead,
  factoryPageOwnsSharedAccountingRead,
} from "../client/src/lib/factoryClientAccess";
import type { FactoryMyAccess } from "../shared/apiTypes";

function access(overrides: Partial<FactoryMyAccess> = {}): FactoryMyAccess {
  return {
    fullAccess: false,
    pageKeys: ["factory/payroll-hub", "factory/stock-entry"],
    hasErpAccess: true,
    hasFactoryAccess: true,
    hiddenCostFields: [],
    hideAllCosts: false,
    companyId: 1,
    companyName: "Factory",
    ...overrides,
  };
}

describe("canUseFactorySurface", () => {
  it("fails closed until access is loaded", () => {
    expect(canUseFactorySurface(undefined, "factory/payroll-hub")).toBe(false);
  });

  it("allows full-access users regardless of hidden-tab rows", () => {
    expect(
      canUseFactorySurface(
        access({ fullAccess: true, hiddenCostFields: ["hide_tab_workers_report"] }),
        "factory/payroll-hub",
        ["hide_tab_workers_report"]
      )
    ).toBe(true);
  });

  it("requires the owning Factory page", () => {
    expect(canUseFactorySurface(access({ pageKeys: ["factory/stock-entry"] }), "factory/payroll-hub")).toBe(false);
  });

  it("requires every protected tab to remain visible", () => {
    expect(
      canUseFactorySurface(access({ hiddenCostFields: ["hide_tab_workers_payroll"] }), "factory/payroll-hub", [
        "hide_tab_payrollhub_workers",
        "hide_tab_workers_payroll",
      ])
    ).toBe(false);
  });

  it("allows a permitted page when all required tabs are visible", () => {
    expect(
      canUseFactorySurface(access(), "factory/stock-entry", ["hide_tab_stockentry_production_targets"])
    ).toBe(true);
  });
});

describe("Factory shared accounting ownership", () => {
  it("allows ledger/bank reads only from backend-owned Factory pages", () => {
    expect(factoryPageOwnsSharedAccountingRead("/factory/accounts")).toBe(true);
    expect(factoryPageOwnsSharedAccountingRead("/factory/invoicing?tab=proformas")).toBe(true);
    expect(factoryPageOwnsSharedAccountingRead("/factory/production-report")).toBe(false);
  });

  it("keeps /api/accounts/all stricter than ledger/bank picker reads", () => {
    expect(factoryPageOwnsAccountsAllRead("/factory/accounts")).toBe(true);
    expect(factoryPageOwnsAccountsAllRead("/factory/invoicing")).toBe(false);
    expect(factoryPageOwnsAccountsAllRead("/factory/stock-entry")).toBe(false);
  });
});
