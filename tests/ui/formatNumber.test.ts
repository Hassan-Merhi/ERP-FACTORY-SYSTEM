/**
 * Unit tests for client/src/lib/formatNumber.ts — the shared currency/number
 * formatting helpers used across ledgers, reports, and voucher screens.
 *
 * Assertions on the fractional/grouping separator use regex character classes
 * ([.,]) so they hold regardless of the CI runner's default locale.
 */
import {
  drCrClass,
  creditPositiveBalanceClass,
  formatNumber,
  formatCurrency,
  formatCurrencyWithLabel,
  formatPercent,
} from "@/lib/formatNumber";

describe("drCrClass", () => {
  it("returns red for a credit side (case-insensitive)", () => {
    expect(drCrClass("CR")).toContain("text-red-500");
    expect(drCrClass("cr")).toContain("text-red-500");
  });

  it("returns green for a debit side", () => {
    expect(drCrClass("DR")).toContain("text-green-600");
  });

  it("treats any non-CR value as debit (green)", () => {
    expect(drCrClass("something")).toContain("text-green-600");
  });

  it("returns empty string for null/undefined/empty", () => {
    expect(drCrClass(null)).toBe("");
    expect(drCrClass(undefined)).toBe("");
    expect(drCrClass("")).toBe("");
  });
});

describe("creditPositiveBalanceClass", () => {
  it("shows a negative credit-positive balance as a green debit", () => {
    expect(creditPositiveBalanceClass(-149160)).toContain("text-green-600");
  });

  it("shows a positive credit-positive balance as a red credit", () => {
    expect(creditPositiveBalanceClass(149160)).toContain("text-red-500");
  });

  it("keeps zero and invalid values neutral", () => {
    expect(creditPositiveBalanceClass(0)).toBe("text-muted-foreground");
    expect(creditPositiveBalanceClass(NaN)).toBe("text-muted-foreground");
  });
});

describe("formatNumber", () => {
  it("returns '0' for null, undefined, and non-finite input", () => {
    expect(formatNumber(null)).toBe("0");
    expect(formatNumber(undefined)).toBe("0");
    expect(formatNumber(NaN)).toBe("0");
    expect(formatNumber(Infinity)).toBe("0");
    expect(formatNumber(-Infinity)).toBe("0");
  });

  it("drops decimals for whole numbers", () => {
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(0)).toBe("0");
  });

  it("keeps significant decimals up to the max", () => {
    expect(formatNumber(42.5)).toMatch(/^42[.,]5$/);
    expect(formatNumber(42.55)).toMatch(/^42[.,]55$/);
  });

  it("rounds to the requested max decimals", () => {
    expect(formatNumber(1.239, 2)).toMatch(/^1[.,]24$/);
    expect(formatNumber(1.2345, 3)).toMatch(/^1[.,]235$/);
  });

  it("handles negative values", () => {
    expect(formatNumber(-7)).toBe("-7");
  });
});

describe("formatCurrency", () => {
  it("delegates to formatNumber with 2 decimals", () => {
    expect(formatCurrency(100)).toBe("100");
    expect(formatCurrency(100.5)).toMatch(/^100[.,]5$/);
    expect(formatCurrency(null)).toBe("0");
  });
});

describe("formatCurrencyWithLabel", () => {
  it("prefixes USD with '$ ' and shows no decimals for whole amounts", () => {
    expect(formatCurrencyWithLabel(100, "USD")).toBe("$ 100");
  });

  it("shows two decimals for fractional USD amounts", () => {
    expect(formatCurrencyWithLabel(99.5, "USD")).toMatch(/^\$ 99[.,]50$/);
  });

  it("accepts numeric strings", () => {
    expect(formatCurrencyWithLabel("250", "USD")).toBe("$ 250");
  });

  it("defaults the currency to USD", () => {
    expect(formatCurrencyWithLabel(10)).toBe("$ 10");
  });

  it("prefixes CFA and rounds to whole numbers", () => {
    expect(formatCurrencyWithLabel(500.7, "CFA")).toBe("CFA 501");
    expect(formatCurrencyWithLabel(500, "CFA")).toBe("CFA 500");
  });

  it("returns an empty string for unparseable input", () => {
    expect(formatCurrencyWithLabel("not-a-number", "USD")).toBe("");
    expect(formatCurrencyWithLabel(NaN, "USD")).toBe("");
  });
});

describe("formatPercent", () => {
  it("appends a % sign and trims whole-number decimals", () => {
    expect(formatPercent(50)).toBe("50%");
    expect(formatPercent(33.333)).toMatch(/^33[.,]33%$/);
  });
});
