import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { calculatePeriodTableBalance } from "../server/routes/factory/bale-exports/production-value-math";

describe("selected-period Balance on Table", () => {
  it("derives 18,773 kg from two historical snapshots, never from today's ACTIVE batches", () => {
    // Example snapshot movement, NOT a hardcoded production result.
    const period = calculatePeriodTableBalance({
      weightAtEndKg: "92176.2",
      weightBeforePeriodKg: "73403.2",
      mixedPeriodWeightKg: "100000",
      mixedPeriodCost: "68000",
    });
    expect(period.weightKg).toBe(18773);
    expect(period.netChangeKg).toBe(18773);
    expect(period.direction).toBe("increase");
    expect(period.costPerKg).toBe(0.68);
    expect(period.value).toBe(12765.64);
  });

  it("reports a drawdown as a decrease instead of zero or extra inventory", () => {
    const period = calculatePeriodTableBalance({
      weightAtEndKg: "180",
      weightBeforePeriodKg: "300",
      mixedPeriodWeightKg: "300",
      mixedPeriodCost: "240",
    });
    expect(period.weightKg).toBe(120);
    expect(period.netChangeKg).toBe(-120);
    expect(period.direction).toBe("decrease");
    expect(period.costPerKg).toBe(0.8);
    expect(period.value).toBe(96);
  });

  it("shows zero movement when table weight is unchanged", () => {
    const period = calculatePeriodTableBalance({
      weightAtEndKg: "500",
      weightBeforePeriodKg: "500",
      mixedPeriodWeightKg: "0",
      mixedPeriodCost: "0",
    });
    expect(period).toEqual({
      weightKg: 0,
      netChangeKg: 0,
      direction: "unchanged",
      costPerKg: 0,
      value: 0,
    });
  });

  it("keeps production Weight Cost and overall WIP valuation unchanged", () => {
    const source = readFileSync(
      resolve(process.cwd(), "server/routes/factory/bale-exports/production-value-report.ts"),
      "utf8"
    );
    expect(source).toContain("producedWeightKg: new BatchRateDecimal(totalBaleWeightKg).plus(totalWgWeightKg)");
    expect(source).toContain("batchRateCost: balanceBatchRateDecimal");
    expect(source).toContain("getFactoryBalanceOnTableSnapshot(companyId, priorDate)");
    expect(source).toContain("weightBeforePeriodKg: beforePeriodSnapshot?.weightKg ?? 0");
    expect(source).toContain("weightKg: balanceWeightKg");
    expect(source).toContain("costPerKg: hideReportCosts ? 0 : balanceCostPerKg");
    expect(source).toContain("value: hideReportCosts ? 0 : balanceValue");
    expect(source).toContain("filteredBalanceOnTable: {");
    expect(source).toContain("direction: filteredTable.direction");
    expect(source).toContain("weightKg: filteredTable.weightKg");
    expect(source).toContain("costPerKg: hideReportCosts ? 0 : filteredTable.costPerKg");
    expect(source).toContain("value: hideReportCosts ? 0 : filteredTable.value");
    expect(source).toContain("remainingMaterialValue: hideReportCosts ? 0 : balanceValue");
  });
});

describe("single Balance on Table KPI, internally split", () => {
  it("places both WIP sections into the fourth card without an extra row", () => {
    const ui = readFileSync(
      resolve(process.cwd(), "client/src/pages/factory/dailyproductionreport/components/ProductionTabPanel.tsx"),
      "utf8"
    );
    expect(ui).toContain("xl:grid-cols-4");
    expect(ui).toContain('data-testid="card-balance-on-table"');
    expect(ui).toContain('data-testid="section-overall-balance-on-table"');
    expect(ui).toContain('data-testid="card-filtered-balance-on-table"');
    expect(ui).toContain("data?.balanceOnTable.weightKg");
    expect(ui).toContain("data?.filteredBalanceOnTable?.weightKg");
    expect(ui).toContain('label="Cumulative Rate"');
    expect(ui).toContain('label="Period Batch Rate"');
    expect(ui).toContain('direction === "decrease"');
  });
});
