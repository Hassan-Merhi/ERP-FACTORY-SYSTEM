import { describe, expect, it } from "vitest";
import { rewindCheckpointToLegacySales } from "../server/services/inventory/historicalSalesCostRepairRewind";
import {
  createHistoricalInventoryStateFromSnapshot,
  type HistoricalSalesRepairMovement,
} from "../server/services/inventory/historicalSalesCostRepairEngine";
import { movementKey } from "../server/services/inventory/historicalSalesCostRepairEvidence";
import type { RepairCheck } from "../server/services/inventory/historicalSalesCostRepairTypes";
import { movement } from "./helpers/historicalSalesCostRepairMovement";

// Branch coverage for the checkpoint rewind driven through the real reverse
// engine: rate-only recoveries, irreversible and contradicted boundaries,
// recorded-rate era boundaries, branching alternates (promotion, pruning,
// overflow, finished), legacy inverse ambiguity and error amplification.
const KEY = "1:10:100";

function sale(salesItemId: number, quantity: string) {
  return {
    salesItemId,
    voucherId: salesItemId,
    quantity,
    totalSales: "100",
    originalCostPrice: "0",
    originalTotalCost: "0",
    originalProfit: "0",
  };
}

type MovementOverrides = Partial<HistoricalSalesRepairMovement>;
const legacy = (movementId: string, sequence: number, quantityDelta: string, overrides: MovementOverrides = {}) =>
  movement({ movementId, sequence, quantityDelta, ...overrides });
const canonical = (movementId: string, sequence: number, quantityDelta: string, overrides: MovementOverrides = {}) =>
  movement({ movementId, sequence, quantityDelta, evidence: "canonical", ...overrides });

type RewindInput = Parameters<typeof rewindCheckpointToLegacySales>[0];

/** Rewinds newest-first `movements` from the checkpoint state `after` at the one test key. */
function rewind(
  after: [string, string, string],
  movements: HistoricalSalesRepairMovement[],
  overrides: Partial<RewindInput> = {}
) {
  const checks: RepairCheck[] = [];
  const proposalsBySaleId = new Map();
  const trace: string[] = [];
  const rewindStates = new Map([[KEY, createHistoricalInventoryStateFromSnapshot(...after)]]);
  const legacySales = movements.filter((row) => row.sale && row.evidence === "legacy");
  const output = rewindCheckpointToLegacySales({
    companyId: 1,
    traceRewind: (key, line) => trace.push(`${key} ${line}`),
    checks,
    proposalsBySaleId,
    unavailableKeys: new Set(),
    checkpointTargetKeys: new Set([KEY]),
    rewindStates,
    movementsInCheckpoint: movements,
    priorCostMemoryRateHints: new Map(),
    targetLegacySaleMovementsByKey: new Map([[KEY, legacySales]]),
    forwardReplayResolvedKeys: new Set(),
    movementsAscending: [...movements].reverse(),
    forwardResetProvenSaleIds: new Set(),
    ...overrides,
  });
  const codes = checks.map(
    (check) => `${check.code}:${check.status}${check.salesItemId ? ":" + check.salesItemId : ""}`
  );
  const costs = Object.fromEntries([...proposalsBySaleId.values()].map((p) => [p.salesItemId, p.proposedCostPrice]));
  const state = rewindStates.get(KEY)!;
  return {
    checks,
    codes,
    costs,
    trace,
    output,
    state: `${state.quantity.toFixed(3)}|${state.averageRate.toFixed(2)}|${state.totalValue.toFixed(2)}`,
  };
}

describe("rewindCheckpointToLegacySales rate-only recoveries", () => {
  it("records a canonical rate-only recovery and prices the legacy sale below it", () => {
    const result = rewind(
      ["455", "59.63", "27135.99"],
      [
        canonical("c1", 2, "4", { unitCost: "59.630000", sourceType: "pos-sale" }),
        legacy("s1", 1, "-1", { sale: sale(11, "1") }),
      ]
    );
    expect(result.codes).toEqual(["CANONICAL_REWIND_RATE_ONLY_RECOVERED:pass"]);
    expect(result.checks[0]).toMatchObject({
      expected: "455.000|27135.99",
      actual: "455.000|27135.99",
    });
    expect(result.checks[0].detail).toMatch(/^Canonical boundary c1 recovered .* Prior rate=59\.64$/);
    expect(result.costs).toEqual({ 11: "59.64" });
    expect(result.trace[0]).toContain("via CANONICAL_RATE_ONLY");
    expect(result.trace[1]).toContain("sale=11");
  });

  it("records a legacy issue rate-only recovery", () => {
    const result = rewind(
      ["62", "94.62", "5872.89"],
      [legacy("s2", 2, "-1", { sourceType: "legacy-sale", sale: sale(12, "1") })]
    );
    expect(result.codes).toEqual(["LEGACY_REWIND_RATE_ONLY_RECOVERED:pass"]);
    expect(result.checks[0].detail).toMatch(/^Legacy sale boundary s2 recovered .* Prior rate=94\.72$/);
    expect(result.costs).toEqual({ 12: "94.72" });
  });

  it("records a canonical stock-adjustment edit value recovery", () => {
    const result = rewind(
      ["232", "67.75", "15757.78"],
      [canonical("c3", 2, "-1", { unitCost: "67.750000", sourceType: "stock_adjustment_edit_apply" })]
    );
    expect(result.codes).toEqual(["CANONICAL_ADJUSTMENT_EDIT_VALUE_RECOVERED:pass"]);
    expect(result.checks[0]).toMatchObject({ expected: "232.000|15757.78", actual: "232.000|15757.78" });
    expect(result.checks[0].detail).toMatch(/Prior rate=67\.92$/);
    expect(result.state).toBe("233.000|67.92|15825.53");
  });

  it("records a legacy offload receipt rate-only recovery", () => {
    const result = rewind(
      ["115", "78.25", "8969.47"],
      [
        legacy("o4", 2, "6", {
          unitCost: "84.54",
          exactValue: "507.24",
          sourceType: "legacy-container-offload",
          sourceId: "438",
        }),
      ]
    );
    expect(result.codes).toEqual(["LEGACY_RECEIPT_RATE_ONLY_RECOVERED:pass"]);
    expect(result.checks[0]).toMatchObject({ expected: "115.000|8969.47", actual: "115.000|8969.47" });
    expect(result.checks[0].detail).toMatch(/^Legacy offload boundary o4 .* Prior rate=77\.64$/);
  });

  it("records a canonical recorded issue-rate recovery without a cost mismatch", () => {
    const result = rewind(
      ["0", "72.56", "0.00"],
      [canonical("c5", 2, "-1", { unitCost: "72.55", sourceType: "pos-sale", sale: sale(15, "1") })]
    );
    expect(result.codes).toEqual(["CANONICAL_RECORDED_SALE_RATE_RECOVERED:pass"]);
    expect(result.checks[0]).toMatchObject({ expected: "72.55", actual: "72.55" });
    expect(result.costs).toEqual({ 15: "72.55" });
    // Zero stock after the sale: sensitivity starts at 1.
    expect(result.output.rewindAmplification.get(KEY)?.max.toFixed(3)).toBe("1.000");
  });
});

describe("rewindCheckpointToLegacySales irreversible boundaries", () => {
  it("blocks a legacy sale below an irreversible receipt into negative stock", () => {
    const result = rewind(
      ["3", "12", "36"],
      [
        legacy("r6", 3, "5", { unitCost: "12" }),
        legacy("s6", 2, "-1", { sale: sale(16, "1") }),
        canonical("c6", 1, "-1", { sale: sale(17, "1") }),
      ]
    );
    expect(result.codes).toEqual([
      "REWIND_BOUNDARY_DIAGNOSTIC:warning",
      "LEGACY_REWIND_COST_MEMORY_IRREVERSIBLE:block:16",
    ]);
    expect(result.checks[0]).toMatchObject({ expected: "3.000|12.00|36.00", actual: "5.000|12|null" });
    expect(result.checks[0].detail).toContain(
      "reason=COST_MEMORY_IRREVERSIBLE boundary=r6 sourceType=test evidence=legacy"
    );
    expect(result.checks[1].detail).toBe("Sales item 16 predates irreversible valuation boundary r6");
    // Nothing below the boundary is rewound.
    expect(result.costs).toEqual({});
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toContain("IRREVERSIBLE COST_MEMORY_IRREVERSIBLE");
  });

  it("blocks a legacy sale that is itself the irreversible boundary", () => {
    const result = rewind(["3", "12", "36"], [legacy("s7", 2, "5", { unitCost: "12", sale: sale(19, "5") })]);
    expect(result.codes).toEqual([
      "REWIND_BOUNDARY_DIAGNOSTIC:warning",
      "LEGACY_REWIND_COST_MEMORY_IRREVERSIBLE:block:19",
    ]);
  });

  it("names the canonical boundary and the prior-rate hint in the diagnostic", () => {
    const result = rewind(
      ["3", "12", "36"],
      [canonical("r7", 3, "5", { unitCost: "12" }), legacy("s7", 2, "-1", { sale: sale(17, "1") })],
      { priorCostMemoryRateHints: new Map([["other", "1"]]) }
    );
    expect(result.codes).toEqual([
      "REWIND_BOUNDARY_DIAGNOSTIC:warning",
      "CHECKPOINT_REWIND_COST_MEMORY_IRREVERSIBLE:block:17",
    ]);
  });

  it("passes when no target sale lies below the irreversible boundary", () => {
    const result = rewind(["3", "12", "36"], [canonical("r7", 3, "5", { unitCost: "12" })]);
    expect(result.codes).toEqual(["REWIND_BOUNDARY_DIAGNOSTIC:warning", "REWIND_RESET_BOUNDARY_REACHED:pass"]);
    expect(result.checks[1].detail).toBe(
      "Stopped safely at r7 because no target historical sale exists before the irreversible valuation boundary"
    );
  });

  it("does not block a sale already proven by a forward reset", () => {
    const result = rewind(
      ["3", "12", "36"],
      [legacy("r6", 3, "5", { unitCost: "12" }), legacy("s6", 2, "-1", { sale: sale(16, "1") })],
      { forwardResetProvenSaleIds: new Set([16]) }
    );
    expect(result.codes).toEqual(["REWIND_BOUNDARY_DIAGNOSTIC:warning", "REWIND_RESET_BOUNDARY_REACHED:pass"]);
  });

  it("blocks sales above an impossible empty-stock receipt when a forward replay disagrees", () => {
    const result = rewind(
      ["4", "12.50", "50.00"],
      [legacy("s8", 3, "-1", { sale: sale(18, "1") }), legacy("r8", 2, "5", { unitCost: "12" })]
    );
    expect(result.codes).toEqual([
      "REWIND_BOUNDARY_DIAGNOSTIC:warning",
      "CHECKPOINT_REWIND_CONTRADICTED_BELOW:block:18",
      "REWIND_CONTRADICTION_TWO_SIDED:warning",
      "REWIND_RESET_BOUNDARY_REACHED:pass",
    ]);
    expect(result.checks[1]).toMatchObject({ expected: "12.50", actual: "12.00" });
    expect(result.checks[1].detail).toBe(
      "Sales item 18 was rewound from a state contradicted by r8 (forward replay from the empty-stock receipt disagrees)"
    );
    expect(result.checks[2]).toMatchObject({ expected: "1", actual: "0" });
    expect(result.checks[2].detail).toBe(
      "0 of 1 legacy sales above impossible inverse r8 have the same cost from the checkpoint rewind and from a forward replay of the empty-stock receipt"
    );
  });

  it("keeps sales above an impossible receipt when the forward replay reaches the same cost", () => {
    const result = rewind(
      ["4", "12.00", "48.01"],
      [legacy("s9", 3, "-1", { sale: sale(19, "1") }), legacy("r9", 2, "5", { unitCost: "12" })]
    );
    expect(result.codes).toEqual([
      "REWIND_BOUNDARY_DIAGNOSTIC:warning",
      "REWIND_CONTRADICTION_TWO_SIDED:warning",
      "REWIND_RESET_BOUNDARY_REACHED:pass",
    ]);
    expect(result.checks[1]).toMatchObject({ expected: "1", actual: "1" });
    expect(result.costs).toEqual({ 19: "12.00" });
  });

  it("marks sales above an impossible inverse undetermined when the receipt did not start from empty stock", () => {
    // Rewinding 3 units at 12 out of 5 units worth 5.00 would leave negative value in 2 units.
    const result = rewind(
      ["4", "1", "4"],
      [legacy("s8", 3, "-1", { sale: sale(18, "1") }), legacy("r8", 2, "3", { unitCost: "12" })]
    );
    expect(result.checks[0].detail).toContain("reason=MOVEMENT_INVERSE_INVALID boundary=r8");
    expect(result.codes).toContain("CHECKPOINT_REWIND_CONTRADICTED_BELOW:block:18");
    const contradicted = result.checks.find((check) => check.code === "CHECKPOINT_REWIND_CONTRADICTED_BELOW")!;
    expect(contradicted.actual).toBe("undetermined");
    expect(contradicted.detail).toContain("(no fully determined state below)");
    expect(result.checks.find((check) => check.code === "REWIND_CONTRADICTION_TWO_SIDED")!.detail).toContain(
      "and from no independent forward state"
    );
  });
});

describe("rewindCheckpointToLegacySales canonical recorded-rate boundaries", () => {
  const eraMovements = (between: HistoricalSalesRepairMovement[]) => [
    canonical("b10", 4, "-1", { unitCost: "15", sourceType: "pos-sale" }),
    ...between,
    canonical("a10", 2, "-1", { unitCost: "10", sourceType: "pos-sale" }),
    legacy("s10", 1, "-1", { sale: sale(20, "1") }),
  ];

  it("detects an unrecorded revaluation between two locked live rates and requests a re-anchor", () => {
    const result = rewind(["10", "15", "150"], eraMovements([legacy("i10", 3, "-1", { unitCost: "15" })]));
    expect(result.codes).toEqual(["UNRECORDED_REVALUATION_DETECTED:warning", "VALUATION_ERA_BOUNDARY:warning"]);
    expect(result.checks[0]).toMatchObject({ expected: "10.00", actual: "15.00" });
    expect(result.checks[0].detail).toBe(
      "Locked live rate moved from 10.00 (a10, 2026-01-01T00:00:00.000Z) to 15.00 (b10, 2026-01-01T00:00:00.000Z) with 1 outbound movement(s) between them"
    );
    expect(result.checks[1].detail).toBe(
      "transition=UNRECORDED_REVALUATION at b10; anchor=a10 recorded live rate 10.00, checkpoint rewind inferred 15.00"
    );
    const [request] = result.output.reanchorRequests;
    expect(request).toMatchObject({
      key: KEY,
      transition: "UNRECORDED_REVALUATION",
      transitionMovementId: "b10",
    });
    expect(request.anchor.movementId).toBe("a10");
    expect(request.beforeQuantity.toFixed(3)).toBe("13.000");
    expect(request.recorded.toFixed(2)).toBe("10.00");
    expect(request.inferred.toFixed(2)).toBe("15.00");
    expect(request.unresolvedSales.map((row) => row.movementId)).toEqual(["s10"]);
    expect(result.costs).toEqual({});
  });

  it("says no stock movement separated the two rates when they are adjacent", () => {
    const result = rewind(["10", "15", "150"], eraMovements([]));
    expect(result.checks[0].detail).toMatch(/with no stock movement between them$/);
  });

  it("allows a cent of rounding per intervening issue before calling it a revaluation", () => {
    // 10.00 → 10.04 across two issues: limit is 0.02 + 2 × 0.01 = 0.04, not exceeded.
    const result = rewind(
      ["10", "10.04", "100.40"],
      [
        canonical("b10", 5, "-1", { unitCost: "10.04", sourceType: "pos-sale" }),
        legacy("i1", 4, "-1", { unitCost: "10.04" }),
        legacy("i2", 3, "-1", { unitCost: "10.04" }),
        canonical("a10", 2, "-1", { unitCost: "10", sourceType: "pos-sale" }),
        legacy("s10", 1, "-1", { sale: sale(20, "1") }),
      ]
    );
    expect(result.codes).toEqual(["CANONICAL_SALE_COST_EVIDENCE_MISMATCH:block:20"]);
  });

  it("calls a gap one cent past the per-issue allowance a revaluation", () => {
    // 10.00 → 10.05 across two issues: 0.05 exceeds 0.02 + 2 × 0.01.
    const result = rewind(
      ["10", "10.05", "100.50"],
      [
        canonical("b10", 5, "-1", { unitCost: "10.05", sourceType: "pos-sale" }),
        legacy("i1", 4, "-1", { unitCost: "10.05" }),
        legacy("i2", 3, "-1", { unitCost: "10.05" }),
        canonical("a10", 2, "-1", { unitCost: "10", sourceType: "pos-sale" }),
        legacy("s10", 1, "-1", { sale: sale(20, "1") }),
      ]
    );
    expect(result.codes).toEqual(["UNRECORDED_REVALUATION_DETECTED:warning", "VALUATION_ERA_BOUNDARY:warning"]);
    expect(result.checks[0].detail).toMatch(/with 2 outbound movement\(s\) between them$/);
  });

  it("re-anchors below a priced receipt into exactly empty stock", () => {
    const result = rewind(
      ["5", "12", "60"],
      [
        legacy("r5", 4, "5", { unitCost: "12" }),
        legacy("i5", 3, "-2", { unitCost: "15" }),
        canonical("a5", 2, "-1", { unitCost: "10", sourceType: "pos-sale" }),
        legacy("s5", 1, "-1", { sale: sale(32, "1") }),
      ],
      { priorCostMemoryRateHints: new Map([["r5", "15"]]) }
    );
    expect(result.codes).toEqual(["VALUATION_ERA_BOUNDARY:warning"]);
    expect(result.output.reanchorRequests[0]).toMatchObject({
      transition: "COST_MEMORY_RESET",
      transitionMovementId: "r5",
    });
  });

  it("re-anchors below a valuation reset that erased cost memory", () => {
    const result = rewind(
      ["5", "20", "100"],
      [
        legacy("v5", 3, "0", {
          sourceType: "inventory-valuation-override",
          valuationReset: {
            beforeQuantity: "5",
            beforeAverageRate: "15",
            beforeTotalValue: "75",
            afterQuantity: "5",
            afterAverageRate: "20",
            afterTotalValue: "100",
          },
        }),
        canonical("a5", 2, "-1", { unitCost: "10", sourceType: "pos-sale" }),
        legacy("s5", 1, "-1", { sale: sale(31, "1") }),
      ]
    );
    expect(result.codes).toEqual(["VALUATION_ERA_BOUNDARY:warning"]);
    expect(result.checks[0].detail).toBe(
      "transition=COST_MEMORY_RESET at v5; anchor=a5 recorded live rate 10.00, checkpoint rewind inferred 15.00"
    );
    expect(result.output.reanchorRequests[0]).toMatchObject({
      transition: "COST_MEMORY_RESET",
      transitionMovementId: "v5",
    });
  });

  it("blocks each earlier legacy sale on a plain recorded-rate mismatch", () => {
    const result = rewind(
      ["10", "15", "150"],
      [
        canonical("a11", 3, "-1", { unitCost: "10", sourceType: "credit-sales-import" }),
        legacy("s11", 2, "-1", { sale: sale(21, "1") }),
        legacy("s12", 1, "-1", { sale: sale(22, "1") }),
      ]
    );
    expect(result.codes).toEqual([
      "CANONICAL_SALE_COST_EVIDENCE_MISMATCH:block:21",
      "CANONICAL_SALE_COST_EVIDENCE_MISMATCH:block:22",
    ]);
    expect(result.checks[0]).toMatchObject({
      expected: "10.00",
      actual: "15.00",
      detail: "Sales item 21 predates canonical cost boundary a11",
    });
    expect(result.output.reanchorRequests).toEqual([]);
  });

  it("only warns on a mismatch when every target legacy sale is already priced", () => {
    const result = rewind(
      ["10", "15", "150"],
      [
        legacy("s13", 3, "-1", { sale: sale(23, "1") }),
        canonical("a12", 2, "-1", { unitCost: "10", sourceType: "pos-import" }),
      ]
    );
    expect(result.codes).toEqual(["CANONICAL_SALE_COST_EVIDENCE_MISMATCH:warning"]);
    expect(result.checks[0].detail).toBe(
      "Canonical movement a12 disagrees with checkpoint rewind after all target legacy sales were already reconstructed"
    );
    expect(result.costs).toEqual({ 23: "15.00" });
  });

  it("ignores POS edit issues, whose journal cost is not the inventory rate", () => {
    const result = rewind(
      ["10", "15", "150"],
      [
        canonical("a13", 2, "-1", { unitCost: "10", sourceType: "pos-sale", canonicalPosRole: "edit-issue" }),
        legacy("s14", 1, "-1", { sale: sale(24, "1") }),
      ]
    );
    expect(result.codes).toEqual([]);
    expect(result.costs).toEqual({ 24: "15.00" });
  });
});

describe("rewindCheckpointToLegacySales branching alternates", () => {
  const unpinnedIssue = (movementId: string, sequence: number, quantityDelta: string, overrides = {}) =>
    canonical(movementId, sequence, quantityDelta, { sourceType: "stock-transfer", ...overrides });

  it("branches an unpinned canonical issue into every other exact inverse", () => {
    const result = rewind(["1", "10.03", "10.03"], [unpinnedIssue("t1", 3, "-3")]);
    const alternates = result.output.rewindAlternates.get(KEY)!;
    expect(alternates.map((row) => row.state.averageRate.toFixed(2))).toEqual(["10.02", "10.04", "10.05"]);
    expect(alternates.map((row) => row.state.totalValue.toFixed(2))).toEqual(["40.09", "40.15", "40.18"]);
    expect(result.output.finishedAlternates.get(KEY)).toEqual([]);
    expect(result.state).toBe("4.000|10.03|40.12");
    expect(result.trace[0]).toMatch(/ alts=3$/);
  });

  it("promotes the alternate a later recorded live rate agrees with", () => {
    const result = rewind(
      ["1", "10.03", "10.03"],
      [
        unpinnedIssue("t2", 3, "-3"),
        legacy("s2", 2, "-1", { sale: sale(2, "1") }),
        canonical("p2", 1, "-1", { sourceType: "pos-sale", unitCost: "10.05", sale: sale(3, "1") }),
      ]
    );
    expect(result.codes).toEqual(["REWIND_BRANCH_PROMOTED:pass"]);
    expect(result.checks[0]).toMatchObject({ actual: "6.000|10.05|60.28" });
    expect(result.checks[0].detail).toBe(
      "At p2 the recorded live rate 10.05 contradicts the primary rewind; an alternate exact inverse that agrees replaces it"
    );
    // The legacy sale between them is re-priced from the promoted branch.
    expect(result.costs).toEqual({ 2: "10.05", 3: "10.05" });
    expect(result.output.primaryHistoryByKey.get(KEY)?.get(2)?.proposedCostPrice).toBe("10.05");
    expect(result.output.rewindAlternates.get(KEY)).toEqual([]);
  });

  it("prunes alternates a recorded live rate contradicts without promoting when the primary agrees", () => {
    const result = rewind(
      ["1", "10.03", "10.03"],
      [
        unpinnedIssue("t3", 3, "-3"),
        canonical("p3", 1, "-1", { sourceType: "pos-sale", unitCost: "10.03", sale: sale(4, "1") }),
      ]
    );
    expect(result.codes).toEqual([]);
    expect(result.costs).toEqual({ 4: "10.03" });
    expect(result.output.rewindAlternates.get(KEY)).toEqual([]);
  });

  it("keeps the primary when it agrees with a recorded live rate even if alternates also agree", () => {
    // A large pinned issue pulls every branch's rate to 10.03 before the recorded sale.
    const result = rewind(
      ["1", "10.03", "10.03"],
      [
        unpinnedIssue("t9", 4, "-3"),
        legacy("i9", 3, "-1000", { unitCost: "10.03" }),
        canonical("p9", 2, "-1", { sourceType: "pos-sale", unitCost: "10.03" }),
      ]
    );
    expect(result.codes).toEqual([]);
    expect(result.output.rewindAlternates.get(KEY)!.length).toBeGreaterThan(0);
    expect(result.output.rewindAlternates.get(KEY)!.every((row) => row.state.averageRate.toFixed(2) === "10.03")).toBe(
      true
    );
  });

  it("promotes the only alternate with an exact inverse when the primary inverse is impossible", () => {
    const result = rewind(
      ["1", "10.03", "10.03"],
      [
        unpinnedIssue("t4", 3, "-3", { sale: sale(50, "3") }),
        legacy("s4", 2, "-1", { sale: sale(51, "1"), unitCost: "10.02" }),
        legacy("r4", 1, "5", { unitCost: "10.0225" }),
      ],
      { priorCostMemoryRateHints: new Map([["r4", "9.5"]]) }
    );
    expect(result.codes).toEqual(["REWIND_BRANCH_PROMOTED:pass"]);
    expect(result.checks[0]).toMatchObject({ actual: "0.000|9.50|0.00" });
    expect(result.checks[0].detail).toBe(
      "At r4 the exact inverse contradicts the primary rewind; an alternate exact inverse that agrees replaces it"
    );
    expect(result.costs).toEqual({ 50: "10.02", 51: "10.02" });
    expect(result.state).toBe("0.000|9.50|0.00");
  });

  it("finishes alternates that reach irreversible cost memory", () => {
    const result = rewind(
      ["1", "10.03", "10.03"],
      [unpinnedIssue("t5", 3, "-3"), legacy("r5", 2, "5", { unitCost: "10" })]
    );
    expect(result.output.finishedAlternates.get(KEY)).toHaveLength(3);
    expect(result.output.rewindAlternates.get(KEY)).toEqual([]);
    expect(result.codes).toEqual(["REWIND_BOUNDARY_DIAGNOSTIC:warning", "REWIND_RESET_BOUNDARY_REACHED:pass"]);
  });

  it("stops branching a key once alternates exceed the branch limit", () => {
    const result = rewind(
      ["1", "10.03", "10.03"],
      [
        unpinnedIssue("t6", 3, "-1000"),
        unpinnedIssue("t7", 2, "-1000"),
        legacy("s6", 1, "-1", { sale: sale(60, "1"), unitCost: "10" }),
      ]
    );
    expect(result.trace[0]).toMatch(/ alts=20$/);
    expect([...result.output.branchOverflowKeys]).toEqual([KEY]);
    expect(result.output.rewindAlternates.get(KEY)).toEqual([]);
    expect(result.trace[1]).not.toContain("alts=");
    expect(result.costs).toEqual({ 60: "10.03" });
  });

  it("does not record forward-reset-proven sales into alternate histories", () => {
    const result = rewind(
      ["1", "10.03", "10.03"],
      [
        unpinnedIssue("t8", 3, "-3", { sale: sale(70, "3") }),
        canonical("p8", 1, "-1", { sourceType: "pos-sale", unitCost: "10.05", sale: sale(71, "1") }),
      ],
      { forwardResetProvenSaleIds: new Set([70, 71]) }
    );
    expect(result.codes).toEqual(["REWIND_BRANCH_PROMOTED:pass"]);
    expect(result.costs).toEqual({});
  });
});

describe("rewindCheckpointToLegacySales legacy ambiguity and amplification", () => {
  it("blocks a legacy sale whose own inverse admits several pre-sale rates and measures the spread", () => {
    const result = rewind(
      ["1", "10.03", "10.03"],
      [legacy("s1", 2, "-3", { sale: sale(1, "3") }), legacy("s2", 1, "-1", { sale: sale(2, "1"), unitCost: "10.03" })]
    );
    expect(result.codes).toEqual(["LEGACY_SALE_INVERSE_NOT_UNIQUE:block:1"]);
    expect(result.checks[0]).toMatchObject({ expected: "10.03", actual: "10.02,10.04,10.05" });
    const ambiguity = result.output.legacyInverseAmbiguity.get(KEY)!;
    expect(ambiguity.sales).toBe(1);
    expect(ambiguity.maxSpread.toFixed(2)).toBe("0.02");
    expect(result.costs).toEqual({ 1: "10.03", 2: "10.03" });
  });

  it("keeps the widest spread across several ambiguous legacy sales", () => {
    const result = rewind(
      ["1", "10.03", "10.03"],
      [legacy("s1", 2, "-3", { sale: sale(1, "3") }), legacy("s2", 1, "-1000", { sale: sale(2, "1000") })]
    );
    const ambiguity = result.output.legacyInverseAmbiguity.get(KEY)!;
    expect(ambiguity.sales).toBe(2);
    expect(ambiguity.maxSpread.gt("0.02")).toBe(true);
    expect(result.codes.filter((code) => code.startsWith("LEGACY_SALE_INVERSE_NOT_UNIQUE"))).toHaveLength(2);
  });

  it("does not let a later, narrower ambiguity shrink the recorded spread", () => {
    const wide = rewind(["1", "10.03", "10.03"], [legacy("w1", 3, "-1000", { sale: sale(1, "1000") })]);
    const wideSpread = wide.output.legacyInverseAmbiguity.get(KEY)!.maxSpread;
    const result = rewind(
      ["1", "10.03", "10.03"],
      [
        legacy("w1", 3, "-1000", { sale: sale(1, "1000") }),
        legacy("r1", 2, "1000", { unitCost: "10.03" }),
        legacy("n1", 1, "-3", { sale: sale(2, "3") }),
      ]
    );
    const ambiguity = result.output.legacyInverseAmbiguity.get(KEY)!;
    expect(ambiguity.sales).toBe(2);
    expect(wideSpread.gt("0.02")).toBe(true);
    expect(ambiguity.maxSpread.toFixed(2)).toBe(wideSpread.toFixed(2));
  });

  it("measures but does not block an ambiguous sale already proven by a forward reset", () => {
    const result = rewind(["1", "10.03", "10.03"], [legacy("s1", 2, "-3", { sale: sale(1, "3") })], {
      forwardResetProvenSaleIds: new Set([1]),
    });
    expect(result.codes).toEqual([]);
    expect(result.output.legacyInverseAmbiguity.get(KEY)!.sales).toBe(1);
    expect(result.costs).toEqual({});
  });

  it("blocks a sale whose rewound cost is amplified past the limit by receipts into tiny stock", () => {
    const movements: HistoricalSalesRepairMovement[] = [];
    for (let index = 0; index < 8; index += 1) {
      movements.push(legacy(`r${index}`, 100 - 2 * index, "1", { unitCost: "10" }));
      movements.push(legacy(`i${index}`, 99 - 2 * index, "-1", { unitCost: "10" }));
    }
    movements.push(legacy("s", 1, "-1", { unitCost: "10", sale: sale(23, "1") }));
    const result = rewind(["2", "10", "20"], movements);
    // Each receipt doubles the sensitivity from 1/2: 2^8 / 2 = 128.
    expect(result.codes).toEqual(["LEGACY_REWIND_ERROR_AMPLIFICATION_EXCEEDED:block:23"]);
    expect(result.checks[0]).toMatchObject({ expected: "<=100", actual: "128.00" });
    expect(result.checks[0].detail).toBe(
      "Sales item 23 rewound cost moves 128.00 cents per cent of checkpoint-side model error"
    );
    const amplification = result.output.rewindAmplification.get(KEY)!;
    expect(amplification.max.toFixed(2)).toBe("128.00");
    expect(amplification).toMatchObject({ maxSalesItemId: 23, proposals: 1, over10: 1, over100: 1 });
    expect(result.output.REWIND_AMPLIFICATION_LIMIT.toFixed(0)).toBe("100");
    expect(result.output.REANCHOR_MAX_CANDIDATES.toFixed(0)).toBe("20000");
  });

  it("counts sales over 10 but under the block limit without blocking", () => {
    const movements: HistoricalSalesRepairMovement[] = [];
    for (let index = 0; index < 5; index += 1) {
      movements.push(legacy(`r${index}`, 100 - 2 * index, "1", { unitCost: "10" }));
      movements.push(legacy(`i${index}`, 99 - 2 * index, "-1", { unitCost: "10" }));
    }
    movements.push(legacy("s", 2, "-1", { unitCost: "10", sale: sale(24, "1") }));
    movements.push(legacy("t", 1, "-1", { unitCost: "10", sale: sale(25, "1") }));
    const result = rewind(["2", "10", "20"], movements);
    expect(result.codes).toEqual([]);
    const amplification = result.output.rewindAmplification.get(KEY)!;
    expect(amplification.max.toFixed(2)).toBe("16.00");
    expect(amplification).toMatchObject({ maxSalesItemId: 24, proposals: 2, over10: 2, over100: 0 });
  });
});

describe("rewindCheckpointToLegacySales key selection", () => {
  const moves = [legacy("s1", 1, "-1", { sale: sale(1, "1"), unitCost: "10" })];
  for (const [label, overrides] of [
    ["not a checkpoint target", { checkpointTargetKeys: new Set<string>() }],
    ["unavailable", { unavailableKeys: new Set([KEY]) }],
    ["already resolved by forward replay", { forwardReplayResolvedKeys: new Set([KEY]) }],
    ["missing a checkpoint state", { rewindStates: new Map() }],
  ] as const) {
    it(`skips a key that is ${label}`, () => {
      const result = rewind(["10", "10", "100"], moves, overrides as Partial<RewindInput>);
      expect(result.trace).toEqual([]);
      expect(result.costs).toEqual({});
    });
  }

  it("uses the movement key of each movement", () => {
    expect(movementKey(moves[0])).toBe(KEY);
  });
});
