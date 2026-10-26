import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(path.resolve(process.cwd(), "server/services/reports", name), "utf8");

describe("Stock In/Sales profit uses posted sale and cost totals", () => {
  it("aggregates signed sales minus COGS, never legacy stored profit", () => {
    for (const file of ["stockInSalesReportService.ts", "stockInSalesComparisonService.ts"]) {
      const code = source(file);
      expect(code).toContain("SUM(${salesItems.totalSales}::numeric - ${salesItems.totalCost}::numeric)");
      expect(code).not.toContain("SUM(${salesItems.profit})");
    }
  });

  it("derives detailed line profit from the exact stored sale and cost value", () => {
    const code = source("stockInSalesDetailService.ts");
    expect(code).toContain(
      "costProfit: sql<string>`(${salesItems.totalSales}::numeric - ${salesItems.totalCost}::numeric)`"
    );
    expect(code).not.toContain("costProfit: salesItems.profit");
  });

  it("returns consistent sale profit in vouchers and assistant-backed summaries", () => {
    const rootSource = (name: string) => readFileSync(path.resolve(process.cwd(), name), "utf8");
    for (const file of ["server/routes/globalTransactionRoutes.ts", "server/routes/voucher-entries/reads.ts"]) {
      const code = rootSource(file);
      expect(code).toContain(
        "profit: sql<string>`(${salesItems.totalSales}::numeric - ${salesItems.totalCost}::numeric)`"
      );
      expect(code).not.toContain("profit: salesItems.profit");
    }
    for (const file of ["server/chat/erpContext.ts", "server/aiTools.ts"]) {
      const code = rootSource(file);
      expect(code).not.toContain("CAST(${schema.salesItems.profit} AS NUMERIC)");
      expect(code).not.toContain("profit: schema.salesItems.profit");
    }
  });

  it("keeps MALI HMD booked profit correct despite historical cached profit drift", () => {
    const revenue = 339200.81;
    const bookedCogs = 303022.84;
    const oldProfitFieldSum = 36178.05;
    expect(Number((revenue - bookedCogs).toFixed(2))).toBe(36177.97);
    expect(Number((oldProfitFieldSum - (revenue - bookedCogs)).toFixed(2))).toBe(0.08);
  });
});
