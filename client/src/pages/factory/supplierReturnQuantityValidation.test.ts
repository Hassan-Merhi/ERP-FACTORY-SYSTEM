import { describe, expect, it } from "vitest";
import { isValidSupplierReturnQuantity } from "./supplierReturnQuantityValidation";

describe("supplier return quantity input", () => {
  it("accepts legitimate manually entered and spreadsheet quantities", () => {
    for (const value of ["1", "12", "0.5", "0.001", "25.375", "1000"]) {
      expect(isValidSupplierReturnQuantity(value)).toBe(true);
    }
  });
  it("rejects missing, negative, zero or over-precision quantities", () => {
    for (const value of ["", "0", "0.000", "-1", "1.0001", "abc", "1x", "1.2.3", "1e6"]) {
      expect(isValidSupplierReturnQuantity(value)).toBe(false);
    }
  });
});
