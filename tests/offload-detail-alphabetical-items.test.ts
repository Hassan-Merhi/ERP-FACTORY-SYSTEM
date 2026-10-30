import { describe, expect, it } from "vitest";
import { offloadItemDisplayName, sortOffloadItemsByName } from "../shared/offloadItemSort";

describe("Offload detail stock item alphabetical display", () => {
  const line = (id: number, stockItemName: string | null, stockItemCode: string | null = null) => ({
    id,
    stockItemId: id + 100,
    stockItemName,
    stockItemCode,
    quantity: "2",
    rate: "111.03",
    totalValue: "222.06",
  });

  it("orders items in the offload screenshot by name, rather than insertion order", () => {
    const rows = [
      line(1, "EG Travel Big Bag 50 KGS"),
      line(2, "EG Wallet 25 KGS"),
      line(3, "EG White Boy Shirt 40 KGS"),
      line(4, "EG Winter Cap #1 40 KGS"),
      line(5, "EG Bed Sheet #2 40 KGS"),
      line(6, "EG Boy T Shirt SS #2 40 KGS"),
    ];
    const sorted = sortOffloadItemsByName(rows);
    expect(sorted.map((item) => item.stockItemName)).toEqual([
      "EG Bed Sheet #2 40 KGS",
      "EG Boy T Shirt SS #2 40 KGS",
      "EG Travel Big Bag 50 KGS",
      "EG Wallet 25 KGS",
      "EG White Boy Shirt 40 KGS",
      "EG Winter Cap #1 40 KGS",
    ]);
    expect(rows[0].stockItemName).toBe("EG Travel Big Bag 50 KGS");
    expect(sorted.reduce((sum, item) => sum + Number(item.totalValue), 0))
      .toBe(rows.reduce((sum, item) => sum + Number(item.totalValue), 0));
  });

  it("uses natural numeric sorting, case-insensitivity, and a stable row-id tiebreak", () => {
    const sorted = sortOffloadItemsByName([
      line(9, "eg item 10"),
      line(3, "EG Item 2"),
      line(7, "EG ITEM 2"),
      line(5, "Abc"),
    ]);
    expect(sorted.map((item) => item.id)).toEqual([5, 3, 7, 9]);
  });

  it("sorts by the same fallback labels the UI renders", () => {
    const sorted = sortOffloadItemsByName([
      line(11, null, "XYZ9"),
      line(2, null, "ABC2"),
      line(3, "", null),
      line(1, null, "ABC10"),
    ]);
    expect(sorted.map(offloadItemDisplayName)).toEqual(["ABC2", "ABC10", "Item #103", "XYZ9"]);
  });
});
