import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getAllCompanies: vi.fn(),
  calculateNetPositionAsOf: vi.fn(),
  getHistoricalCurrencyReadiness: vi.fn(),
  loadNetProfitData: vi.fn(),
  projectGoldenCoastResidualEquity: vi.fn(),
  factoryResponse: vi.fn(),
}));

vi.mock("../server/storage", () => ({
  storage: {
    getAllCompanies: harness.getAllCompanies,
  },
}));

vi.mock("../server/helpers/calculateNetPositionAsOf", () => ({
  calculateNetPositionAsOf: harness.calculateNetPositionAsOf,
}));

vi.mock("../server/services/accounting/historicalCurrencyReadiness", () => ({
  getHistoricalCurrencyReadiness: harness.getHistoricalCurrencyReadiness,
}));

vi.mock("../server/routes/stats/netProfitDataLoad", () => ({
  loadNetProfitData: harness.loadNetProfitData,
}));

vi.mock("../server/routes/stats/goldenCoastResidualEquityProjection", () => ({
  projectGoldenCoastResidualEquity: harness.projectGoldenCoastResidualEquity,
}));

vi.mock("../server/routes/factory/employee-pos/employeeNetPositionRoutes", () => ({
  registerEmployeeNetPositionRoutes: (app: any) => {
    app.get("/api/factory/net-position", () => undefined, async (req: any, res: any) => {
      return res.json(harness.factoryResponse(req));
    });
  },
}));

import {
  calculateGroupNetPosition,
  GroupHistoricalCurrencyError,
  isGroupNetPositionCompany,
} from "../server/helpers/groupNetPosition";

const ready = {
  ready: true,
  unresolvedEntryCount: 0,
  unresolvedVoucherCount: 0,
  unresolvedLedgerOpeningCount: 0,
  unresolvedBankOpeningCount: 0,
  unresolvedCustomerOpeningCount: 0,
  unresolvedSupplierOpeningCount: 0,
  unresolvedEmployeeOpeningCount: 0,
  unresolvedFixedAssetCount: 0,
  sampleVoucherIds: [],
  asOfDate: "2026-09-09",
};

const baseSnapshot = (forUsTotal = 100, onUsTotal = 40) => ({
  forUsTotal,
  onUsTotal,
  netPosition: forUsTotal - onUsTotal,
  netPositionLabel: "We Have More",
  forUsLines: [{ label: "Cash", value: forUsTotal, category: "Cash", side: "forUs" }],
  onUsLines: [{ label: "Loan", value: onUsTotal, category: "Loan", side: "onUs" }],
});

describe("Group Net Position", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.getHistoricalCurrencyReadiness.mockResolvedValue(ready);
    harness.calculateNetPositionAsOf.mockResolvedValue(baseSnapshot());
    harness.loadNetProfitData.mockResolvedValue({
      companyAccounts: [],
      accountBalances: new Map(),
    });
    harness.projectGoldenCoastResidualEquity.mockImplementation(({ body }: any) => body);
    harness.factoryResponse.mockReturnValue({
      forUsTotal: 250,
      onUsTotal: 75,
      netPosition: 175,
      netPositionLabel: "We have more than we owe",
      forUs: { accounts: [{ name: "Factory Stock", value: 250, category: "Inventory" }] },
      onUs: { accounts: [{ name: "Factory Payables", value: 75, category: "Liability" }] },
    });
  });

  it("excludes Properties and inactive companies before calculating", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 1, code: "HADI", name: "HADI", companyType: "erp", active: true },
      { id: 2, code: "PROP", name: "Properties", companyType: "properties", active: true },
      { id: 3, code: "OLD", name: "Inactive", companyType: "erp", active: false },
      { id: 4, code: "ERP2", name: "Second ERP", companyType: "erp", active: true },
    ]);

    harness.calculateNetPositionAsOf.mockImplementation(async (companyId: number) =>
      companyId === 1 ? baseSnapshot(100, 40) : baseSnapshot(80, 30),
    );

    const result = await calculateGroupNetPosition("2026-09-09");

    expect(harness.calculateNetPositionAsOf).toHaveBeenCalledTimes(2);
    expect(harness.calculateNetPositionAsOf).toHaveBeenCalledWith(1, "2026-09-09");
    expect(harness.calculateNetPositionAsOf).toHaveBeenCalledWith(4, "2026-09-09");
    expect(result.companies.map((company) => company.companyName)).toEqual(["HADI", "Second ERP"]);
    expect(result.excludedCompanyTypes).toEqual(["properties"]);
  });

  it("intersects companies with the caller access allowlist before readiness or calculations", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 1, code: "A", name: "Alpha", companyType: "erp", active: true },
      { id: 2, code: "B", name: "Beta", companyType: "erp", active: true },
    ]);

    const result = await calculateGroupNetPosition("2026-09-09", new Set([2]));

    expect(result.companyCount).toBe(1);
    expect(result.companies[0].companyId).toBe(2);
    expect(harness.getHistoricalCurrencyReadiness).toHaveBeenCalledTimes(1);
    expect(harness.getHistoricalCurrencyReadiness).toHaveBeenCalledWith(2, "2026-09-09");
    expect(harness.calculateNetPositionAsOf).toHaveBeenCalledTimes(1);
    expect(harness.calculateNetPositionAsOf).toHaveBeenCalledWith(2, "2026-09-09");
  });

  it("blocks the full group snapshot when any included company has unresolved historical FX data", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 7, code: "FX", name: "FX Company", companyType: "erp", active: true },
    ]);
    harness.getHistoricalCurrencyReadiness.mockResolvedValue({
      ...ready,
      ready: false,
      unresolvedEntryCount: 2,
      unresolvedVoucherCount: 1,
      sampleVoucherIds: [99],
    });

    await expect(calculateGroupNetPosition("2026-09-09")).rejects.toBeInstanceOf(GroupHistoricalCurrencyError);
    expect(harness.calculateNetPositionAsOf).not.toHaveBeenCalled();
  });

  it("delegates factory companies to the existing factory Net Position calculation", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 9, code: "FAC", name: "Factory", companyType: "factory", active: true },
    ]);

    const result = await calculateGroupNetPosition("2026-09-09");

    expect(harness.calculateNetPositionAsOf).not.toHaveBeenCalled();
    expect(harness.factoryResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ factoryCompanyId: 9, currentCompanyId: 9 }),
        query: { asOf: "2026-09-09" },
      }),
    );
    expect(result.companies[0]).toMatchObject({
      companyId: 9,
      forUsTotal: 250,
      onUsTotal: 75,
      netPosition: 175,
    });
    expect(result.companies[0].forUsLines[0].label).toBe("Factory Stock");
  });

  it("passes supplier-partner values through the Golden Coast residual-equity projection", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 4, code: "GC", name: "Golden Coast", companyType: "supplier_partner", active: true },
    ]);
    harness.calculateNetPositionAsOf.mockResolvedValue(baseSnapshot(80, 30));
    harness.loadNetProfitData.mockResolvedValue({
      companyAccounts: [{ id: 44, name: "Cash" }, { id: 45, name: "Loan" }],
      accountBalances: new Map([[44, { debit: 80, credit: 0 }]]),
    });
    harness.projectGoldenCoastResidualEquity.mockImplementation(({ body }: any) => ({
      ...body,
      forUs: { ...body.forUs, total: 120, accounts: body.forUs.accounts },
      onUs: { ...body.onUs, total: 30, accounts: body.onUs.accounts },
      forUsTotal: 120,
      onUsTotal: 30,
      netPosition: 90,
      netPositionLabel: "Net Assets",
    }));

    const result = await calculateGroupNetPosition("2026-09-09");

    expect(harness.loadNetProfitData).toHaveBeenCalledWith(4, "2026-09-09");
    expect(harness.projectGoldenCoastResidualEquity).toHaveBeenCalledTimes(1);
    const projectionArg = harness.projectGoldenCoastResidualEquity.mock.calls[0][0];
    expect(projectionArg.body.forUs.accounts[0]).toMatchObject({ id: 44, name: "Cash", value: 80 });
    expect(result.companies[0]).toMatchObject({
      forUsTotal: 120,
      onUsTotal: 30,
      netPosition: 90,
      netAdjustment: 0,
    });
  });

  it("reconciles group totals to the sum of the exact per-company Net Position values", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 1, code: "A", name: "Alpha", companyType: "erp", active: true },
      { id: 2, code: "B", name: "Beta", companyType: "erp", active: true },
    ]);

    harness.calculateNetPositionAsOf.mockImplementation(async (companyId: number) => {
      if (companyId === 1) return baseSnapshot(100, 40);
      return {
        ...baseSnapshot(80, 30),
        netPosition: 40,
      };
    });

    const result = await calculateGroupNetPosition("2026-09-09");

    expect(result.totals.forUsTotal).toBe(180);
    expect(result.totals.onUsTotal).toBe(70);
    expect(result.totals.sideNetPosition).toBe(110);
    expect(result.totals.netAdjustments).toBe(-10);
    expect(result.totals.netPosition).toBe(100);
    expect(result.companies.find((company) => company.companyId === 2)?.netAdjustment).toBe(-10);
    expect(result.intercompany.mode).toBe("already-excluded");
    expect(result.intercompany.additionalElimination).toBe(0);
  });

  it("treats active non-Properties company types as eligible", () => {
    expect(isGroupNetPositionCompany({ active: true, companyType: "erp" } as any)).toBe(true);
    expect(isGroupNetPositionCompany({ active: true, companyType: "factory" } as any)).toBe(true);
    expect(isGroupNetPositionCompany({ active: true, companyType: "supplier_partner" } as any)).toBe(true);
    expect(isGroupNetPositionCompany({ active: true, companyType: "properties" } as any)).toBe(false);
    expect(isGroupNetPositionCompany({ active: false, companyType: "erp" } as any)).toBe(false);
  });
});
