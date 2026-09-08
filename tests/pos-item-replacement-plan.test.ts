import { describe, expect, it } from "vitest";
import {
  buildPosReplacementSaleItems,
  type PosItemReplacementInput,
  type PosReplacementSourceLine,
} from "../server/services/pos/itemReplacementService";

function replacementMap(...rows: PosItemReplacementInput[]): Map<number, PosItemReplacementInput[]> {
  const map = new Map<number, PosItemReplacementInput[]>();
  for (const row of rows) {
    const current = map.get(row.saleItemId) || [];
    current.push(row);
    map.set(row.saleItemId, current);
  }
  return map;
}

describe("POS item replacement sale-line planning", () => {
  it("turns a sold quantity of 5 into 4 old + 1 replacement while preserving the sale price", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 101,
        stockItemId: 10,
        quantity: "5.000",
        sellingPrice: "25.000000",
      },
    ];

    const result = buildPosReplacementSaleItems(
      original,
      replacementMap({ saleItemId: 101, replacementStockItemId: 20, quantity: 1 })
    );

    expect(result.items).toEqual([
      {
        id: 101,
        stockItemId: 10,
        quantity: "4",
        sellingPrice: "25.000000",
      },
      {
        stockItemId: 20,
        quantity: "1",
        sellingPrice: "25.000000",
      },
    ]);
    expect(result.replacedQuantity).toBe("1");
  });

  it("removes the original line when the full sold quantity is replaced", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 201,
        stockItemId: 30,
        quantity: "5.000",
        sellingPrice: "10.500000",
      },
    ];

    const result = buildPosReplacementSaleItems(
      original,
      replacementMap({ saleItemId: 201, replacementStockItemId: 31, quantity: 5 })
    );

    expect(result.items).toEqual([
      {
        stockItemId: 31,
        quantity: "5",
        sellingPrice: "10.500000",
      },
    ]);
    expect(result.replacedQuantity).toBe("5");
  });

  it("leaves unrelated POS lines unchanged and preserves their ids", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 301,
        stockItemId: 40,
        quantity: "3.000",
        sellingPrice: "8.000000",
      },
      {
        id: 302,
        stockItemId: 50,
        quantity: "2.000",
        sellingPrice: "12.000000",
      },
    ];

    const result = buildPosReplacementSaleItems(
      original,
      replacementMap({ saleItemId: 301, replacementStockItemId: 41, quantity: 1 })
    );

    expect(result.items).toContainEqual({
      id: 302,
      stockItemId: 50,
      quantity: "2.000",
      sellingPrice: "12.000000",
    });
  });

  it("can split one mistaken line across more than one replacement item", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 401,
        stockItemId: 60,
        quantity: "6.000",
        sellingPrice: "15.000000",
      },
    ];

    const result = buildPosReplacementSaleItems(
      original,
      replacementMap(
        { saleItemId: 401, replacementStockItemId: 61, quantity: 2 },
        { saleItemId: 401, replacementStockItemId: 62, quantity: 1 }
      )
    );

    expect(result.items).toEqual([
      {
        id: 401,
        stockItemId: 60,
        quantity: "3",
        sellingPrice: "15.000000",
      },
      {
        stockItemId: 61,
        quantity: "2",
        sellingPrice: "15.000000",
      },
      {
        stockItemId: 62,
        quantity: "1",
        sellingPrice: "15.000000",
      },
    ]);
    expect(result.replacedQuantity).toBe("3");
  });
});
