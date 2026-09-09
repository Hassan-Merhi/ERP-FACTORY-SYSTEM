import { describe, expect, it } from "vitest";
import {
  buildPosReplacementSaleItems,
  type PosItemReplacementInput,
  type PosReplacementSourceLine,
} from "../server/services/pos/itemReplacementPlan";

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
  it("turns a sold quantity of 5 into 4 old + 1 replacement while preserving the sale price and total", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 101,
        stockItemId: 10,
        quantity: "5.000",
        sellingPrice: "25.000000",
        totalSales: "125.00",
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
        totalSales: "100.00",
      },
      {
        stockItemId: 20,
        quantity: "1",
        sellingPrice: "25.000000",
        totalSales: "25.00",
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
        totalSales: "52.50",
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
        totalSales: "52.50",
      },
    ]);
    expect(result.replacedQuantity).toBe("5");
  });

  it("never emits a zero-quantity old line when replacing the full 1 of 1 sold quantity", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 211,
        stockItemId: 7061,
        quantity: "1.000",
        sellingPrice: "70.000000",
        totalSales: "70.00",
      },
    ];

    const result = buildPosReplacementSaleItems(
      original,
      replacementMap({ saleItemId: 211, replacementStockItemId: 7062, quantity: 1 })
    );

    expect(result.items).toEqual([
      {
        stockItemId: 7062,
        quantity: "1",
        sellingPrice: "70.000000",
        totalSales: "70.00",
      },
    ]);
    expect(result.items.every((item) => Number(item.quantity) > 0)).toBe(true);
  });

  it("leaves unrelated POS lines unchanged and preserves their ids and rounded totals", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 301,
        stockItemId: 40,
        quantity: "3.000",
        sellingPrice: "8.000000",
        totalSales: "24.00",
      },
      {
        id: 302,
        stockItemId: 50,
        quantity: "2.000",
        sellingPrice: "12.000000",
        totalSales: "24.00",
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
      totalSales: "24.00",
    });
  });

  it("omits unrelated legacy zero-quantity lines so a selected replacement can still be applied", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 351,
        stockItemId: 80,
        quantity: "1.000",
        sellingPrice: "60.000000",
        totalSales: "60.00",
      },
      {
        id: 352,
        stockItemId: 81,
        quantity: "0.000",
        sellingPrice: "0.000000",
        totalSales: "0.00",
      },
    ];

    const result = buildPosReplacementSaleItems(
      original,
      replacementMap({ saleItemId: 351, replacementStockItemId: 82, quantity: 1 })
    );

    expect(result.items).toEqual([
      {
        stockItemId: 82,
        quantity: "1",
        sellingPrice: "60.000000",
        totalSales: "60.00",
      },
    ]);
    expect(result.replacedQuantity).toBe("1");
  });

  it("can split one mistaken line across more than one replacement item", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 401,
        stockItemId: 60,
        quantity: "6.000",
        sellingPrice: "15.000000",
        totalSales: "90.00",
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
        totalSales: "45.00",
      },
      {
        stockItemId: 61,
        quantity: "2",
        sellingPrice: "15.000000",
        totalSales: "30.00",
      },
      {
        stockItemId: 62,
        quantity: "1",
        sellingPrice: "15.000000",
        totalSales: "15.00",
      },
    ]);
    expect(result.replacedQuantity).toBe("3");
  });

  it("keeps the original rounded cents when a fractional line is split", () => {
    const original: PosReplacementSourceLine[] = [
      {
        id: 501,
        stockItemId: 70,
        quantity: "1.000",
        sellingPrice: "0.030000",
        totalSales: "0.03",
      },
    ];

    const result = buildPosReplacementSaleItems(
      original,
      replacementMap({ saleItemId: 501, replacementStockItemId: 71, quantity: 0.5 })
    );

    expect(result.items).toEqual([
      {
        id: 501,
        stockItemId: 70,
        quantity: "0.5",
        sellingPrice: "0.030000",
        totalSales: "0.02",
      },
      {
        stockItemId: 71,
        quantity: "0.5",
        sellingPrice: "0.030000",
        totalSales: "0.01",
      },
    ]);
    expect(result.items.reduce((sum, row) => sum + Number(row.totalSales), 0)).toBeCloseTo(0.03, 10);
  });
});
