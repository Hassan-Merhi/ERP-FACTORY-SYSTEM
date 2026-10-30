import { describe, expect, it } from "vitest";
import { compareItemNamesAZ } from "./itemNameSort";

describe("compareItemNamesAZ", () => {
  it("sorts the purchase item names A–Z regardless of their original order or case", () => {
    const names = [
      "HMD FISHING VEST 40KG",
      "HMD CORSET 40KG",
      "hmd army uniform 40kg",
      "HMD BATH MAT 40KG",
    ];
    const original = [...names];

    expect([...names].sort(compareItemNamesAZ)).toEqual([
      "hmd army uniform 40kg",
      "HMD BATH MAT 40KG",
      "HMD CORSET 40KG",
      "HMD FISHING VEST 40KG",
    ]);
    expect(names).toEqual(original);
  });

  it("uses natural numeric order and handles missing names", () => {
    expect(["Bag 10", "bag 2", "Bag 1"].sort(compareItemNamesAZ)).toEqual([
      "Bag 1",
      "bag 2",
      "Bag 10",
    ]);
    expect(compareItemNamesAZ(null, "Bags")).toBeLessThan(0);
    expect(compareItemNamesAZ(" Shoes ", "shoes")).toBe(0);
  });
});
