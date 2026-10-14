import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSource = readFileSync(
  resolve(process.cwd(), "server/routes/stock/stockLightRoutes.ts"),
  "utf8",
);
const indexSource = readFileSync(
  resolve(process.cwd(), "server/routes/stockRoutes.ts"),
  "utf8",
);

describe("Program 6C lightweight stock-item route", () => {
  it("registers the lightweight endpoint before the full stock routes", () => {
    expect(indexSource).toContain('import { registerStockLightRoutes } from "./stock/stockLightRoutes"');
    expect(indexSource.indexOf("registerStockLightRoutes(app)")).toBeGreaterThan(-1);
    expect(indexSource.indexOf("registerStockLightRoutes(app)")).toBeLessThan(
      indexSource.indexOf("registerStockGroupsItemsRoutes(app)"),
    );
  });

  it("selects only identity and classification fields", () => {
    for (const field of [
      "id: stockItems.id",
      "code: stockItems.code",
      "name: stockItems.name",
      "uom: stockItems.uom",
      "active: stockItems.active",
      "stockGroupId: stockItems.stockGroupId",
      "categoryId: stockItems.categoryId",
      "gradeId: stockItems.gradeId",
    ]) {
      expect(routeSource).toContain(field);
    }

    for (const forbidden of [
      "openingQty: stockItems.openingQty",
      "openingRate: stockItems.openingRate",
      "openingValue: stockItems.openingValue",
      "sellingPrice: stockItems.sellingPrice",
      "createdAt: stockItems.createdAt",
    ]) {
      expect(routeSource).not.toContain(forbidden);
    }
  });

  it("enforces company isolation and excludes deleted items", () => {
    expect(routeSource).toContain("eq(stockItems.companyId, companyId)");
    expect(routeSource).toContain("isNull(stockItems.deletedAt)");
  });
});
