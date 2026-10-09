/**
 * Every shared insert schema now checks amounts the way a numeric column
 * reads them (shared/numericString.ts). parseFloat read the leading number,
 * so "5kg" or "1,000" passed the old checks and then failed at insert.
 */
import { describe, expect, it } from "vitest";
import { isNonNegativeNumeric, isNonZeroNumeric, isNumericString, isPositiveNumeric } from "../shared/numericString";
import { insertStockAdjustmentItemSchema, insertStockTransferItemSchema } from "@shared/schema";

const messages = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe("numeric string checks", () => {
  it("accept numbers as a numeric column reads them", () => {
    for (const value of ["5", "0.125", " 12.5 ", "1e3", "-2"]) expect(isNumericString(value)).toBe(true);
    expect(isPositiveNumeric("0.01")).toBe(true);
    expect(isNonNegativeNumeric("0")).toBe(true);
    expect(isNonZeroNumeric("-3")).toBe(true);
  });

  it("reject what parseFloat only partly read", () => {
    for (const value of ["5kg", "1,000", "", "abc", "Infinity", "0.35/kg"]) expect(isNumericString(value)).toBe(false);
    expect(isPositiveNumeric("0")).toBe(false);
    expect(isNonNegativeNumeric("-0.01")).toBe(false);
    expect(isNonZeroNumeric("0")).toBe(false);
  });
});

describe("stock movement schemas", () => {
  it("rejects a transfer quantity with a unit", () => {
    const result = insertStockTransferItemSchema.safeParse({
      transferId: 1,
      stockItemId: 2,
      quantity: "5kg",
      rate: "1.50",
    });
    expect(messages(result)).toContain("Quantity must be positive");
  });

  it("accepts a negative adjustment quantity but not a malformed rate", () => {
    const adjustment = (rate: string) =>
      insertStockAdjustmentItemSchema.safeParse({ adjustmentId: 1, stockItemId: 2, quantity: "-3", rate });
    expect(messages(adjustment("1.50"))).not.toContain("Quantity cannot be zero");
    expect(messages(adjustment("1,50"))).toContain("Rate must be non-negative");
  });
});
