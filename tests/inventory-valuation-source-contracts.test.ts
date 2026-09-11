import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("inventory valuation source contracts", () => {
  it("current-year monthly summary must not hard-overwrite December with today's inventory", () => {
    const source = read("server/routes/stock-summary-location/monthly-summary.ts");

    expect(source).not.toContain("monthlyData[11].closingQty =");
    expect(source).not.toContain("monthlyData[11].closingValue =");
    expect(source).not.toContain("monthlyData[11].closingRate =");
  });

  it("live reconciliation must use stored inventory total_value instead of rebuilding value from rounded average_rate", () => {
    const source = read("server/routes/stock-summary-location/monthly-summary.ts");

    expect(source).toMatch(/totalValue:\s*inventory\.totalValue/);
    expect(source).not.toMatch(/const\s+actualValue\s*=\s*actualQty\s*\*\s*actualRate/);
  });

  it("stock-adjustment edit reversal must not reconstruct old value with today's average rate", () => {
    const source = read("server/storage/stock-ops/transfers-update.ts");
    const start = source.indexOf("export async function updateStockAdjustment");
    expect(start).toBeGreaterThanOrEqual(0);
    const adjustmentSource = source.slice(start);

    // Wave 2/3 will replace this with an exact reversal primitive. The old path
    // derives reversal value from current inventory and therefore changes cost basis.
    expect(adjustmentSource).not.toContain("weightedAverageInventoryCost(currentQty, currentRate, absoluteQuantity, rate)");
  });
});
