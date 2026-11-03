import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The re-anchor enumeration has its own scenarios suite; here it is spied so
// the resolver's handling of every result shape (too wide, ambiguous, proven
// with stop, not unique, amplified) is exercised. By default the real
// implementation runs.
const reanchorSpy = vi.hoisted(() => ({ fn: null as null | ReturnType<typeof vi.fn> }));
vi.mock("../server/services/inventory/historicalSalesCostRepairEngineReplay", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/services/inventory/historicalSalesCostRepairEngineReplay")>();
  reanchorSpy.fn = vi.fn(actual.reanchorHistoricalRewindAtRecordedRate);
  return { ...actual, reanchorHistoricalRewindAtRecordedRate: reanchorSpy.fn };
});

import {
  proveForwardCostMemoryResets,
  resolveRewindBranchesAndReanchor,
} from "../server/services/inventory/historicalSalesCostRepairReanchor";
import {
  createHistoricalInventoryStateFromSnapshot,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "../server/services/inventory/historicalSalesCostRepairEngine";
import {
  historicalSaleProposalFromState,
  type HistoricalReanchorResult,
} from "../server/services/inventory/historicalSalesCostRepairEngineReplay";
import type {
  ReanchorRequest,
  RepairCheck,
  RewindAlternate,
} from "../server/services/inventory/historicalSalesCostRepairTypes";
import { movement } from "./helpers/historicalSalesCostRepairMovement";

const KEY = "1:10:100";

function sale(salesItemId: number, quantity = "1") {
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

const saleMovement = (salesItemId: number, sequence = salesItemId) =>
  movement({ movementId: `s${salesItemId}`, sequence, quantityDelta: "-1", sale: sale(salesItemId) });

function proposal(salesItemId: number, cost: string): HistoricalSalesRepairProposal {
  return historicalSaleProposalFromState(
    saleMovement(salesItemId),
    createHistoricalInventoryStateFromSnapshot("10", cost, new Decimal(cost).times(10).toFixed(2))
  );
}

const history = (...entries: Array<[number, string]>) => new Map(entries.map(([id, cost]) => [id, proposal(id, cost)]));
const alternate = (...entries: Array<[number, string]>): RewindAlternate => ({
  state: createHistoricalInventoryStateFromSnapshot("1", "1", "1"),
  history: history(...entries),
});

type ResolveInput = Parameters<typeof resolveRewindBranchesAndReanchor>[0];
function resolve(overrides: Partial<ResolveInput> = {}) {
  const checks: RepairCheck[] = [];
  const proposalsBySaleId = new Map<number, HistoricalSalesRepairProposal>();
  resolveRewindBranchesAndReanchor({
    companyId: 1,
    checks,
    proposalsBySaleId,
    movementsInCheckpoint: [],
    priorCostMemoryRateHints: new Map(),
    forwardResetProvenSaleIds: new Set(),
    reanchorRequests: [],
    rewindAlternates: new Map(),
    finishedAlternates: new Map(),
    primaryHistoryByKey: new Map(),
    branchOverflowKeys: new Set(),
    legacyInverseAmbiguity: new Map(),
    REWIND_AMPLIFICATION_LIMIT: new Decimal(100),
    REANCHOR_MAX_CANDIDATES: new Decimal(20000),
    ...overrides,
  });
  return {
    checks,
    proposalsBySaleId,
    codes: checks.map((check) => `${check.code}:${check.status}${check.salesItemId ? ":" + check.salesItemId : ""}`),
  };
}

beforeEach(() => {
  reanchorSpy.fn!.mockClear();
});

describe("proveForwardCostMemoryResets", () => {
  type ProveInput = Parameters<typeof proveForwardCostMemoryResets>[0];
  function prove(
    movements: HistoricalSalesRepairMovement[],
    checkpoint: [string, string, string] | null,
    overrides: Partial<ProveInput> = {}
  ) {
    const checks: RepairCheck[] = [];
    const proposalsBySaleId = new Map<number, HistoricalSalesRepairProposal>();
    const result = proveForwardCostMemoryResets({
      companyId: 1,
      checks,
      proposalsBySaleId,
      checkpointStates: new Map(checkpoint ? [[KEY, createHistoricalInventoryStateFromSnapshot(...checkpoint)]] : []),
      unavailableKeys: new Set(),
      checkpointTargetKeys: new Set([KEY]),
      forwardReplayResolvedKeys: new Set(),
      movementsAscending: movements,
      ...overrides,
    });
    return { checks, proposalsBySaleId, ...result };
  }

  it("proves later sales from a priced receipt into negative stock that replays to the checkpoint", () => {
    const movements = [
      movement({ movementId: "x", sequence: 1, quantityDelta: "-2" }),
      movement({ movementId: "r", sequence: 2, quantityDelta: "6", unitCost: "12" }),
      saleMovement(1, 3),
    ];
    const { checks, proposalsBySaleId, forwardResetProvenSaleIds, movementsByTargetKey } = prove(movements, [
      "3",
      "12",
      "36",
    ]);
    expect([...forwardResetProvenSaleIds]).toEqual([1]);
    expect(proposalsBySaleId.get(1)?.proposedCostPrice).toBe("12.00");
    expect(movementsByTargetKey.get(KEY)).toHaveLength(3);
    expect(checks).toEqual([
      expect.objectContaining({
        code: "FORWARD_RESET_SEGMENT_PROVEN",
        status: "pass",
        locationId: 10,
        stockItemId: 100,
        expected: "3.000|36.00|12.00",
        actual: "3.000|36.00|12.00",
        detail: "Reset anchor r proves 1 later legacy sale(s) by exact checkpoint replay",
      }),
    ]);
  });

  it("skips keys without a checkpoint, without movements, or whose reset proves no sale", () => {
    const reset = movement({ movementId: "r", sequence: 1, quantityDelta: "3", unitCost: "12" });
    expect(prove([reset, saleMovement(1, 2)], null).checks).toEqual([]);
    expect(prove([], ["3", "12", "36"]).checks).toEqual([]);
    expect(prove([reset], ["3", "12", "36"]).checks).toEqual([]);
    // Movements at other or unavailable keys are not collected.
    const elsewhere = { ...reset, locationId: 11 };
    expect(prove([elsewhere], ["3", "12", "36"]).movementsByTargetKey.size).toBe(0);
    expect(prove([reset], ["3", "12", "36"], { unavailableKeys: new Set([KEY]) }).movementsByTargetKey.size).toBe(0);
    expect(
      prove([reset, saleMovement(1, 2)], ["2", "12", "24"], { forwardReplayResolvedKeys: new Set([KEY]) }).checks
    ).toEqual([]);
  });
});

describe("resolveRewindBranchesAndReanchor branch consensus", () => {
  it("summarises legacy inverse ambiguity per key", () => {
    const { checks } = resolve({
      legacyInverseAmbiguity: new Map([[KEY, { sales: 3, maxSpread: new Decimal("0.045") }]]),
    });
    expect(checks).toEqual([
      {
        companyId: 1,
        locationId: 10,
        stockItemId: 100,
        code: "LEGACY_SALE_INVERSE_AMBIGUITY_SUMMARY",
        status: "warning",
        expected: "3",
        actual: "0.05",
        detail:
          "3 legacy sale inverse(s) admit another exact pre-issue rate (largest gap 0.05); blocked as LEGACY_SALE_INVERSE_NOT_UNIQUE",
      },
    ]);
  });

  it("blocks primary sales another surviving or finished branch prices differently", () => {
    const { checks, codes } = resolve({
      primaryHistoryByKey: new Map([[KEY, history([1, "10.00"], [2, "11.00"], [3, "12.00"], [4, "13.00"])]]),
      rewindAlternates: new Map([[KEY, [alternate([1, "10.00"], [2, "11.50"], [3, "12.00"], [4, "13.50"])]]]),
      finishedAlternates: new Map([[KEY, [alternate([1, "10.00"], [2, "11.00"], [4, "13.00"])]]]),
      // Sale 4 differs on a branch but is already proven by a forward reset.
      forwardResetProvenSaleIds: new Set([4]),
    });
    expect(codes).toEqual([
      "CHECKPOINT_REWIND_COST_NOT_UNIQUE:block:2",
      "CHECKPOINT_REWIND_COST_NOT_UNIQUE:block:3",
      "REWIND_BRANCH_CONSENSUS:warning",
    ]);
    expect(checks[0]).toMatchObject({
      expected: "11.00",
      actual: "11.50",
      detail: "Sales item 2 has a different cost on another exact rewind branch",
    });
    // The finished branch never reached sale 3.
    expect(checks[1]).toMatchObject({ expected: "12.00", actual: "unreached" });
    expect(checks[2]).toMatchObject({
      expected: "4",
      actual: "2",
      detail: "2 surviving alternate branch(es); 2 of 4 rewound legacy sale(s) not unique",
    });
  });

  it("blocks every primary sale on a key that overflowed the branch limit", () => {
    const { checks, codes } = resolve({
      primaryHistoryByKey: new Map([[KEY, history([1, "10.00"], [2, "11.00"])]]),
      branchOverflowKeys: new Set([KEY]),
    });
    expect(codes).toEqual([
      "CHECKPOINT_REWIND_COST_NOT_UNIQUE:block:1",
      "CHECKPOINT_REWIND_COST_NOT_UNIQUE:block:2",
      "REWIND_BRANCH_CONSENSUS:warning",
    ]);
    expect(checks[0].actual).toBe("branch limit");
    expect(checks[2].detail).toBe(
      "0 surviving alternate branch(es) (branch limit exceeded); 2 of 2 rewound legacy sale(s) not unique"
    );
  });

  it("reports consensus without blocks when every branch agrees, and skips keys without branches", () => {
    const { codes, checks } = resolve({
      primaryHistoryByKey: new Map([
        [KEY, history([1, "10.00"])],
        ["1:11:100", history([2, "10.00"])],
      ]),
      rewindAlternates: new Map([[KEY, [alternate([1, "10.00"])]]]),
    });
    expect(codes).toEqual(["REWIND_BRANCH_CONSENSUS:warning"]);
    expect(checks[0]).toMatchObject({ expected: "1", actual: "1" });
  });
});

describe("resolveRewindBranchesAndReanchor re-anchoring", () => {
  function request(overrides: Partial<ReanchorRequest> = {}): ReanchorRequest {
    return {
      key: KEY,
      anchor: movement({
        movementId: "anchor",
        sequence: 10,
        quantityDelta: "-1",
        evidence: "canonical",
        sourceType: "pos-sale",
        unitCost: "10",
      }),
      beforeQuantity: new Decimal(5),
      recorded: new Decimal(10),
      inferred: new Decimal("12.5"),
      unresolvedSales: [saleMovement(1, 1), saleMovement(2, 2)],
      transition: "UNRECORDED_REVALUATION",
      transitionMovementId: "b",
      ...overrides,
    };
  }

  const result = (overrides: Partial<HistoricalReanchorResult>): HistoricalReanchorResult => ({
    status: "proven",
    candidateCount: 3,
    survivorCount: 2,
    distinctOutcomeCount: 1,
    proposals: new Map(),
    sensitivity: new Map(),
    stoppedAt: null,
    notUniqueSaleIds: new Set(),
    ...overrides,
  });

  it("passes only earlier movements at the key, the anchor quantity and recorded rate to the enumeration", () => {
    const earlier = movement({ movementId: "e", sequence: 5, quantityDelta: "-1" });
    const later = movement({ movementId: "l", sequence: 20, quantityDelta: "-1" });
    const elsewhere = { ...earlier, movementId: "o", locationId: 11 };
    const hints = new Map([["e", "9"]]);
    resolve({
      reanchorRequests: [request()],
      movementsInCheckpoint: [later, earlier, elsewhere],
      priorCostMemoryRateHints: hints,
      REANCHOR_MAX_CANDIDATES: new Decimal(77),
    });
    const input = reanchorSpy.fn!.mock.calls[0][0];
    expect(input.earlierMovementsDescending.map((row: HistoricalSalesRepairMovement) => row.movementId)).toEqual(["e"]);
    expect(String(input.anchorQuantity)).toBe("5");
    expect(String(input.recordedRate)).toBe("10");
    expect([...input.targetSaleIds]).toEqual([1, 2]);
    expect(input.priorCostMemoryRateHints).toBe(hints);
    expect(input.maxCandidates).toBe(77);
  });

  it("proves sales with the real enumeration when only one value candidate reproduces the earlier history", () => {
    // Two units at 10.00 before the anchor: value 20.00 is the only 2dp value with rate 10.00.
    const { codes, checks, proposalsBySaleId } = resolve({
      reanchorRequests: [
        request({
          beforeQuantity: new Decimal(2),
          unresolvedSales: [saleMovement(1, 1)],
          transition: "COST_MEMORY_RESET",
          transitionMovementId: "v",
        }),
      ],
      // A pinned unit cost keeps the earlier sale's own inverse unique.
      movementsInCheckpoint: [{ ...saleMovement(1, 1), unitCost: "10" }],
    });
    expect(codes).toEqual(["LEGACY_COST_MEMORY_RESET_REANCHOR_PROVEN:pass"]);
    expect(checks[0]).toMatchObject({ expected: "1", actual: "1" });
    expect(checks[0].detail).toMatch(
      /^\d+ of \d+ value candidates at anchor \(recorded 10\.00, below COST_MEMORY_RESET v\) survived and agree on every reconstructed sale cost$/
    );
    expect(proposalsBySaleId.get(1)?.proposedCostPrice).toBe("10.00");
  });

  it("blocks every unresolved sale when the candidate range is too wide", () => {
    reanchorSpy.fn!.mockReturnValueOnce(result({ status: "too-wide", candidateCount: 50000 }));
    const { checks, codes } = resolve({ reanchorRequests: [request()] });
    expect(codes).toEqual([
      "LEGACY_UNRECORDED_REVALUATION_REANCHOR_AMBIGUOUS:warning",
      "CANONICAL_SALE_COST_EVIDENCE_MISMATCH:block:1",
      "CANONICAL_SALE_COST_EVIDENCE_MISMATCH:block:2",
    ]);
    expect(checks[0]).toMatchObject({
      expected: "1 agreeing outcome",
      actual: "50000 cent values to enumerate",
      detail: "Re-anchor at anchor below UNRECORDED_REVALUATION b is not unique",
    });
    expect(checks[1]).toMatchObject({
      expected: "10.00",
      actual: "12.50",
      detail: "Sales item 1 predates canonical cost boundary anchor",
    });
  });

  it("reports survivors and distinct outcomes when the re-anchor is ambiguous", () => {
    reanchorSpy.fn!.mockReturnValueOnce(
      result({ status: "ambiguous", survivorCount: 4, candidateCount: 9, distinctOutcomeCount: 2 })
    );
    const { checks } = resolve({ reanchorRequests: [request({ transition: "COLLAPSED_POS_LINES" })] });
    expect(checks[0]).toMatchObject({
      code: "LEGACY_COLLAPSED_POS_LINES_REANCHOR_AMBIGUOUS",
      actual: "4 surviving of 9 candidates, 2 distinct outcomes",
    });
  });

  it("blocks each unproven sale for its own reason and prices the rest", () => {
    const sales = [saleMovement(1, 1), saleMovement(2, 2), saleMovement(3, 3), saleMovement(4, 4)];
    reanchorSpy.fn!.mockReturnValueOnce(
      result({
        proposals: new Map([
          [2, proposal(2, "9.00")],
          [3, proposal(3, "9.10")],
          [4, proposal(4, "9.20")],
        ]),
        notUniqueSaleIds: new Set([2]),
        sensitivity: new Map([
          [3, new Decimal("150.5")],
          [4, new Decimal("100")],
        ]),
        stoppedAt: "stop",
      })
    );
    const { checks, codes, proposalsBySaleId } = resolve({ reanchorRequests: [request({ unresolvedSales: sales })] });
    expect(codes).toEqual([
      "LEGACY_REWIND_COST_MEMORY_IRREVERSIBLE:block:1",
      "LEGACY_SALE_INVERSE_NOT_UNIQUE:block:2",
      "LEGACY_REWIND_ERROR_AMPLIFICATION_EXCEEDED:block:3",
      "LEGACY_UNRECORDED_REVALUATION_REANCHOR_PROVEN:pass",
    ]);
    expect(checks[0].detail).toBe("Sales item 1 predates irreversible valuation boundary stop below re-anchor anchor");
    expect(checks[1].detail).toBe(
      "Sales item 2: the re-anchored rewind at anchor admits more than one exact pre-sale rate, so its cost is not uniquely proven"
    );
    expect(checks[2]).toMatchObject({
      expected: "<=100",
      actual: "150.50",
      detail: "Sales item 3 re-anchored cost moves 150.50 cents per cent of model error",
    });
    expect(checks[3]).toMatchObject({
      expected: "4",
      actual: "1",
      detail:
        "2 of 3 value candidates at anchor (recorded 10.00, below UNRECORDED_REVALUATION b) survived and agree on every reconstructed sale cost; rewind stops at stop",
    });
    expect([...proposalsBySaleId.keys()]).toEqual([4]);
  });

  it("falls back to the canonical mismatch block for a sale the survivors never reached", () => {
    reanchorSpy.fn!.mockReturnValueOnce(result({ proposals: new Map([[2, proposal(2, "9.00")]]) }));
    const { codes, proposalsBySaleId } = resolve({ reanchorRequests: [request()] });
    expect(codes).toEqual([
      "CANONICAL_SALE_COST_EVIDENCE_MISMATCH:block:1",
      "LEGACY_UNRECORDED_REVALUATION_REANCHOR_PROVEN:pass",
    ]);
    expect(proposalsBySaleId.get(2)?.proposedCostPrice).toBe("9.00");
  });
});
