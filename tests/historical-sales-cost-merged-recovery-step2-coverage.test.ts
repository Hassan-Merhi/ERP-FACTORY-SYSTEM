/**
 * Historical sales-cost repair, merged stock-item recovery stage 2: rewinding
 * the kept item to the merge, splitting the source's share, rewinding the
 * source to its opening and reconciling that opening. The stage is a pure
 * function of the stage-1 result, so each case builds that result directly.
 *
 * Inventory states are written as quantity / average rate / total value.
 * Exact valuation-reset movements make a rewind step fully determined (or
 * refused); an unpriced issue of 1000 out of a 1-unit remainder admits 21
 * exact pre-issue rates, which drives the multi-branch paths.
 */
import { describe, expect, it } from "vitest";

import {
  createHistoricalInventoryStateFromSnapshot,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
} from "../server/services/inventory/historicalSalesCostRepairEngine";
import { historicalSalesCostRepairRecoveryStep2 } from "../server/services/inventory/historicalSalesCostRepairRecoveryStep2";
import type { RepairCheck } from "../server/services/inventory/historicalSalesCostRepairTypes";

const SOURCE = 7;
const KEPT = 8;
const MERGE_AT = Date.parse("2026-03-01T00:00:00Z");

const st = (quantity: string, rate: string, value: string) =>
  createHistoricalInventoryStateFromSnapshot(quantity, rate, value);
const show = (state: HistoricalInventoryState) =>
  `${state.quantity.toFixed(3)}/${state.averageRate.toFixed(2)}/${state.totalValue.toFixed(2)}`;

let sequence = 0;
function movement(overrides: Partial<HistoricalSalesRepairMovement>): HistoricalSalesRepairMovement {
  sequence += 1;
  return {
    movementId: `m${sequence}`,
    companyId: 1,
    locationId: 1,
    stockItemId: SOURCE,
    occurredAt: new Date(MERGE_AT - 86_400_000 + sequence * 1000).toISOString(),
    sequence,
    quantityDelta: "0",
    unitCost: null,
    sourceType: "sale",
    sourceId: String(sequence),
    evidence: "legacy",
    ...overrides,
  };
}

/** An exact valuation reset whose inverse is `before` only when the state equals `after`. */
const reset = (locationId: number, stockItemId: number, before: string[], after: string[]) =>
  movement({
    locationId,
    stockItemId,
    sourceType: "inventory-valuation-override",
    valuationReset: {
      beforeQuantity: before[0],
      beforeAverageRate: before[1],
      beforeTotalValue: before[2],
      afterQuantity: after[0],
      afterAverageRate: after[1],
      afterTotalValue: after[2],
    },
  });

const sale = (
  locationId: number,
  stockItemId: number,
  quantity: string,
  overrides: Partial<HistoricalSalesRepairMovement> = {}
) =>
  movement({
    locationId,
    stockItemId,
    quantityDelta: `-${quantity}`,
    sale: {
      salesItemId: sequence + 1000,
      voucherId: 1,
      quantity,
      totalSales: "5000",
      originalCostPrice: "2",
      originalTotalCost: "2",
      originalProfit: "0",
    },
    ...overrides,
  });

interface Hrr1Input {
  combined: Array<[number, HistoricalInventoryState]>;
  keptBefore?: Array<[number, HistoricalInventoryState]>;
  keptPost?: HistoricalSalesRepairMovement[];
  sourcePre?: HistoricalSalesRepairMovement[];
  locations: number[];
  targets?: number[];
  opening?: [string, string, string];
  keptRewindFailure?: { locationId: number; detail: string } | null;
}

function run(input: Hrr1Input) {
  const [qty, rate, value] = input.opening ?? ["0", "0", "0"];
  const hrr1 = {
    done: false,
    merge: { kept_opening_rate: "2" },
    mergeAtMs: MERGE_AT,
    sourceOpeningQty: st(qty, rate, value).quantity,
    sourceOpeningRate: st(qty, rate, value).averageRate,
    sourceOpeningValue: st(qty, rate, value).totalValue,
    sourceTargetKeys: [],
    sourceTargetLocations: input.targets ?? [],
    sourcePreMovements: input.sourcePre ?? [],
    keptPostMovements: input.keptPost ?? [],
    relevantLocations: new Set(input.locations),
    keptBeforeByLocation: new Map(input.keptBefore ?? []),
    combinedAtMergeByLocation: new Map(input.combined),
    keptRewindFailure: input.keptRewindFailure ?? null,
  };
  const blocks: Array<{ code: string; detail: string }> = [];
  const checks: RepairCheck[] = [];
  const result = historicalSalesCostRepairRecoveryStep2({
    hrr1: hrr1 as never,
    priorCostMemoryRateHints: new Map(),
    input: { companyId: 1 } as never,
    sourceItemId: SOURCE,
    allMovements: [...(input.sourcePre ?? []), ...(input.keptPost ?? [])],
    blockSourceKeys: (_source, code, detail) => blocks.push({ code, detail }),
    checks,
  });
  return { result, blocks, checks, combined: hrr1.combinedAtMergeByLocation };
}

describe("merged recovery: kept item rewind", () => {
  it("rewinds the kept item, splits the source and recovers its opening and sale cost", () => {
    const keptReset = reset(1, KEPT, ["10", "2", "20"], ["12", "2", "24"]);
    const elsewhere = reset(9, KEPT, ["1", "1", "1"], ["2", "2", "4"]);
    const sourceSale = sale(1, SOURCE, "2", { unitCost: "2" });
    const { result, blocks, checks } = run({
      combined: [
        [1, st("12", "2", "24")],
        [2, st("3", "2", "6")],
      ],
      keptBefore: [[1, st("4", "2", "8")]],
      keptPost: [keptReset, elsewhere],
      sourcePre: [sourceSale],
      locations: [1, 2],
      targets: [2],
      opening: ["13", "2", "26"],
    });
    expect(blocks).toEqual([]);
    expect(checks).toEqual([]);
    expect(result.done).toBe(false);
    if (result.done) return;
    expect(show(result.sourceAtMergeByLocation.get(1)!)).toBe("6.000/2.00/12.00");
    // Location 2 has no kept history, so the kept side opens empty at the merge's kept rate.
    expect(show(result.sourceAtMergeByLocation.get(2)!)).toBe("3.000/2.00/6.00");
    expect(show(result.openingByLocation.get(1)!)).toBe("8.000/2.00/16.00");
    expect(result.tempProposals).toHaveLength(1);
    expect(result.tempProposals[0]).toMatchObject({ proposedCostPrice: "2.00", stockItemId: SOURCE });
    expect(result.remainingOpeningQty.toFixed(3)).toBe("2.000");
    expect(result.remainingOpeningValue.toFixed(2)).toBe("4.00");
    expect(result.unresolvedWithActivity).toEqual([]);
  });

  it("stops at once when stage 1 already failed the kept rewind", () => {
    const { result, blocks } = run({
      combined: [[1, st("1", "1", "1")]],
      locations: [1],
      keptRewindFailure: { locationId: 1, detail: "stage one failed" },
    });
    expect(result).toEqual({ done: true, value: undefined });
    expect(blocks).toEqual([{ code: "MERGED_ITEM_KEPT_REWIND_FAILED", detail: "stage one failed" }]);
  });

  it("blocks a kept movement that cannot be reversed", () => {
    const bad = reset(1, KEPT, ["1", "1", "1"], ["99", "1", "99"]);
    const { blocks } = run({ combined: [[1, st("10", "2", "20")]], keptPost: [bad], locations: [1] });
    expect(blocks).toEqual([
      {
        code: "MERGED_ITEM_KEPT_REWIND_FAILED",
        detail: `Cannot rewind kept item movement ${bad.movementId}: MOVEMENT_INVERSE_INVALID`,
      },
    ]);
  });

  it("blocks a canonical kept sale whose recorded live rate disagrees with every branch", () => {
    const recorded = sale(1, KEPT, "2", { evidence: "canonical", sourceType: "pos-sale", unitCost: "3" });
    const { blocks } = run({ combined: [[1, st("8", "2", "16")]], keptPost: [recorded], locations: [1] });
    expect(blocks).toEqual([
      {
        code: "MERGED_ITEM_KEPT_REWIND_FAILED",
        detail: `Canonical kept-item sale ${recorded.movementId} disagrees with every exact checkpoint rewind branch`,
      },
    ]);
  });

  it("blocks when the kept rewind exceeds the branch limit", () => {
    const first = sale(1, KEPT, "1000000", { evidence: "canonical", sourceType: "stock-transfer", unitCost: "2" });
    const second = sale(1, KEPT, "1000", { evidence: "canonical", sourceType: "stock-transfer", unitCost: "2" });
    const { blocks } = run({ combined: [[1, st("1", "2", "2")]], keptPost: [second, first], locations: [1] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toBe("MERGED_ITEM_KEPT_REWIND_FAILED");
    expect(blocks[0].detail).toBe(`Kept item rewind exceeded the branch limit at ${first.movementId}`);
  });

  it("selects the one branch a zero-opening source allows, else refuses the ambiguity", () => {
    const issue = () => sale(1, KEPT, "1000", { evidence: "canonical", sourceType: "stock-transfer", unitCost: "2" });
    const chosen = run({
      combined: [[1, st("1", "2", "2")]],
      keptBefore: [[1, st("1001", "2.05", "2052")]],
      keptPost: [issue()],
      locations: [1],
    });
    expect(chosen.blocks).toEqual([]);
    expect(show(chosen.combined.get(1)!)).toBe("1001.000/2.05/2052.00");
    expect(chosen.result.done).toBe(false);
    if (!chosen.result.done) expect(chosen.result.unresolvedWithActivity).toEqual([]);

    const ambiguous = run({
      combined: [[1, st("1", "2", "2")]],
      keptBefore: [[1, st("5", "2", "10")]],
      keptPost: [issue()],
      locations: [1],
    });
    expect(ambiguous.blocks).toEqual([
      { code: "MERGED_ITEM_KEPT_REWIND_FAILED", detail: "Kept item rewind has 21 exact states at the merge" },
    ]);

    const fundedSource = run({
      combined: [[1, st("1", "2", "2")]],
      keptPost: [issue()],
      locations: [1],
      opening: ["5", "2", "10"],
    });
    expect(fundedSource.blocks[0].detail).toBe("Kept item rewind has 21 exact states at the merge");
  });

  it("deduplicates a legacy unpriced sale whose inverse candidate equals the primary inverse", () => {
    const legacy = sale(1, KEPT, "2");
    const { result, blocks } = run({
      combined: [[1, st("6", "2", "12")]],
      keptBefore: [[1, st("8", "2", "16")]],
      keptPost: [legacy],
      locations: [1],
    });
    expect(blocks).toEqual([]);
    expect(result.done).toBe(false);
  });
});

describe("merged recovery: source split and rewind", () => {
  it("blocks a negative source value and a split that does not replay", () => {
    const negative = run({
      combined: [[1, st("10", "2", "20")]],
      keptBefore: [[1, st("5", "5", "25")]],
      locations: [1],
    });
    expect(negative.blocks).toEqual([
      { code: "MERGED_ITEM_VALUE_SPLIT_FAILED", detail: "Merge subtraction produced negative source value -5.00" },
    ]);
    const mismatch = run({
      combined: [[1, st("10", "2.5", "20")]],
      keptBefore: [[1, st("4", "2", "8")]],
      locations: [1],
    });
    expect(mismatch.blocks).toEqual([
      {
        code: "MERGED_ITEM_VALUE_SPLIT_FAILED",
        detail: "Source/kept split does not replay the exact post-merge checkpoint-rewound state",
      },
    ]);
  });

  it("treats an empty source share as unresolved and reports it only with activity", () => {
    const { result } = run({
      combined: [
        [1, st("4", "2", "8")],
        [2, st("0", "0", "0")],
        [3, st("0", "0", "0")],
      ],
      keptBefore: [[1, st("4", "2", "8")]],
      sourcePre: [reset(3, SOURCE, ["0", "0", "0"], ["0", "0", "0"])],
      locations: [1, 2, 3],
      opening: ["0", "3", "0"],
    });
    expect(result.done).toBe(false);
    if (result.done) return;
    expect(show(result.sourceAtMergeByLocation.get(1)!)).toBe("0.000/3.00/0.00");
    expect(result.unresolvedWithActivity).toEqual([3]);
    expect(result.openingByLocation.size).toBe(0);
  });

  it("blocks a source movement that cannot be reversed", () => {
    const bad = reset(1, SOURCE, ["1", "1", "1"], ["99", "1", "99"]);
    const { blocks } = run({
      combined: [[1, st("6", "2", "12")]],
      sourcePre: [bad],
      locations: [1],
      opening: ["6", "2", "12"],
    });
    expect(blocks).toEqual([
      {
        code: "MERGED_ITEM_SOURCE_REWIND_FAILED",
        detail: `Cannot rewind source movement ${bad.movementId}: MOVEMENT_INVERSE_INVALID`,
      },
    ]);
  });

  it("flags a source sale with more than one exact pre-sale rate", () => {
    const unpriced = sale(1, SOURCE, "1000");
    const { result, checks } = run({
      combined: [[1, st("1", "2", "2")]],
      sourcePre: [unpriced],
      locations: [1],
      opening: ["1001", "2", "2002"],
    });
    expect(result.done).toBe(false);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ code: "LEGACY_SALE_INVERSE_NOT_UNIQUE", status: "block", expected: "2.00" });
    expect(checks[0].actual?.split(",")).toHaveLength(20);
  });

  it("blocks when the rewind recovers more than the source opening", () => {
    const { blocks } = run({
      combined: [[1, st("6", "2", "12")]],
      sourcePre: [sale(1, SOURCE, "2", { unitCost: "2" })],
      locations: [1],
      opening: ["7", "2", "14"],
    });
    expect(blocks).toEqual([
      {
        code: "MERGED_ITEM_OPENING_RECONCILIATION_FAILED",
        detail: "Rewind exceeded source opening: remaining -1.000 / -2.00",
      },
    ]);
  });
});
