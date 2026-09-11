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
    expect(source).toContain("buildInventoryValuationReconciliation(");
  });

  it("historical inventory reconstruction uses exact stored values for live stock and exact movement totals", () => {
    const source = read("server/routes/helpers/inventoryHistoryHelpers.ts");

    expect(source).toMatch(/totalValue:\s*inventory\.totalValue/);
    expect(source).toMatch(/totalCost:\s*salesItems\.totalCost/);
    expect(source).toMatch(/totalAmount:\s*stockAdjustmentItems\.totalAmount/);
    expect(source).toMatch(/totalAmount:\s*stockTransferItems\.totalAmount/);
    expect(source).toMatch(/totalValue:\s*containerOffloadItems\.totalValue/);
    expect(source).toContain("inventorySnapshotFromStoredValues(inv.quantity, inv.totalValue, inv.averageRate)");
    expect(source).not.toContain("totalValue: qty * rate");
  });

  it("stock-adjustment edit reversal uses exact stored quantity and value", () => {
    const source = read("server/storage/stock-ops/transfers-update.ts");
    const start = source.indexOf("export async function updateStockAdjustment");
    expect(start).toBeGreaterThanOrEqual(0);
    const adjustmentSource = source.slice(start);

    expect(adjustmentSource).toContain("reverseInventoryByExactValue(");
    expect(adjustmentSource).toContain("restoreInventoryByExactValue(");
    expect(adjustmentSource).toContain("oldItem.totalAmount");
    expect(adjustmentSource).not.toContain(
      "weightedAverageInventoryCost(currentQty, currentRate, absoluteQuantity, rate)"
    );
  });

  it("stock-transfer edit reversal moves the same exact historical value between both locations", () => {
    const source = read("server/storage/stock-ops/transfers-update.ts");
    const start = source.indexOf("export async function updateStockTransfer");
    const end = source.indexOf("export async function updateStockAdjustment");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const transferSource = source.slice(start, end);

    expect(transferSource).toContain("oldItem.totalAmount");
    expect(transferSource).toContain("restoreInventoryByExactValue(");
    expect(transferSource).toContain("reverseInventoryByExactValue(");
    expect(transferSource).toContain('sourceType: "stock_transfer_edit_reverse"');
    expect(transferSource).toContain('sourceType: "stock_transfer_edit_apply"');
  });
});
