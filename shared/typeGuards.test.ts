import { describe, expect, it } from "vitest";
import { asRecord, isNonEmptyString, isRecord, toFiniteNumber, toPositiveInteger } from "./typeGuards";

describe("isRecord / asRecord", () => {
  it("accepts plain objects and rejects arrays, null and primitives", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it("asRecord returns the record or undefined", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
  });
});

describe("isNonEmptyString", () => {
  it("requires at least one non-whitespace character", () => {
    expect(isNonEmptyString("a")).toBe(true);
    expect(isNonEmptyString("  a  ")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString("   ")).toBe(false);
    expect(isNonEmptyString(1)).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
  });
});

describe("toFiniteNumber", () => {
  it("accepts numbers and numeric strings, including the string decimals a driver returns", () => {
    expect(toFiniteNumber(12)).toBe(12);
    expect(toFiniteNumber(-0.5)).toBe(-0.5);
    expect(toFiniteNumber("1234.5600")).toBe(1234.56);
    expect(toFiniteNumber(" 7 ")).toBe(7);
    expect(toFiniteNumber("0")).toBe(0);
  });

  it("rejects the values a blind Number() would turn into a silent zero", () => {
    expect(toFiniteNumber(null)).toBeUndefined();
    expect(toFiniteNumber(undefined)).toBeUndefined();
    expect(toFiniteNumber("")).toBeUndefined();
    expect(toFiniteNumber("   ")).toBeUndefined();
    expect(toFiniteNumber([])).toBeUndefined();
    expect(toFiniteNumber(true)).toBeUndefined();
    expect(toFiniteNumber("abc")).toBeUndefined();
    expect(toFiniteNumber(Number.NaN)).toBeUndefined();
    expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toFiniteNumber("Infinity")).toBeUndefined();
  });
});

describe("toPositiveInteger", () => {
  it("accepts positive integers from either representation", () => {
    expect(toPositiveInteger(3)).toBe(3);
    expect(toPositiveInteger("42")).toBe(42);
  });

  it("rejects zero, negatives, fractions and non-numerics", () => {
    expect(toPositiveInteger(0)).toBeUndefined();
    expect(toPositiveInteger(-1)).toBeUndefined();
    expect(toPositiveInteger(1.5)).toBeUndefined();
    expect(toPositiveInteger("1.5")).toBeUndefined();
    expect(toPositiveInteger(null)).toBeUndefined();
    expect(toPositiveInteger("")).toBeUndefined();
  });
});
