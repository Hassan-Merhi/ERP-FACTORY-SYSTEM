/**
 * parseMoneyInput reads request input the way parseFloat does (the leading
 * number) but as an exact Decimal, and returns null exactly where parseFloat
 * gives NaN, so routes keep their input contract while computing exactly.
 */
import { describe, expect, it } from "vitest";
import { parseMoneyInput } from "../server/lib/money";

describe("parseMoneyInput", () => {
  it.each([
    ["5", "5"],
    ["5kg", "5"],
    [" 2.5 ", "2.5"],
    ["+3", "3"],
    ["-1.25", "-1.25"],
    [".5", "0.5"],
    ["5.", "5"],
    ["1e3", "1000"],
    ["1,5", "1"],
    ["1.005", "1.005"],
    [7.25, "7.25"],
  ])("reads %j as %s", (input, expected) => {
    expect(parseMoneyInput(input)?.toString()).toBe(expected);
  });

  it.each(["abc", "", "  ", "-", "Infinity", Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}])(
    "returns null for %j",
    (input) => {
      expect(parseMoneyInput(input)).toBeNull();
    }
  );

  it("keeps the exact decimal a float cannot hold", () => {
    expect(parseMoneyInput("100.5")!.times("0.35").toFixed(2)).toBe("35.18");
  });
});
