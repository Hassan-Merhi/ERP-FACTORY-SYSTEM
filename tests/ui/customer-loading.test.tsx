import { describe, expect, it } from "vitest";

function selectionTotals(lines: Array<{ quantity: number; weightPerBale: number; pricePerBale: number }>) {
  return lines.reduce(
    (totals, line) => ({
      lines: totals.lines + 1,
      quantity: totals.quantity + line.quantity,
      kg: totals.kg + line.quantity * line.weightPerBale,
      amount: totals.amount + line.quantity * line.pricePerBale,
    }),
    { lines: 0, quantity: 0, kg: 0, amount: 0 }
  );
}

function validLine(input: { quantity: number; rawPrice: string; articleCode?: string | null; code: string }) {
  const parsedPrice = Number(input.rawPrice);
  const priceValid = input.rawPrice !== "" && Number.isFinite(parsedPrice) && parsedPrice >= 0;
  return input.quantity > 0 && priceValid && Boolean(input.articleCode || input.code);
}

describe("customer loading phase 3 proforma builder rules", () => {
  it("calculates bale, kg, and selling-price totals for selected lines", () => {
    expect(
      selectionTotals([
        { quantity: 10, weightPerBale: 40, pricePerBale: 80 },
        { quantity: 5, weightPerBale: 25, pricePerBale: 100 },
      ])
    ).toEqual({ lines: 2, quantity: 15, kg: 525, amount: 1300 });
  });

  it("accepts zero selling price but rejects blank, negative, or invalid prices", () => {
    expect(validLine({ quantity: 1, rawPrice: "0", articleCode: "HMD1", code: "P1" })).toBe(true);
    expect(validLine({ quantity: 1, rawPrice: "", articleCode: "HMD1", code: "P1" })).toBe(false);
    expect(validLine({ quantity: 1, rawPrice: "-1", articleCode: "HMD1", code: "P1" })).toBe(false);
    expect(validLine({ quantity: 1, rawPrice: "abc", articleCode: "HMD1", code: "P1" })).toBe(false);
  });

  it("requires a positive quantity and falls back to the product code when article code is absent", () => {
    expect(validLine({ quantity: 0, rawPrice: "80", articleCode: "HMD1", code: "P1" })).toBe(false);
    expect(validLine({ quantity: 2, rawPrice: "80", articleCode: null, code: "P1" })).toBe(true);
    expect(validLine({ quantity: 2, rawPrice: "80", articleCode: null, code: "" })).toBe(false);
  });

  it("keeps kg totals while allowing zero-price promotional lines", () => {
    expect(selectionTotals([{ quantity: 3, weightPerBale: 20, pricePerBale: 0 }])).toEqual({
      lines: 1,
      quantity: 3,
      kg: 60,
      amount: 0,
    });
  });
});
