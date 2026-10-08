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
    ["1e-1000000000", "0"],
    ["-1e-500", "0"],
    ["1e-300", "1e-300"],
    [7.25, "7.25"],
  ])("reads %j as %s", (input, expected) => {
    expect(parseMoneyInput(input)?.toString()).toBe(expected);
  });

  it.each([
    "abc",
    "",
    "  ",
    "-",
    "Infinity",
    "1e400",
    "-1e400",
    "1e1000000000",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
    {},
  ])("returns null for %j", (input) => {
    expect(parseMoneyInput(input)).toBeNull();
  });

  it("formats an underflowing exponent without writing out its zeros", () => {
    expect(parseMoneyInput("1e-500000000")!.toFixed()).toBe("0");
  });

  it("keeps the exact decimal a float cannot hold", () => {
    expect(parseMoneyInput("100.5")!.times("0.35").toFixed(2)).toBe("35.18");
  });
});
