import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import { insertStockItemSchema, stockItemCodeAliases, stockItems } from "@shared/schema";

/**
 * Regression contract for a bug found while removing `updates: any` from the
 * two stock-item PATCH routes.
 *
 * `stock_items` has no `barcode` column - barcodes are stored as rows in
 * `stock_item_code_aliases`. Both PATCH routes nonetheless built
 * `updates.barcode` from the request body, and `StockItemEditDialog` sends it.
 * Because `updates` was typed `any`, nothing flagged the mismatch, and Drizzle
 * silently drops keys that are not columns of the target table, so the value
 * never reached SQL: barcode edits from the stock-item dialog were discarded
 * without any error.
 *
 * These assertions fail if either the schema or the routes drift back.
 */
describe("stock item barcode column contract", () => {
  const routeFiles = ["server/routes/stock/stockItemManageRoutes.ts", "server/routes/stock/transfer-adj/item-write.ts"];

  it("stock_items does not declare a barcode column", () => {
    expect(Object.keys(getTableColumns(stockItems))).not.toContain("barcode");
  });

  it("stock item barcodes are modelled by stock_item_code_aliases", () => {
    const aliasColumns = Object.keys(getTableColumns(stockItemCodeAliases));
    expect(aliasColumns).toContain("stockItemId");
    expect(aliasColumns).toContain("aliasCode");
  });

  it("the insert schema exposes no barcode field to accept from a client", () => {
    expect(Object.keys(insertStockItemSchema.shape)).not.toContain("barcode");
  });

  it("stock item PATCH routes do not assign a barcode update field", () => {
    for (const file of routeFiles) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
      expect(source, `${file} must not assign updates.barcode`).not.toMatch(/updates\.barcode\s*=/);
    }
  });
});
