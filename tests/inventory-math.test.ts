/**
 * Inventory costing arithmetic (server/lib/inventoryMath.ts).
 *
 * Sales, offloads, transfers and POS edits compute quantities, moving
 * weighted-average unit costs and stock values here before writing them.
 * The rules pinned below are the ones a costing write relies on: bad input
 * never becomes NaN or Infinity, zero is never "positive", a reversal can
 * bring the average back, and rounding is half-up at the stored precision.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  INVENTORY_COST_DECIMAL_PLACES,
  INVENTORY_MONEY_DECIMAL_PLACES,
  INVENTORY_QUANTITY_DECIMAL_PLACES,
  addInventoryValues,
  divideInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  roundInventoryValue,
  subtractInventoryValues,
  toInventoryDecimal,
  weightedAverageInventoryCost,
} from "../server/lib/inventoryMath";

const str = (value: Decimal) => value.toString();

describe("stored precision", () => {
  it("keeps quantities to 3 places, unit costs to 6 and money to 2", () => {
    expect([INVENTORY_QUANTITY_DECIMAL_PLACES, INVENTORY_COST_DECIMAL_PLACES, INVENTORY_MONEY_DECIMAL_PLACES]).toEqual([
      3, 6, 2,
    ]);
  });
});

describe("toInventoryDecimal", () => {
  it("reads numbers and numeric strings exactly", () => {
    expect(str(toInventoryDecimal("12.345"))).toBe("12.345");
    expect(str(toInventoryDecimal(7))).toBe("7");
    expect(str(toInventoryDecimal("-2.5"))).toBe("-2.5");
    expect(str(toInventoryDecimal(new Decimal("0.1")))).toBe("0.1");
  });

  it("uses the fallback for missing, empty, malformed or infinite input", () => {
    for (const bad of [null, undefined, "", "abc", Number.NaN, Number.POSITIVE_INFINITY, "Infinity"]) {
      expect(str(toInventoryDecimal(bad, "5"))).toBe("5");
    }
  });

  it("falls back to zero when the fallback is bad too", () => {
    const result = toInventoryDecimal("abc", "also bad");
    expect(result.isZero()).toBe(true);
    expect(result.isPositive()).toBe(false);
  });

  it("never treats zero as positive, so 'must be greater than zero' checks hold", () => {
    for (const zero of [0, "0", "0.000", -0]) {
      const result = toInventoryDecimal(zero);
      expect(result.isZero()).toBe(true);
      expect(result.isPositive()).toBe(false);
      expect(result.isNegative()).toBe(true);
    }
    expect(toInventoryDecimal(null).isPositive()).toBe(false);
    expect(toInventoryDecimal("0.001").isPositive()).toBe(true);
  });

  it("defaults the fallback to zero", () => {
    expect(toInventoryDecimal(undefined).isZero()).toBe(true);
    expect(toInventoryDecimal("x").isZero()).toBe(true);
  });
});

describe("add, subtract, multiply, divide", () => {
  it("adds exactly, without binary floating-point drift", () => {
    expect(str(addInventoryValues("0.1", "0.2"))).toBe("0.3");
    expect(str(addInventoryValues(1, "2", null, "bad", "-0.5"))).toBe("2.5");
    expect(addInventoryValues().isZero()).toBe(true);
  });

  it("subtracts the second value from the first", () => {
    expect(str(subtractInventoryValues("10", "3.25"))).toBe("6.75");
    expect(str(subtractInventoryValues("3", "10"))).toBe("-7");
    expect(str(subtractInventoryValues(null, "4"))).toBe("-4");
  });

  it("multiplies every value, and gives zero for no values", () => {
    expect(str(multiplyInventoryValues("1.5", "4", "2"))).toBe("12");
    expect(str(multiplyInventoryValues("3"))).toBe("3");
    expect(multiplyInventoryValues().isZero()).toBe(true);
    expect(multiplyInventoryValues("5", null).isZero()).toBe(true);
  });

  it("divides, and uses the fallback instead of dividing by zero", () => {
    expect(str(divideInventoryValues("10", "4"))).toBe("2.5");
    expect(str(divideInventoryValues("10", "0", "7"))).toBe("7");
    expect(str(divideInventoryValues("10", null, "7"))).toBe("7");
    expect(divideInventoryValues("10", "0").isZero()).toBe(true);
    expect(str(divideInventoryValues("-9", "3"))).toBe("-3");
  });
});

describe("weightedAverageInventoryCost", () => {
  it("blends the stock on hand with the incoming stock by quantity", () => {
    // 100 @ 10 plus 50 @ 16 = 1,800 over 150 units.
    expect(str(weightedAverageInventoryCost("100", "10", "50", "16"))).toBe("12");
    expect(str(weightedAverageInventoryCost("0", "0", "20", "4.5"))).toBe("4.5");
    expect(str(weightedAverageInventoryCost("30", "8", "0", "99"))).toBe("8");
  });

  it("takes a reversal back out of the average", () => {
    // Undoing the 50 @ 16 receipt returns the stock to 100 @ 10.
    expect(str(weightedAverageInventoryCost("150", "12", "-50", "16"))).toBe("10");
  });

  it("returns the fallback when the combined quantity is zero", () => {
    expect(str(weightedAverageInventoryCost("50", "16", "-50", "16", "9"))).toBe("9");
    expect(weightedAverageInventoryCost("50", "16", "-50", "16").isZero()).toBe(true);
  });

  it("treats unreadable quantities and costs as zero", () => {
    expect(str(weightedAverageInventoryCost("abc", "10", "20", "5"))).toBe("5");
    expect(str(weightedAverageInventoryCost("10", null, "10", "6"))).toBe("3");
  });
});

describe("rounding to the stored precision", () => {
  it("rounds half up", () => {
    expect(str(roundInventoryValue("2.345", 2))).toBe("2.35");
    expect(str(roundInventoryValue("2.344", 2))).toBe("2.34");
    expect(str(roundInventoryValue("-2.345", 2))).toBe("-2.35");
    expect(str(roundInventoryValue("7.5", 0))).toBe("8");
  });

  it("refuses a negative or fractional number of places", () => {
    expect(() => roundInventoryValue("1", -1)).toThrow(RangeError);
    expect(() => roundInventoryValue("1", 1.5)).toThrow("decimalPlaces must be a non-negative integer");
    expect(() => roundInventoryValue("1", 0)).not.toThrow();
  });

  it("formats quantities, unit costs and money at fixed places", () => {
    expect(inventoryQuantity("1.23456")).toBe("1.235");
    expect(inventoryQuantity("2")).toBe("2.000");
    expect(inventoryUnitCost("1.23456789")).toBe("1.234568");
    expect(inventoryUnitCost("3")).toBe("3.000000");
    expect(inventoryMoney("10.005")).toBe("10.01");
    expect(inventoryMoney("bad")).toBe("0.00");
  });
});
