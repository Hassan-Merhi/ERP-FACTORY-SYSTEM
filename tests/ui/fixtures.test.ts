import { getTableColumns, type Table } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { companies, customers, locations, stockItems, suppliers } from "@shared/schema";
import { buildCompany, buildCustomer, buildLocation, buildStockItem, buildSupplier, resetFixtureIds } from "./fixtures";

// tests/ is outside `npm run check`, so the Wire<T> annotations alone would not
// catch a schema change. Compare keys at runtime instead.
const builders: Array<[name: string, table: Table, build: () => object]> = [
  ["companies", companies, buildCompany],
  ["locations", locations, buildLocation],
  ["stock_items", stockItems, buildStockItem],
  ["customers", customers, buildCustomer],
  ["suppliers", suppliers, buildSupplier],
];

describe("fixture builders", () => {
  beforeEach(resetFixtureIds);

  it.each(builders)("%s builder has exactly the table's columns", (_name, table, build) => {
    expect(Object.keys(build()).sort()).toEqual(Object.keys(getTableColumns(table)).sort());
  });

  it("numbers ids per builder and restarts them on reset", () => {
    expect([buildCustomer().id, buildCustomer().id, buildStockItem().id]).toEqual([1, 2, 1]);
    resetFixtureIds();
    expect(buildCustomer().id).toBe(1);
  });

  it("applies overrides, including an explicit id, without advancing the counter", () => {
    expect(buildCustomer({ id: 50, legalName: "Atlas" })).toMatchObject({
      id: 50,
      legalName: "Atlas",
      code: "CUST-50",
    });
    expect(buildCustomer().id).toBe(1);
  });
});
