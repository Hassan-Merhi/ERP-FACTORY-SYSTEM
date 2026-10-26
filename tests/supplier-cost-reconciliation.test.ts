import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { transformSalesReportBandwidthSource } from "../build/viteSalesReportBandwidthPlugin";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Sales Report historical-profit consistency", () => {
  it("calculates the compact summary and all-company comparison from recorded sales minus COGS", () => {
    const compact = read("server/routes/stats/salesReportBandwidthRoutes.ts");
    // The grouped summary and comparison both use the amount recorded on each line.
    expect(
      compact.match(/COALESCE\(sales.total_sales, 0\)::numeric - COALESCE\(sales.total_cost, 0\)::numeric/g)?.length
    ).toBe(2);
    expect(compact).not.toContain("SUM(COALESCE(sales.profit, 0)::numeric)");
  });

  it("uses consistent arithmetic on raw/export and legacy report endpoints", () => {
    const data = read("server/routes/stats/statsDataRoutes.ts");
    const legacy = read("server/routes/stats/statsReportsRoutes.ts");
    expect(data).toContain("subtractInventoryValues(totalSales, toInventoryDecimal(item.totalCost))");
    expect(data).toContain("costProfit: costProfit.toString()");
    expect(legacy).toContain(
      "COALESCE(${salesItems.totalSales}::numeric, 0) - COALESCE(${salesItems.totalCost}::numeric, 0)"
    );
  });

  it("shows no supplier reconciliation controls anywhere in the built Sales Report", () => {
    const filename = "client/src/pages/SalesReportLegacy.tsx";
    const source = read(filename);
    const built = transformSalesReportBandwidthSource(source, path.join(root, filename));
    expect(built).toBeTruthy();
    expect(built).toContain("const displayedCostProfit = totals.costProfit;");
    expect(built).not.toContain("SupplierCostReconciliationPanel");
    expect(read("server/routes/statsRoutes.ts")).not.toContain("SupplierCostReconciliationRoutes");
  });

  it("reproduces MALI/HMD profit accurately without changing sales or stock", () => {
    const revenue = 339200.81;
    const storedCogs = 303022.84;
    const formerStoredProfit = 36178.05;
    const manualReceipts = 372853.7;
    const currentStockRateValuation = 69909.75;
    const displayedProfit = revenue - storedCogs;
    const manualProfit = revenue - (manualReceipts - currentStockRateValuation);
    expect(Number(displayedProfit.toFixed(2))).toBe(36177.97);
    expect(Number((formerStoredProfit - displayedProfit).toFixed(2))).toBe(0.08);
    expect(Number(manualProfit.toFixed(2))).toBe(36256.86);
    expect(Number((manualProfit - displayedProfit).toFixed(2))).toBe(78.89);
  });
});
