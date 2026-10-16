import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { presentSpMonthlyProfit } from "./spProfitReportPresentation";

describe("Supplier Partner corrected Gross Profit display", () => {
  it("puts the approved September difference into gross while leaving Shared Charges unchanged", () => {
    const totalRevenue = 186435;
    const totalCogs = 151946.05;
    const totalSharedCharges = 4792.5;
    const originalGross = totalRevenue - totalCogs;
    const report = presentSpMonthlyProfit({
      totalRevenue,
      totalCogs,
      totalSharedCharges,
      approvedNetProfit: "38722.86",
    });

    expect(originalGross).toBeCloseTo(34488.95, 2);
    expect(report.grossProfit).toBe(43515.36);
    expect(report.netProfit).toBe(38722.86);
    expect(Number((report.grossProfit - totalSharedCharges).toFixed(2))).toBe(report.netProfit);
    expect(totalSharedCharges).toBe(4792.5);
    expect(Number((report.grossProfit - originalGross).toFixed(2))).toBe(9026.41);
  });

  it("preserves original revenue-less-COGS gross when the month has no approved correction", () => {
    const report = presentSpMonthlyProfit({
      totalRevenue: 186435,
      totalCogs: 151946.05,
      totalSharedCharges: 4792.5,
    });
    expect(report).toEqual({ grossProfit: 34488.95, netProfit: 29696.45 });
  });

  it("supports downward adjustments and accurate cents without changing charges", () => {
    const report = presentSpMonthlyProfit({
      totalRevenue: 125,
      totalCogs: 40.25,
      totalSharedCharges: 12.37,
      approvedNetProfit: "30.01",
    });
    expect(report.grossProfit).toBe(42.38);
    expect(Number((report.grossProfit - 12.37).toFixed(2))).toBe(30.01);
    expect(report.netProfit).toBe(30.01);
  });

  it("does not display a separate Other Income / Expense row", () => {
    const page = readFileSync(new URL("../../../client/src/pages/sp/SpReports.tsx", import.meta.url), "utf8");
    const routes = readFileSync(new URL("./spReportRoutes.ts", import.meta.url), "utf8");
    expect(page).not.toContain('label: "Other Income / (Expense)"');
    expect(routes).not.toContain("otherIncomeExpense,");
    expect(routes).toContain("const { grossProfit, netProfit } = presentSpMonthlyProfit");
  });
});
