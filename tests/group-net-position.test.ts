import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getAllCompanies: vi.fn(),
  getCompanySettings: vi.fn(),
  getHistoricalCurrencyReadiness: vi.fn(),
  erpResponse: vi.fn(),
  intercompanyAccounts: vi.fn(),
}));

// Wave 13: intercompany accounts come from the recorded links (transfers, POS
// configuration, parent credit accounts, Intercompany-typed accounts); the
// focused test supplies them directly.
vi.mock("../server/helpers/groupIntercompany", () => ({
  loadCompanyIntercompanyAccounts: (company: { id: number }) => harness.intercompanyAccounts(company.id),
}));

vi.mock("../server/storage", () => ({
  storage: {
    getAllCompanies: harness.getAllCompanies,
    getCompanySettings: harness.getCompanySettings,
  },
}));

vi.mock("../server/services/accounting/historicalCurrencyReadiness", () => ({
  getHistoricalCurrencyReadiness: harness.getHistoricalCurrencyReadiness,
}));

// The real Group Net Position helper captures these same registered middleware
// and route handlers. Keep the focused test deterministic while proving that the
// current/live response wrappers are actually part of the group calculation.
vi.mock("../server/routes/stats/goldenCoastResidualEquityProjection", () => ({
  registerGoldenCoastResidualEquityProjection: (app: any) => {
    app.use("/api/stats/net-profit", async (_req: any, _res: any, next: any) => next());
  },
}));

vi.mock("../server/routes/stats/statsMultiCurrencyRoutes", () => ({
  registerStatsMultiCurrencyRoutes: (app: any) => {
    app.use(async (req: any, res: any, next: any) => {
      if (req.method !== "GET" || req.path !== "/api/stats/net-profit" || req.query.toDate) {
        return next();
      }
      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        const translatedCash = 25;
        return originalJson({
          ...body,
          forUsTotal: body.forUsTotal + translatedCash,
          netPosition: body.netPosition + translatedCash,
          forUs: {
            ...body.forUs,
            total: body.forUs.total + translatedCash,
            accounts: [
              ...body.forUs.accounts,
              {
                name: "Cash (Current Translation)",
                value: translatedCash,
                category: "Cash / Bank (Current Translation)",
              },
            ],
          },
        });
      };
      return next();
    });
  },
}));

vi.mock("../server/routes/stats/statsNetProfitRoutes", () => ({
  registerStatsNetProfitRoutes: (app: any) => {
    app.get(
      "/api/stats/net-profit",
      () => undefined,
      () => undefined,
      async (req: any, res: any) => {
        return res.json(harness.erpResponse(req));
      }
    );
  },
}));

import {
  calculateGroupNetPosition,
  GroupHistoricalCurrencyError,
  isGroupNetPositionCompany,
} from "../server/helpers/groupNetPosition";
import { getDatabaseScopeRuntimeContext } from "../server/services/security/databaseScopeRuntimeContext";

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
  asOfDate: "2026-09-10",
};

const baseResponse = (forUsTotal = 100, onUsTotal = 40, netPosition = forUsTotal - onUsTotal) => ({
  forUsTotal,
  onUsTotal,
  netPosition,
  netPositionLabel: netPosition >= 0 ? "Net Assets" : "Net Liabilities",
  forUs: {
    total: forUsTotal,
    accounts: [{ name: "Stock On The Way", value: forUsTotal, category: "Stock OTW" }],
  },
  onUs: {
    total: onUsTotal,
    accounts: [{ name: "Liability", value: onUsTotal, category: "Liability" }],
  },
});

describe("Group Net Position", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.getCompanySettings.mockResolvedValue({});
    harness.getHistoricalCurrencyReadiness.mockResolvedValue(ready);
    harness.erpResponse.mockImplementation(() => baseResponse());
    harness.intercompanyAccounts.mockResolvedValue([]);
  });

  it("includes normal active companies while excluding Supplier Partner, Factory, and JNAH", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 1, code: "HADI", name: "HADI", companyType: "erp", active: true },
      { id: 2, code: "PROP", name: "Properties", companyType: "properties", active: true },
      { id: 3, code: "FAC", name: "Factory", companyType: "factory", active: true },
      { id: 4, code: "FAC2", name: "Factory V2", companyType: "factory_v2", active: true },
      { id: 5, code: "GC", name: "GC - LSHI", companyType: "supplier_partner", active: true },
      { id: 6, code: "OLD", name: "Inactive", companyType: "erp", active: false },
      { id: 7, code: "JNAH", name: "POS - الجناح", companyType: "erp", active: true },
    ]);

    const result = await calculateGroupNetPosition("2026-09-10");

    expect(harness.erpResponse).toHaveBeenCalledTimes(2);
    expect(result.companies.map((company) => company.companyName)).toEqual(["HADI", "Properties"]);
    expect(result.excludedCompanyTypes).toEqual(["factory", "factory_v2", "supplier_partner"]);
    expect(result.companyCount).toBe(2);
  });

  it("uses the live ERP Net Position pipeline for the current date", async () => {
    harness.getAllCompanies.mockResolvedValue([{ id: 7, code: "BE", name: "Beira", companyType: "erp", active: true }]);
    harness.erpResponse.mockReturnValue(baseResponse(100, 40));

    const result = await calculateGroupNetPosition("2026-09-10", undefined, true);

    expect(harness.erpResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { currentCompanyId: 7 },
        query: {},
        path: "/api/stats/net-profit",
      })
    );
    expect(result.companies[0]).toMatchObject({
      forUsTotal: 125,
      onUsTotal: 40,
      netPosition: 85,
    });
    expect(result.companies[0].forUsLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Cash (Current Translation)",
          value: 25,
          category: "Cash / Bank (Current Translation)",
        }),
      ])
    );
  });

  it("keeps older as-of dates on the historical ERP snapshot", async () => {
    harness.getAllCompanies.mockResolvedValue([{ id: 7, code: "BE", name: "Beira", companyType: "erp", active: true }]);
    harness.erpResponse.mockReturnValue(baseResponse(100, 40));

    const result = await calculateGroupNetPosition("2026-09-01", undefined, false);

    expect(harness.erpResponse).toHaveBeenCalledWith(expect.objectContaining({ query: { toDate: "2026-09-01" } }));
    expect(result.companies[0]).toMatchObject({
      forUsTotal: 100,
      onUsTotal: 40,
      netPosition: 60,
    });
  });

  it("intersects companies with the caller access allowlist before readiness or calculations", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 1, code: "A", name: "Alpha", companyType: "erp", active: true },
      { id: 2, code: "B", name: "Beta", companyType: "erp", active: true },
    ]);

    const result = await calculateGroupNetPosition("2026-09-10", new Set([2]));

    expect(result.companyCount).toBe(1);
    expect(result.companies[0].companyId).toBe(2);
    expect(harness.getHistoricalCurrencyReadiness).toHaveBeenCalledTimes(1);
    expect(harness.getHistoricalCurrencyReadiness).toHaveBeenCalledWith(2, "2026-09-10");
    expect(harness.erpResponse).toHaveBeenCalledTimes(1);
    expect(harness.erpResponse.mock.calls[0][0].session.currentCompanyId).toBe(2);
  });

  it("loads every company under that company's own database scope", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 1, code: "A", name: "Alpha", companyType: "erp", active: true },
      { id: 2, code: "B", name: "Beta", companyType: "erp", active: true },
    ]);

    harness.getHistoricalCurrencyReadiness.mockImplementation(async (companyId: number) => {
      expect(getDatabaseScopeRuntimeContext()).toMatchObject({ kind: "tenant", companyId });
      return ready;
    });
    harness.erpResponse.mockImplementation((req: any) => {
      const scope = getDatabaseScopeRuntimeContext();
      const scopedCompanyId = scope?.kind === "tenant" ? scope.companyId : 0;
      if (scopedCompanyId !== req.session.currentCompanyId) return baseResponse(0, 0);
      return req.session.currentCompanyId === 1 ? baseResponse(100, 40) : baseResponse(80, 30);
    });

    const result = await calculateGroupNetPosition("2026-09-10");

    expect(result.companies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyId: 1, forUsTotal: 100, onUsTotal: 40, netPosition: 60 }),
        expect.objectContaining({ companyId: 2, forUsTotal: 80, onUsTotal: 30, netPosition: 50 }),
      ])
    );
  });

  // Wave 13 (owner decision 1): this test used to pin the name/code exclusion
  // ("<Subsidiary> Credit", IC-TO-*, the HMD Lebanon credit removed everywhere
  // except at HADI L'SHI). Nothing configures the HMD account as a pair, so it
  // is now an ordinary account on both sides; the recorded intercompany
  // accounts are eliminated in pairs and the mismatch is shown.
  it("eliminates recorded intercompany accounts in pairs and shows the unmatched difference", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 1, code: "HADI", name: "HADI L'SHI", companyType: "erp", active: true, parentCompanyId: null },
      { id: 2, code: "B", name: "Beta", companyType: "erp", active: true, parentCompanyId: 1 },
    ]);
    harness.getCompanySettings.mockImplementation(async (companyId: number) =>
      companyId === 2 ? { parentCreditAccountId: 501 } : {}
    );
    harness.erpResponse.mockImplementation((req: any) => {
      if (req.session.currentCompanyId === 1) {
        return {
          ...baseResponse(250, 0, 250),
          forUs: {
            total: 250,
            accounts: [
              { id: 10, name: "Cash", code: "CASH", value: 100, category: "Cash" },
              { id: 900, name: "Beta Credit", code: "BETCRD", value: 75, category: "Asset" },
              { id: 901, name: "Inter-Company - Beta", code: "IC-TO-B", value: 25, category: "Asset" },
              {
                id: 902,
                name: "HMD INTERNATIONAL GROUP LEBANON CREDIT",
                code: "HMDCREDIT",
                value: 50,
                category: "Asset",
              },
            ],
          },
          onUs: { total: 0, accounts: [] },
        };
      }

      return {
        ...baseResponse(80, 140, -60),
        forUs: {
          total: 80,
          accounts: [{ id: 20, name: "Cash", code: "CASH", value: 80, category: "Cash" }],
        },
        onUs: {
          total: 140,
          accounts: [
            { id: 501, name: "HADI L'SHI Credit", code: "PARENT", value: 40, category: "Liability" },
            { id: 502, name: "BANK LOAN", code: "BANKLOAN", value: 50, category: "Loans" },
            {
              id: 503,
              name: "HMD INTERNATIONAL GROUP LEBANON CREDIT",
              code: "HMDCREDIT",
              value: 50,
              category: "Liability",
            },
          ],
        },
      };
    });

    harness.intercompanyAccounts.mockImplementation(async (companyId: number) =>
      companyId === 1
        ? [
            {
              companyId: 1,
              accountId: 900,
              accountName: "Beta Credit",
              counterpartyCompanyIds: [2],
              sources: ["parentCredit"],
              balance: "75.00",
            },
            {
              companyId: 1,
              accountId: 901,
              accountName: "Inter-Company - Beta",
              counterpartyCompanyIds: [2],
              sources: ["transfer"],
              balance: "25.00",
            },
          ]
        : [
            {
              companyId: 2,
              accountId: 501,
              accountName: "HADI L'SHI Credit",
              counterpartyCompanyIds: [1],
              sources: ["parentCredit"],
              balance: "-40.00",
            },
          ]
    );

    const result = await calculateGroupNetPosition("2026-09-10");
    const alpha = result.companies.find((company) => company.companyId === 1)!;
    const beta = result.companies.find((company) => company.companyId === 2)!;

    expect(alpha.forUsTotal).toBe(150);
    expect(alpha.forUsLines.map((line) => line.label)).toEqual(["Cash", "HMD INTERNATIONAL GROUP LEBANON CREDIT"]);
    expect(beta.onUsTotal).toBe(100);
    expect(beta.onUsLines.map((line) => line.label)).toEqual(["BANK LOAN", "HMD INTERNATIONAL GROUP LEBANON CREDIT"]);
    // Receivables 100 against the payable 40: 40 eliminated, 60 unmatched.
    expect(result.intercompany).toMatchObject({ mode: "paired-elimination", additionalElimination: 40 });
    expect(result.intercompany.pairs).toEqual([
      expect.objectContaining({
        companyIds: [1, 2],
        receivables: 100,
        payables: 40,
        difference: 60,
        status: "mismatched",
      }),
    ]);
    expect(result.intercompany.differences).toEqual([
      expect.objectContaining({ value: 60, side: "forUs", category: "Intercompany difference" }),
    ]);
    expect(result.totals).toMatchObject({
      forUsTotal: 290,
      onUsTotal: 100,
      netPosition: 190,
      netAdjustments: 0,
    });
  });

  it("blocks the full group snapshot when any included ERP company has unresolved historical FX data", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 8, code: "FX", name: "FX Company", companyType: "erp", active: true },
      { id: 9, code: "FAC", name: "Factory", companyType: "factory", active: true },
    ]);
    harness.getHistoricalCurrencyReadiness.mockResolvedValue({
      ...ready,
      ready: false,
      unresolvedEntryCount: 2,
      unresolvedVoucherCount: 1,
      sampleVoucherIds: [99],
    });

    await expect(calculateGroupNetPosition("2026-09-10")).rejects.toBeInstanceOf(GroupHistoricalCurrencyError);
    expect(harness.getHistoricalCurrencyReadiness).toHaveBeenCalledTimes(1);
    expect(harness.getHistoricalCurrencyReadiness).toHaveBeenCalledWith(8, "2026-09-10");
    expect(harness.erpResponse).not.toHaveBeenCalled();
  });

  it("derives company and group Net Position strictly from What We Have minus What We Owe", async () => {
    harness.getAllCompanies.mockResolvedValue([
      { id: 1, code: "A", name: "Alpha", companyType: "erp", active: true },
      { id: 2, code: "B", name: "Beta", companyType: "erp", active: true },
    ]);

    harness.erpResponse.mockImplementation((req: any) =>
      req.session.currentCompanyId === 1 ? baseResponse(100, 40, 60) : baseResponse(80, 30, 40)
    );

    const result = await calculateGroupNetPosition("2026-09-10");

    expect(result.totals.forUsTotal).toBe(180);
    expect(result.totals.onUsTotal).toBe(70);
    expect(result.totals.sideNetPosition).toBe(110);
    expect(result.totals.netAdjustments).toBe(0);
    expect(result.totals.netPosition).toBe(110);
    expect(result.companies.find((company) => company.companyId === 2)).toMatchObject({
      sideNetPosition: 50,
      netAdjustment: 0,
      netPosition: 50,
    });
    expect(result.intercompany.mode).toBe("paired-elimination");
    expect(result.intercompany.additionalElimination).toBe(0);
    expect(result.intercompany.differences).toEqual([]);
  });

  it("treats Properties as eligible while Supplier Partner and Factory remain ineligible", () => {
    expect(isGroupNetPositionCompany({ active: true, companyType: "erp" } as any)).toBe(true);
    expect(isGroupNetPositionCompany({ active: true, companyType: "retail" } as any)).toBe(true);
    expect(isGroupNetPositionCompany({ active: true, companyType: "supplier_partner" } as any)).toBe(false);
    expect(isGroupNetPositionCompany({ active: true, companyType: "factory" } as any)).toBe(false);
    expect(isGroupNetPositionCompany({ active: true, companyType: "factory_v2" } as any)).toBe(false);
    expect(isGroupNetPositionCompany({ active: true, companyType: "properties" } as any)).toBe(true);
    expect(isGroupNetPositionCompany({ active: true, companyType: "erp", code: "JNAH" } as any)).toBe(false);
    expect(isGroupNetPositionCompany({ active: false, companyType: "erp" } as any)).toBe(false);
  });
});
