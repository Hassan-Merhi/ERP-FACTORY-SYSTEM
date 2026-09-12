/**
 * Behavior tests for the pure search matching used by the Waste Dispatch
 * page (bale lists and group-level selection highlighting both depend on
 * which fields match the search term).
 */

import { describe, expect, it } from "vitest";
import { baleMatchesSearch } from "./optimizedData";
import type { WasteBale } from "./optimizedTypes";

function bale(overrides: Partial<WasteBale> = {}): WasteBale {
  return {
    id: 1,
    referenceNumber: "WST-0001",
    productName: "Garbage Mix",
    categoryName: "Garbage",
    locationName: "Yard A",
    weightKg: 100,
    totalCost: 5,
    productId: 7,
    ...overrides,
  };
}

describe("baleMatchesSearch", () => {
  it("matches any bale for an empty or whitespace-only search", () => {
    expect(baleMatchesSearch(bale(), "")).toBe(true);
    expect(baleMatchesSearch(bale(), "   ")).toBe(true);
  });

  it("matches on reference, product, category, or location (case-insensitive)", () => {
    expect(baleMatchesSearch(bale(), "wst-0001")).toBe(true);
    expect(baleMatchesSearch(bale(), "garbage mix")).toBe(true);
    expect(baleMatchesSearch(bale(), "GARBAGE")).toBe(true);
    expect(baleMatchesSearch(bale(), "yard a")).toBe(true);
  });

  it("does not match unrelated terms", () => {
    expect(baleMatchesSearch(bale(), "nope")).toBe(false);
  });

  it("treats missing optional fields as empty strings", () => {
    expect(baleMatchesSearch(bale({ articleCode: undefined }), "wst-0001")).toBe(true);
  });
});
