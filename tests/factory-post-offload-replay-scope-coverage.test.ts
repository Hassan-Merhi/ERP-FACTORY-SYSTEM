/**
 * Post-offload phase 6 replay-scope parsing and the small numeric helpers it
 * ships with. These guard the stored dry-run token: any malformed scope must
 * be refused (null) rather than silently widened or narrowed.
 */
import { describe, expect, it } from "vitest";

import {
  count,
  decimal,
  emptyScope,
  InvalidPostOffloadPhase6TokenError,
  parseReplayScope,
  requestedSupplierIds,
  scopeCounts,
  sha256,
  stableHash,
  StalePostOffloadPhase6TokenError,
  uniqueSortedNumbers,
} from "../server/services/factory/postOffloadPhase6SafetyImplParseReplayScope";

function validScope(): Record<string, unknown> {
  return {
    supplierIds: [3, "1", 3],
    containerIdsToUpdate: [10],
    rawStockIdsToUpdate: [],
    sourceIdsToUpdate: [7, 5],
    batchIdsToUpdate: [2],
    availableBaleIdsToUpdate: [9],
    finalizedBaleIdsToUpdate: [8],
    blockedBatches: [
      { batchId: 4, batchCode: "B4", reasons: ["z", "a", "z"] },
      { batchId: 1, batchCode: "B1", reasons: [] },
    ],
  };
}

describe("parseReplayScope", () => {
  it("normalises a valid scope: dedupes, sorts ids and reasons, orders blocked batches", () => {
    expect(parseReplayScope(validScope())).toEqual({
      supplierIds: [1, 3],
      containerIdsToUpdate: [10],
      rawStockIdsToUpdate: [],
      sourceIdsToUpdate: [5, 7],
      batchIdsToUpdate: [2],
      availableBaleIdsToUpdate: [9],
      finalizedBaleIdsToUpdate: [8],
      blockedBatches: [
        { batchId: 1, batchCode: "B1", reasons: [] },
        { batchId: 4, batchCode: "B4", reasons: ["a", "z"] },
      ],
    });
  });

  it("refuses non-object input", () => {
    expect(parseReplayScope(null)).toBeNull();
    expect(parseReplayScope(undefined)).toBeNull();
    expect(parseReplayScope("scope")).toBeNull();
    expect(parseReplayScope(42)).toBeNull();
  });

  it.each([
    "supplierIds",
    "containerIdsToUpdate",
    "rawStockIdsToUpdate",
    "sourceIdsToUpdate",
    "batchIdsToUpdate",
    "availableBaleIdsToUpdate",
    "finalizedBaleIdsToUpdate",
  ])("refuses a scope whose %s is missing or holds a bad id", (key) => {
    const missing = validScope();
    delete missing[key];
    expect(parseReplayScope(missing)).toBeNull();
    expect(parseReplayScope({ ...validScope(), [key]: "1,2" })).toBeNull();
    expect(parseReplayScope({ ...validScope(), [key]: [1, 0] })).toBeNull();
    expect(parseReplayScope({ ...validScope(), [key]: [1.5] })).toBeNull();
    expect(parseReplayScope({ ...validScope(), [key]: ["abc"] })).toBeNull();
  });

  it("refuses a scope whose blockedBatches is not an array", () => {
    expect(parseReplayScope({ ...validScope(), blockedBatches: {} })).toBeNull();
    const missing = validScope();
    delete missing.blockedBatches;
    expect(parseReplayScope(missing)).toBeNull();
  });

  it.each([
    ["a null entry", null],
    ["a string entry", "B1"],
    ["a string batchId", { batchId: "1", batchCode: "B1", reasons: [] }],
    ["a fractional batchId", { batchId: 1.5, batchCode: "B1", reasons: [] }],
    ["a numeric batchCode", { batchId: 1, batchCode: 1, reasons: [] }],
    ["reasons that are not an array", { batchId: 1, batchCode: "B1", reasons: "late" }],
    ["a non-string reason", { batchId: 1, batchCode: "B1", reasons: ["ok", 3] }],
  ])("refuses a blocked batch with %s", (_label, entry) => {
    expect(parseReplayScope({ ...validScope(), blockedBatches: [entry] })).toBeNull();
  });
});

describe("requestedSupplierIds", () => {
  it("treats null and undefined as no suppliers", () => {
    expect(requestedSupplierIds(null)).toEqual([]);
    expect(requestedSupplierIds(undefined)).toEqual([]);
  });

  it("dedupes and sorts numeric strings", () => {
    expect(requestedSupplierIds(["5", 2, 5])).toEqual([2, 5]);
  });

  it("refuses a non-array with a 400 token error", () => {
    let caught: unknown;
    try {
      requestedSupplierIds("5");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidPostOffloadPhase6TokenError);
    expect(caught).toMatchObject({
      code: "POST_OFFLOAD_PHASE6_TOKEN_INVALID",
      statusCode: 400,
      name: "InvalidPostOffloadPhase6TokenError",
      message: "supplierIds must be an array of positive integers.",
    });
  });

  it("refuses non-positive or fractional ids", () => {
    expect(() => requestedSupplierIds([1, -2])).toThrow("supplierIds must contain only positive integers.");
    expect(() => requestedSupplierIds([1.25])).toThrow(InvalidPostOffloadPhase6TokenError);
  });
});

describe("phase 6 numeric helpers", () => {
  it("count parses integers and falls back to zero", () => {
    expect(count("12")).toBe(12);
    expect(count(7)).toBe(7);
    expect(count(null)).toBe(0);
    expect(count(undefined)).toBe(0);
    expect(count("not a number")).toBe(0);
  });

  it("decimal parses values and falls back to zero for null, junk and infinity", () => {
    expect(decimal("1.25").toFixed(2)).toBe("1.25");
    expect(decimal(3).toNumber()).toBe(3);
    expect(decimal(null).toNumber()).toBe(0);
    expect(decimal(undefined).toNumber()).toBe(0);
    expect(decimal("abc").toNumber()).toBe(0);
    expect(decimal("Infinity").toNumber()).toBe(0);
  });

  it("scopeCounts totals the writable rows and supplier rate changes", () => {
    const scope = parseReplayScope(validScope())!;
    expect(scopeCounts(scope, 4)).toEqual({
      suppliers: 2,
      containers: 1,
      rawStockRows: 0,
      supplierSources: 2,
      batches: 1,
      availableBales: 1,
      finalizedBalesExcluded: 1,
      blockedBatches: 2,
      supplierRateChanges: 4,
      actualChangeRows: 9,
      totalWritableRows: 7,
    });
    expect(scopeCounts(emptyScope())).toMatchObject({
      supplierRateChanges: 0,
      actualChangeRows: 0,
      totalWritableRows: 0,
    });
  });

  it("hashes deterministically and dedupes number lists", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(stableHash({ a: 1 })).toBe(sha256('{"a":1}'));
    expect(uniqueSortedNumbers([3, 1, 3, 2])).toEqual([1, 2, 3]);
  });

  it("the stale token error carries a 409 and a default message", () => {
    const stale = new StalePostOffloadPhase6TokenError();
    expect(stale).toMatchObject({ code: "POST_OFFLOAD_PHASE6_TOKEN_STALE", statusCode: 409 });
    expect(stale.message).toMatch(/Re-run the dry-run plan/);
    expect(new StalePostOffloadPhase6TokenError("custom").message).toBe("custom");
  });
});
