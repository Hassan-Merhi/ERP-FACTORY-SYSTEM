/**
 * The unified accounting dashboard: date and period checks, booked net
 * position and class breakdowns from the statement package, and the
 * operational stock memo — its GL comparisons, withheld cases and warnings.
 * The statements, valuations, cutover, scope and business date are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  scope: vi.fn(),
  businessDate: vi.fn(),
  statements: vi.fn(),
  current: vi.fn(),
  asOf: vi.fn(),
  factory: vi.fn(),
  cutover: vi.fn(),
}));
vi.mock("../server/services/security/transactionCompanyScope", () => ({
  assertTransactionCompanyScope: (...a: unknown[]) => h.scope(...a),
}));
vi.mock("../server/services/accounting/companyBusinessDate", () => ({
  companyBusinessDate: (...a: unknown[]) => h.businessDate(...a),
}));
vi.mock("../server/services/accounting/professionalFinancialStatements", () => ({
  professionalFinancialStatementsTx: (...a: unknown[]) => h.statements(...a),
}));
vi.mock("../server/services/inventory/stockValuation", () => ({
  companyStockValuation: (...a: unknown[]) => h.current(...a),
  companyStockValuationAsOf: (...a: unknown[]) => h.asOf(...a),
}));
vi.mock("../server/services/accounting/perpetualInventory/factoryValuation", () => ({
  factoryStockValuation: (...a: unknown[]) => h.factory(...a),
}));
vi.mock("../server/services/accounting/perpetualInventory/cutover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/accounting/perpetualInventory/cutover")>()),
  getInventoryCutover: (...a: unknown[]) => h.cutover(...a),
}));

import Decimal from "decimal.js";
import { unifiedAccountingDashboardTx } from "../server/services/accounting/unifiedAccountingDashboard";
import { PERPETUAL_INVENTORY_POSTING_READY } from "../server/services/accounting/perpetualInventory/cutover";

type Line = Record<string, unknown>;
const section = (totalUsd: string, lines: Line[] = []) => ({ totalUsd, lines });
const ledger = (code: string, amountUsd: string, accountType = "Asset"): Line => ({
  kind: "ledger",
  code,
  accountType,
  amountUsd,
});

function statement() {
  return {
    current: {
      financialPosition: {
        assets: section("1000.00", [
          ledger("INVENTORY", "300.00"),
          ledger("factory_raw_material_stock", "50.00"),
          ledger("FACTORY_WIP", "20.00"),
          ledger("FACTORY_FINISHED_GOODS", "30.00"),
          ledger("GOODS_IN_TRANSIT", "10.00"),
          { kind: "bank", amountUsd: "200.00" },
          ledger("1000", "40.00", "Cash"),
          { kind: "customer", amountUsd: "150.004" },
          { kind: "employee", amountUsd: "5.00" },
          { kind: "fixedAsset", amountUsd: "100.00" },
          ledger("1500", "60.00", "Fixed Assets"),
          ledger("1600", "34.996", "Prepaid"),
          { kind: "supplier", code: "INVENTORY", amountUsd: "0" },
        ]),
        liabilities: section("400.00", [
          ledger("INVENTORY", "-5.00", "Liability"),
          ledger("2000", "15.00", "Bank"),
          { kind: "supplier", amountUsd: "300.00" },
          ledger("2100", "90.00", "Liability"),
        ]),
        totalEquityIncludingEarningsUsd: "599.995",
        reportedBalanceSheetDifferenceUsd: "0.00",
        assetsMinusLiabilitiesAndEquityUsd: "0.01",
        unclassified: { totalUsd: "1.00" },
        balanced: true,
      },
      profitAndLoss: {
        revenue: section("900.00", [
          { kind: "ledger", amountUsd: "100" },
          { kind: "ledger", amountUsd: "-800" },
        ]),
        otherIncome: section("10.00"),
        costOfSales: section("500.00"),
        operatingExpenses: section(
          "200.00",
          Array.from({ length: 10 }, (_, i) => ({ kind: "ledger", code: `E${i}`, amountUsd: String(i + 1) }))
        ),
        grossProfitUsd: "400.00",
        periodNetResultUsd: "210.00",
      },
      controls: {
        trialBalanceBalanced: true,
        trialBalanceDifferenceUsd: "0.00",
        blockers: ["blocker"],
        warnings: ["warning"],
        unknownAccounts: [{ id: 1 }],
      },
      cashFlow: { actualCashMovementUsd: "12.00", cashFlowClassificationDifferenceUsd: "0.50" },
    },
    disclosure: { basis: "Disclosure one" },
  };
}

const valuation = (over: Record<string, unknown> = {}) => ({
  total: "310.00",
  subLedgerTotal: "300.00",
  excluded: { shortageValue: "1.00", unitemizedMovementValue: "0", anomalousRows: 0 },
  locations: [{}, {}],
  ...over,
});
const factory = (unvalued: unknown[] = []) => ({
  raw: new Decimal("50"),
  wip: new Decimal("19.995"),
  finished: new Decimal("30"),
  unvalued,
  reservedForOrders: { bales: 2, cost: "8.00" },
  soldNotInvoiced: { bales: 1, cost: "4.00" },
});

const tx = {} as never;
const input = (over: Record<string, unknown> = {}) => ({
  companyId: 3,
  fromDate: "2026-01-01",
  asOfDate: "2026-10-30",
  valuationBasis: "cost" as const,
  includeOperational: true,
  ...over,
});
const dashboard = (over: Record<string, unknown> = {}) => unifiedAccountingDashboardTx(tx, input(over));
const rowFor = (out: Awaited<ReturnType<typeof dashboard>>, code: string) =>
  out.operations.glToOperationalAtCost.find((r) => r.accountCode === code);

beforeEach(() => {
  h.scope.mockReset().mockResolvedValue(undefined);
  h.businessDate.mockReset().mockResolvedValue("2026-10-30");
  h.statements.mockReset().mockImplementation(async () => statement());
  h.current.mockReset().mockResolvedValue(valuation());
  h.asOf.mockReset().mockResolvedValue(valuation({ total: "250.00", subLedgerTotal: "240.00" }));
  h.factory.mockReset().mockResolvedValue(factory());
  h.cutover.mockReset().mockResolvedValue({ status: "ACTIVE", effectiveFrom: "2026-01-01", openingVoucherId: 77 });
});

describe("input checks", () => {
  it("refuses bad companies, dates and periods", async () => {
    for (const companyId of [0, -1, 1.5]) {
      await expect(dashboard({ companyId })).rejects.toThrow("DASHBOARD_COMPANY_INVALID");
    }
    expect(h.scope).not.toHaveBeenCalled();
    await expect(dashboard({ fromDate: "2026-02-30" })).rejects.toThrow();
    await expect(dashboard({ fromDate: "2026-11-01" })).rejects.toThrow("DASHBOARD_PERIOD_INVALID");
    await expect(dashboard({ asOfDate: "2026-10-31" })).rejects.toThrow("DASHBOARD_PERIOD_INVALID");
    expect(h.statements).not.toHaveBeenCalled();
    await expect(dashboard({ fromDate: "2026-10-30" })).resolves.toMatchObject({ fromDate: "2026-10-30" });
    expect(h.statements).toHaveBeenCalledWith(tx, {
      companyId: 3,
      fromDate: "2026-10-30",
      asOfDate: "2026-10-30",
      compare: false,
    });
  });
});

describe("booked figures", () => {
  it("reports the posted position, class breakdowns, performance and drilldowns", async () => {
    const out = await dashboard({ includeOperational: false });
    expect(out).toMatchObject({
      companyId: 3,
      currency: "USD",
      presentation: "STANDALONE_BOOKED_NOT_GROUP_CONSOLIDATED",
      reportStatus: "PROVISIONAL_NOT_CERTIFIED",
    });
    expect(out.financialPosition).toEqual({
      assetsUsd: "1000.00",
      liabilitiesUsd: "400.00",
      netAssetsUsd: "600.00",
      equityIncludingEarningsUsd: "600.00",
      reportedBalanceSheetDifferenceUsd: "0.00",
      unexplainedDifferenceUsd: "0.01",
      trialBalanceDifferenceUsd: "0.00",
      cashAndBanksUsd: "225.00",
      liabilitiesAndEquityUsd: "1000.00",
      assetClasses: {
        cash_and_banks: "240.00",
        customer_and_party: "155.00",
        recognized_inventory: "410.00",
        fixed_assets: "160.00",
        other: "35.00",
      },
      liabilityClasses: {
        cash_and_banks: "15.00",
        customer_and_party: "300.00",
        recognized_inventory: "-5.00",
        fixed_assets: "0.00",
        other: "90.00",
      },
      unclassifiedUsd: "1.00",
      unclassifiedAccounts: [{ id: 1 }],
      isBalanced: true,
    });
    expect(out.performance).toEqual({
      salesRevenueUsd: "900.00",
      otherIncomeUsd: "10.00",
      costOfSalesUsd: "500.00",
      operatingExpensesUsd: "200.00",
      grossProfitUsd: "400.00",
      netProfitUsd: "210.00",
      recognizedCashMovementUsd: "12.00",
      cashFlowClassificationDifferenceUsd: "0.50",
      periodBasis: "POSTED_PERIOD_FROM_THROUGH_AS_OF",
    });
    expect(out.controls).toEqual({
      certified: false,
      trialBalanceBalanced: true,
      historicalMasterValuesUnversioned: true,
      bookedFiguresDoNotContainUnpostedOperationalAssets: true,
      cashFlowClassificationCertified: false,
      perpetualPostingGloballyReady: PERPETUAL_INVENTORY_POSTING_READY,
      blockers: ["blocker"],
      warnings: ["warning"],
    });
    // Stock GL assets (410) less stock contra liabilities (-5).
    expect(out.operations.bookedStockAssetUsd).toBe("415.00");
    expect(out.drilldown.topRevenueAccounts.map((l) => l.amountUsd)).toEqual(["-800", "100"]);
    expect(out.drilldown.topExpenses.map((l) => l.code)).toEqual(["E9", "E8", "E7", "E6", "E5", "E4", "E3", "E2"]);
    expect(out.drilldown.topAssetAccounts).toHaveLength(8);
    expect(out.disclosures[0]).toBe("Disclosure one");
    expect(out.disclosures).toHaveLength(4);
  });

  it("does not load operational stock unless asked", async () => {
    const out = await dashboard({ includeOperational: false });
    expect(h.cutover).not.toHaveBeenCalled();
    expect(h.factory).not.toHaveBeenCalled();
    expect(out.operations).toMatchObject({
      perpetualStockLedgerActiveAsOf: false,
      cutover: null,
      erpStock: null,
      factoryStock: null,
      glToOperationalAtCost: [],
      managementCostCandidateUsd: null,
      managementCostCandidateBasis: "NOT_LOADED",
      completeness: {
        factoryHistoricalValuationAvailable: true,
        erpHistoricalValuationAvailable: false,
        stockCostFullyValued: false,
      },
    });
    expect(out.operations.warnings.at(-1)).toContain("Operational stock comparison not loaded");
  });
});

describe("operational stock memo", () => {
  it("compares current operational cost with posted stock under an active cutover", async () => {
    const out = await dashboard();
    expect(h.current).toHaveBeenCalledWith(tx, 3);
    expect(h.asOf).not.toHaveBeenCalled();
    expect(out.operations).toMatchObject({
      requestedValuationBasis: "cost",
      perpetualStockLedgerActiveAsOf: true,
      cutover: { effectiveFrom: "2026-01-01", openingVoucherId: 77 },
      erpStock: {
        costUsd: "310.00",
        subLedgerSignedUsd: "300.00",
        asOfBasis: "current",
        shortageValueUsd: "1.00",
        unitemizedMovementValueUsd: "0",
        anomalousRows: 0,
        locations: 2,
      },
      factoryStock: {
        rawUsd: "50.00",
        wipUsd: "20.00",
        finishedUsd: "30.00",
        totalUsd: "100.00",
        unvaluedCount: 0,
        unvaluedSample: [],
        reservedForOrders: { bales: 2, cost: "8.00" },
        soldNotInvoiced: { bales: 1, cost: "4.00" },
        basis: "CURRENT_COST_ONLY",
      },
      managementCostCandidateUsd: "410.00",
      managementCostCandidateBasis: "CURRENT_COST_MEMO",
      completeness: { stockCostFullyValued: true, erpHistoricalValuationAvailable: true },
      operationalAmountsAddedToBookedNetAssets: false,
    });
    expect(out.operations.glToOperationalAtCost).toEqual([
      {
        accountCode: "INVENTORY",
        bookedGlUsd: "305.00",
        operationalCostUsd: "300.00",
        differenceUsd: "5.00",
        comparable: true,
        reason: "Recorded operational cost and posted stock asset as of report date",
      },
      expect.objectContaining({
        accountCode: "FACTORY_RAW_MATERIAL_STOCK",
        bookedGlUsd: "50.00",
        differenceUsd: "0.00",
      }),
      expect.objectContaining({ accountCode: "FACTORY_WIP", bookedGlUsd: "20.00", differenceUsd: "0.00" }),
      expect.objectContaining({ accountCode: "FACTORY_FINISHED_GOODS", differenceUsd: "0.00", comparable: true }),
      {
        accountCode: "GOODS_IN_TRANSIT",
        bookedGlUsd: "10.00",
        operationalCostUsd: null,
        differenceUsd: null,
        comparable: false,
        reason: "No reliable matching operational Goods in Transit cost value in this report",
      },
      expect.objectContaining({ accountCode: "FACTORY_GOODS_IN_TRANSIT", bookedGlUsd: "0.00", comparable: false }),
    ]);
    expect(out.operations.warnings.at(-1)).toContain("A company inventory cutover is active as of this date");
  });

  it("treats a missing, inactive or later cutover as periodic inventory", async () => {
    for (const cutover of [
      null,
      { status: "DRAFT", effectiveFrom: "2026-01-01", openingVoucherId: null },
      { status: "ACTIVE", effectiveFrom: "2026-10-31", openingVoucherId: 1 },
    ]) {
      h.cutover.mockResolvedValueOnce(cutover);
      const out = await dashboard();
      expect(out.operations.perpetualStockLedgerActiveAsOf).toBe(false);
      expect(rowFor(out, "INVENTORY")).toMatchObject({
        comparable: false,
        differenceUsd: null,
        reason: "Periodic inventory: operational cost is not required to equal a perpetual GL account",
      });
      expect(out.operations.warnings.at(-1)).toContain("no active perpetual-inventory cutover");
      // The current-cost memo does not depend on the cutover.
      expect(out.operations.managementCostCandidateBasis).toBe("CURRENT_COST_MEMO");
    }
    h.cutover.mockResolvedValueOnce(null);
    expect((await dashboard()).operations.cutover).toBeNull();
  });

  it("withholds comparisons for unvalued Factory cost and anomalous ERP rows", async () => {
    const unvalued = Array.from({ length: 16 }, (_, i) => ({ source: "bale", id: i, reason: "no cost", extra: 1 }));
    h.factory.mockResolvedValueOnce(factory(unvalued));
    const out = await dashboard();
    expect(out.operations.factoryStock?.unvaluedCount).toBe(16);
    expect(out.operations.factoryStock?.unvaluedSample).toHaveLength(15);
    expect(out.operations.factoryStock?.unvaluedSample[0]).toEqual({ source: "bale", id: 0, reason: "no cost" });
    expect(rowFor(out, "FACTORY_WIP")).toMatchObject({
      comparable: false,
      reason: "Factory stock contains unvalued cost sources",
    });
    expect(rowFor(out, "INVENTORY")?.comparable).toBe(true);
    expect(out.operations.warnings).toContain(
      "16 Factory cost source(s) have no recorded USD cost; management totals are incomplete and must not be used for audited valuation."
    );
    expect(out.operations).toMatchObject({
      managementCostCandidateUsd: null,
      managementCostCandidateBasis: "WITHHELD_INCOMPLETE_COST",
    });

    h.current.mockResolvedValueOnce(
      valuation({ excluded: { shortageValue: "0", unitemizedMovementValue: "0", anomalousRows: 2 } })
    );
    const anomalous = await dashboard();
    expect(rowFor(anomalous, "INVENTORY")).toMatchObject({
      comparable: false,
      reason: "ERP inventory contains anomalous value rows",
    });
    expect(rowFor(anomalous, "FACTORY_WIP")?.comparable).toBe(true);
    expect(anomalous.operations.warnings).toContain(
      "2 ERP inventory row(s) violate the recorded cost valuation policy."
    );
    expect(anomalous.operations.managementCostCandidateBasis).toBe("WITHHELD_INCOMPLETE_COST");
  });

  it("uses the as-of ERP valuation for a past date and withholds Factory and mixed-date totals", async () => {
    const out = await dashboard({ asOfDate: "2026-06-30" });
    expect(h.asOf).toHaveBeenCalledWith(tx, 3, "2026-06-30");
    expect(h.current).not.toHaveBeenCalled();
    expect(out.operations.erpStock).toMatchObject({ costUsd: "250.00", asOfBasis: "as-of" });
    expect(rowFor(out, "INVENTORY")).toMatchObject({
      operationalCostUsd: "240.00",
      comparable: true,
      differenceUsd: "65.00",
    });
    expect(rowFor(out, "FACTORY_RAW_MATERIAL_STOCK")).toMatchObject({
      comparable: false,
      reason: "Factory cost is current only; cannot compare against historical posted GL",
    });
    expect(out.operations).toMatchObject({
      managementCostCandidateUsd: null,
      managementCostCandidateBasis: "WITHHELD_MIXED_DATES",
      completeness: { factoryHistoricalValuationAvailable: false, stockCostFullyValued: false },
    });
    expect(out.operations.warnings.some((w) => w.startsWith("Factory stock cost is today's current valuation"))).toBe(
      true
    );
    expect(out.operations.warnings.some((w) => w.startsWith("ERP historical inventory replay"))).toBe(false);
  });

  it("withholds historical ERP reconciliation when movements lack stock items", async () => {
    h.asOf.mockResolvedValueOnce(
      valuation({ excluded: { shortageValue: "0", unitemizedMovementValue: "12.50", anomalousRows: 0 } })
    );
    const out = await dashboard({ asOfDate: "2026-06-30" });
    expect(rowFor(out, "INVENTORY")).toMatchObject({
      comparable: false,
      reason: "Historical ERP movements lack stock-item attribution; exact reconciliation withheld",
    });
    expect(out.operations.warnings).toContain(
      "ERP historical inventory replay contains USD 12.50 of movements without stock-item attribution; GL-to-ERP cost reconciliation is withheld."
    );
    // Unitemized value on the current date does not withhold anything.
    h.current.mockResolvedValueOnce(
      valuation({ excluded: { shortageValue: "0", unitemizedMovementValue: "12.50", anomalousRows: 0 } })
    );
    expect(rowFor(await dashboard(), "INVENTORY")?.comparable).toBe(true);
  });
});
