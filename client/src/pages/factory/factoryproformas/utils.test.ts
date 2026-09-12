/**
 * Behavior tests for the proforma line pricing helper: per-kg priced lines
 * must contribute kg × pricePerKg to totals, falling back to the flat
 * price-per-bale otherwise.
 */

import { describe, expect, it } from "vitest";
import type { ProformaLine } from "./types";
import { effectivePricePerBale } from "./utils";

function line(overrides: Partial<ProformaLine> = {}): ProformaLine {
  return {
    id: 1,
    proformaId: 1,
    articleCode: "ART-1",
    productName: "Rice 25kg",
    quantity: 10,
    pricePerBale: "100",
    ...overrides,
  };
}

describe("effectivePricePerBale", () => {
  it("uses kg × pricePerKg for per-kg priced lines", () => {
    expect(effectivePricePerBale(line({ pricingMode: "per_kg", pricePerKg: "4", weightPerBaleKg: "25" }))).toBe(100);
  });

  it("falls back to pricePerBale when per-kg inputs are missing or zero", () => {
    expect(effectivePricePerBale(line({ pricingMode: "per_kg", pricePerKg: "" }))).toBe(100);
    expect(effectivePricePerBale(line({ pricingMode: "per_kg", pricePerKg: "4", weightPerBaleKg: "0" }))).toBe(100);
    expect(effectivePricePerBale(line({ pricingMode: null }))).toBe(100);
  });

  it("returns 0 for lines with no usable price", () => {
    expect(effectivePricePerBale(line({ pricePerBale: "" }))).toBe(0);
  });
});
