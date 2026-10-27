import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { calculatePeriodTableBalance } from "../server/routes/factory/bale-exports/production-value-math";

describe("selected-period Balance on Table", () => {
  it("uses only remaining period weight at the period mix rate", () => {
    // 18,773 is a representative period-only weight, not a hard-coded ERP value.
    const period = calculatePeriodTableBalance({
      remainingPeriodKg: "18773",
      mixedPeriodWeightKg: "100000",
      mixedPeriodCost: "68000",
    });
    expect(period.weightKg).toBe(18773);
    expect(period.costPerKg).toBe(0.68);
    expect(period.value).toBe(12765.64);
    expect(period.weightKg).not.toBe(113507.2);
  });

  it("uses the weighted period mix cost, not a simple average of rates", () => {
    const period = calculatePeriodTableBalance({
      remainingPeriodKg: "120",
      mixedPeriodWeightKg: "300",
      mixedPeriodCost: "240",
    });
    expect(period.weightKg).toBe(120);
    expect(period.costPerKg).toBe(0.8);
    expect(period.value).toBe(96);
  });

  it("shows zero for periods with no original mix batches", () => {
    const period = calculatePeriodTableBalance({
      remainingPeriodKg: "0",
      mixedPeriodWeightKg: "0",
      mixedPeriodCost: "0",
    });
    expect(period).toEqual({ weightKg: 0, costPerKg: 0, value: 0 });
  });

  it("keeps the historical production Weight Cost expression unchanged", () => {
    const source = readFileSync(
      resolve(process.cwd(), "server/routes/factory/bale-exports/production-value-report.ts"),
      "utf8"
    );
    expect(source).toContain("producedWeightKg: new BatchRateDecimal(totalBaleWeightKg).plus(totalWgWeightKg)");
    expect(source).toContain("batchRateCost: balanceBatchRateDecimal");
    // The original overall snapshot remains the authoritative cumulative value.
    expect(source).toContain("weightKg: balanceWeightKg");
    expect(source).toContain("costPerKg: hideReportCosts ? 0 : balanceCostPerKg");
    expect(source).toContain("value: hideReportCosts ? 0 : balanceValue");
    // The filtered snapshot never substitutes itself into profit or the total.
    expect(source).toContain("filteredBalanceOnTable: {");
    expect(source).toContain("weightKg: filteredTable.weightKg");
    expect(source).toContain("costPerKg: hideReportCosts ? 0 : filteredTable.costPerKg");
    expect(source).toContain("value: hideReportCosts ? 0 : filteredTable.value");
    expect(source).toContain("remainingMaterialValue: hideReportCosts ? 0 : balanceValue");
  });
});

describe("Balance on Table card split", () => {
  it("shows the overall and filtered balances independently with the same report response", () => {
    const ui = readFileSync(
      resolve(process.cwd(), "client/src/pages/factory/dailyproductionreport/components/ProductionTabPanel.tsx"),
      "utf8"
    );
    expect(ui).toContain('data-testid="card-balance-on-table"');
    expect(ui).toContain('data-testid="card-filtered-balance-on-table"');
    expect(ui).toContain("data?.balanceOnTable.weightKg");
    expect(ui).toContain("data?.filteredBalanceOnTable?.weightKg");
    expect(ui).toContain('label="Cumulative Rate"');
    expect(ui).toContain('label="Period Batch Rate"');
    expect(ui).toContain("lg:grid-cols-2");
  });
});
