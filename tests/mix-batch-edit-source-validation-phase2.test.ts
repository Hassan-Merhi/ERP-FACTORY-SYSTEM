import { describe, expect, it } from "vitest";
import {
  MixEditRequestError,
  mixEditReviewHash,
  parseMixEditSelection,
  sameMixEditSources,
} from "../server/services/factory/mixBatchEditRequest";

describe("factory mix batch source editing safeguards — Phase 2", () => {
  it("normalizes kg to exactly three decimals without accepting cost overrides", () => {
    const selection = parseMixEditSelection({
      supplierSources: [{ supplierId: 7, weightKg: "11.5", costPerKg: 999999 }],
      batchSources: [{ sourceBatchId: 9, weightKg: "0.125", costPerKg: -1 }],
    });
    expect(selection).toEqual({
      supplierSources: [{ supplierId: 7, weightKg: "11.500" }],
      batchSources: [{ sourceBatchId: 9, weightKg: "0.125" }],
      totalWeightKg: "11.625",
    });
  });

  it.each([
    { supplierSources: [{ supplierId: 1, weightKg: "0" }], batchSources: [] },
    { supplierSources: [{ supplierId: 1, weightKg: "1.0001" }], batchSources: [] },
    { supplierSources: [{ supplierId: 1, weightKg: "1e8" }], batchSources: [] },
    { supplierSources: [{ supplierId: "1", weightKg: "2" }], batchSources: [] },
    { supplierSources: [{ supplierId: 1, weightKg: "-1" }], batchSources: [] },
    { supplierSources: [{ supplierId: 1, weightKg: "2abc" }], batchSources: [] },
    {
      supplierSources: [
        { supplierId: 1, weightKg: "1" },
        { supplierId: 1, weightKg: "2" },
      ],
      batchSources: [],
    },
    { supplierSources: [], batchSources: [] },
    { supplierSources: [{ supplierId: 2, weightKg: "1" }] },
  ])("rejects unsafe or ambiguous source lists %#", (payload) => {
    expect(() => parseMixEditSelection(payload)).toThrow(MixEditRequestError);
  });

  it("considers a historical batch unchanged when all source IDs and aggregate kg match", () => {
    const oldSources = [
      { supplierId: 11, sourceBatchId: null, weightKg: "300.000" },
      { supplierId: 11, sourceBatchId: null, weightKg: "200.000" },
      { supplierId: null, sourceBatchId: 99, weightKg: "3.000" },
    ];
    const unchanged = parseMixEditSelection({
      supplierSources: [{ supplierId: 11, weightKg: "500" }],
      batchSources: [{ sourceBatchId: 99, weightKg: "3" }],
    });
    const changed = parseMixEditSelection({
      supplierSources: [{ supplierId: 11, weightKg: "499.999" }],
      batchSources: [{ sourceBatchId: 99, weightKg: "3" }],
    });
    expect(sameMixEditSources(oldSources, unchanged)).toBe(true);
    expect(sameMixEditSources(oldSources, changed)).toBe(false);
  });

  it("changes the review hash when an original value, proposed source or supplier rate changes", () => {
    const base = { batchId: 22, kg: "100", rate: "0.512300", selected: [{ supplierId: 5, weightKg: "100.000" }] };
    const expected = mixEditReviewHash(base);
    expect(mixEditReviewHash(base)).toBe(expected);
    expect(mixEditReviewHash({ ...base, rate: "0.512301" })).not.toBe(expected);
    expect(mixEditReviewHash({ ...base, kg: "101" })).not.toBe(expected);
  });
});
