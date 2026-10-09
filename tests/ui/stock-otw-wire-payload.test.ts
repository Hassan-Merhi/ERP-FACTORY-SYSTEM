import { describe, expect, it } from "vitest";

import { expandStockOtwWirePayload, type StockItem } from "@/lib/stockOtwWirePayload";

describe("expandStockOtwWirePayload", () => {
  it("expands the dictionary-compressed stock-otw-v2 payload", () => {
    const rows = expandStockOtwWirePayload({
      c: [["CONT-1", "Acme"]],
      i: [{ n: "Cotton", g: "A", c: "Fabric", r: [[0, 4, 10]] }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stockItemName: "Cotton",
      containerNumber: "CONT-1",
      supplierName: "Acme",
      quantity: "4",
      totalCost: "10",
      rate: "2.5",
      gradeName: "A",
      categoryName: "Fabric",
    });
  });

  it("keeps the legacy flat rows the route returns when the profile bridge is not loaded", () => {
    const legacy: StockItem[] = [
      {
        stockItemCode: "C-1",
        stockItemName: "Cotton",
        quantity: "4",
        totalCost: "10",
        rate: "2.5",
        containerNumber: "CONT-1",
        supplierName: "Acme",
        importDate: "2026-09-01",
        gradeId: 1,
        gradeName: "A",
        categoryId: 2,
        categoryName: "Fabric",
      },
    ];

    expect(expandStockOtwWirePayload(legacy)).toBe(legacy);
  });

  it("returns no rows for an empty or malformed payload", () => {
    expect(expandStockOtwWirePayload([])).toEqual([]);
    expect(expandStockOtwWirePayload({} as never)).toEqual([]);
  });
});
