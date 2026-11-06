import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  proveClosedZeroStockEras,
  reportCheckpointRewindCoverage,
} from "../server/services/inventory/historicalSalesCostRepairEras";
import {
  createHistoricalInventoryStateFromSnapshot,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "../server/services/inventory/historicalSalesCostRepairEngine";
import { originalProposalForSale } from "../server/services/inventory/historicalSalesCostRepairEvidence";
import type { RepairCheck, SaleRow } from "../server/services/inventory/historicalSalesCostRepairTypes";
import { movement } from "./helpers/historicalSalesCostRepairMovement";

// Closed zero-stock, opening and observation-validated era proofs, and the
// rewind coverage report, driven with ascending movements at one key.
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

function saleRow(salesItemId: number, costPrice: string, locationId: number | null = 10): SaleRow {
  return {
    sales_item_id: salesItemId,
    voucher_id: salesItemId,
    location_id: locationId,
    stock_item_id: 100,
    quantity: "1",
    total_sales: "100",
    cost_price: costPrice,
    total_cost: costPrice,
    profit: "0",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const existing = (salesItemId: number, cost: string): HistoricalSalesRepairProposal =>
  originalProposalForSale(1, saleRow(salesItemId, cost));

const block = (salesItemId: number, code = "LEGACY_REWIND_COST_MEMORY_IRREVERSIBLE"): RepairCheck => ({
  companyId: 1,
  locationId: 10,
  stockItemId: 100,
  salesItemId,
  code,
  status: "block",
  detail: `blocked ${salesItemId}`,
});

let seq = 0;
const m = (movementId: string, quantityDelta: string, overrides: Partial<HistoricalSalesRepairMovement> = {}) =>
  movement({ movementId, quantityDelta, sequence: ++seq, ...overrides });
const observation = (movementId: string, unitCost: string) =>
  m(movementId, "-1", { evidence: "canonical", sourceType: "pos-sale", unitCost });

function prove(input: {
  movements: HistoricalSalesRepairMovement[];
  checkpointQuantity: string;
  checks?: RepairCheck[];
  proposals?: HistoricalSalesRepairProposal[];
  opening?: HistoricalInventoryState;
  forwardResolved?: boolean;
  noCheckpoint?: boolean;
}) {
  const checks = input.checks ?? [];
  const proposalsBySaleId = new Map((input.proposals ?? []).map((proposal) => [proposal.salesItemId, proposal]));
  const closedEraProvenSaleIds = new Set<number>();
  const result = proveClosedZeroStockEras({
    companyId: 1,
    checks,
    proposalsBySaleId,
    closedEraProvenSaleIds,
    evidencedOpeningStates: new Map(input.opening ? [[KEY, input.opening]] : []),
    checkpointStates: new Map(
      input.noCheckpoint ? [] : [[KEY, createHistoricalInventoryStateFromSnapshot(input.checkpointQuantity, "10", "0")]]
    ),
    forwardReplayResolvedKeys: new Set(input.forwardResolved ? [KEY] : []),
    movementsByTargetKey: new Map([[KEY, input.movements]]),
  });
  const costs = Object.fromEntries([...proposalsBySaleId.values()].map((p) => [p.salesItemId, p.proposedCostPrice]));
  return { result, checks, costs, closedEraProvenSaleIds, proposalsBySaleId };
}

describe("proveClosedZeroStockEras closed zero-stock eras", () => {
  // Quantities: 2 → 0 (unpriced issue), receipt into empty → 4 → 3 → 0 (closed), receipt into empty → 5 → 4 (never closes).
  const closedEraMovements = () => [
    m("m0", "-2"),
    m("m1", "4", { unitCost: "10" }),
    m("m2", "-1", { sale: sale(1, "1") }),
    m("m3", "-3", { sale: sale(2, "3") }),
    m("m4", "5", { unitCost: "12" }),
    m("m5", "-1", { sale: sale(3, "1") }),
  ];

  it("prices rewind-blocked sales inside a closed era and flags rewind disagreements", () => {
    const blocked = block(1);
    const neverClosed = block(3);
    const { result, checks, costs, closedEraProvenSaleIds } = prove({
      movements: closedEraMovements(),
      checkpointQuantity: "4",
      checks: [blocked, neverClosed],
      proposals: [existing(2, "9.00")],
    });

    expect(blocked.status).toBe("warning");
    expect(blocked.detail).toBe("blocked 1 (superseded: closed zero-stock era m1..m3)");
    expect(neverClosed.status).toBe("block");
    expect(costs).toEqual({ 1: "10.00", 2: "9.00" });
    expect([...closedEraProvenSaleIds]).toEqual([1]);
    expect(result).toMatchObject({ eraProvenSales: 1, eraConflictSales: 1 });
    expect(result.blockedSaleCodes.get(1)).toEqual([blocked]);

    const conflict = checks.find((check) => check.code === "CLOSED_ERA_FORWARD_DISAGREES")!;
    expect(conflict).toMatchObject({
      salesItemId: 2,
      status: "block",
      expected: "10.00",
      actual: "9.00",
      detail: "Sales item 2: closed zero-stock era from m1 gives a different cost than the checkpoint rewind",
    });
    expect(checks.find((check) => check.code === "CLOSED_ZERO_STOCK_ERA_PROVEN")).toMatchObject({
      locationId: 10,
      stockItemId: 100,
      status: "pass",
      expected: "2",
      actual: "1",
      detail:
        "Era m1..m3 opens with a priced receipt into empty stock and closes at zero stock; 1 blocked sale(s) priced by forward replay, 1 conflict(s) with the checkpoint rewind",
    });
  });

  it("leaves sales alone when the era agrees with the rewind or blocks for another reason", () => {
    const foreign = block(1, "SOME_OTHER_BLOCK");
    const { result, checks, costs } = prove({
      movements: closedEraMovements(),
      checkpointQuantity: "4",
      checks: [foreign],
      proposals: [existing(2, "10.00")],
    });
    expect(foreign.status).toBe("block");
    expect(costs).toEqual({ 2: "10.00" });
    expect(result).toMatchObject({ eraProvenSales: 0, eraConflictSales: 0 });
    expect(checks).toEqual([foreign]);
  });

  it("supersedes every rewind-failure code, including the exact-match ones", () => {
    for (const code of [
      "CHECKPOINT_REWIND_MOVEMENT_INVERSE_INVALID",
      "CANONICAL_SALE_COST_EVIDENCE_MISMATCH",
      "LEGACY_REWIND_ERROR_AMPLIFICATION_EXCEEDED",
      "LEGACY_SALE_INVERSE_NOT_UNIQUE",
    ]) {
      const blocked = block(1, code);
      prove({ movements: closedEraMovements(), checkpointQuantity: "4", checks: [blocked] });
      expect(blocked.status, code).toBe("warning");
    }
    const suffixed = block(1, "CANONICAL_SALE_COST_EVIDENCE_MISMATCH_EXTRA");
    prove({ movements: closedEraMovements(), checkpointQuantity: "4", checks: [suffixed] });
    expect(suffixed.status).toBe("block");
  });

  it("closes an era when stock goes short and rejects one a recorded live rate contradicts", () => {
    const short = block(1);
    prove({
      movements: [m("a", "3", { unitCost: "10" }), m("b", "-1", { sale: sale(1, "1") }), m("c", "-5")],
      checkpointQuantity: "-3",
      checks: [short],
    });
    expect(short.status).toBe("warning");

    const contradicted = block(1);
    prove({
      movements: [
        m("a", "3", { unitCost: "10" }),
        m("b", "-1", { sale: sale(1, "1") }),
        observation("o", "11"),
        m("c", "-1"),
      ],
      checkpointQuantity: "0",
      checks: [contradicted],
    });
    expect(contradicted.status).toBe("block");
  });

  it("accepts an agreeing recorded live rate inside the era", () => {
    const blocked = block(1);
    prove({
      movements: [
        m("a", "3", { unitCost: "10", exactValue: "30" }),
        observation("o", "10"),
        m("b", "-2", { sale: sale(1, "2") }),
      ],
      checkpointQuantity: "0",
      checks: [blocked],
    });
    expect(blocked.status).toBe("warning");
  });

  it("never anchors on unpriced receipts, POS edit journals, valuation resets or receipts into stock", () => {
    for (const anchor of [
      m("a", "3"),
      m("a", "3", { unitCost: "10", sourceType: "pos-sale", canonicalPosRole: "edit-reversal" }),
      m("a", "3", {
        unitCost: "10",
        sourceType: "inventory-valuation-override",
        valuationReset: {
          beforeQuantity: "0",
          beforeAverageRate: "0",
          beforeTotalValue: "0",
          afterQuantity: "3",
          afterAverageRate: "10",
          afterTotalValue: "30",
        },
      }),
    ]) {
      const blocked = block(1);
      prove({ movements: [anchor, m("b", "-3", { sale: sale(1, "3") })], checkpointQuantity: "0", checks: [blocked] });
      expect(blocked.status, anchor.sourceType + (anchor.canonicalPosRole ?? "")).toBe("block");
    }
    const intoStock = block(1);
    prove({
      movements: [m("a", "3", { unitCost: "10" }), m("b", "-4", { sale: sale(1, "4") })],
      checkpointQuantity: "0",
      checks: [intoStock],
    });
    expect(intoStock.status).toBe("block");
  });

  it("skips keys resolved by forward replay or without a checkpoint state", () => {
    for (const option of [{ forwardResolved: true }, { noCheckpoint: true }]) {
      const blocked = block(1);
      const { result } = prove({
        movements: closedEraMovements(),
        checkpointQuantity: "4",
        checks: [blocked],
        ...option,
      });
      expect(blocked.status).toBe("block");
      expect(result.eraProvenSales).toBe(0);
    }
  });

  it("indexes only blocking checks that name a sale", () => {
    const { result } = prove({
      movements: [],
      checkpointQuantity: "0",
      checks: [
        block(1),
        { ...block(2), status: "warning" },
        { ...block(3), salesItemId: undefined },
        block(1, "SECOND"),
      ],
    });
    expect([...result.blockedSaleCodes.keys()]).toEqual([1]);
    expect(result.blockedSaleCodes.get(1)!.map((check) => check.code)).toEqual([
      "LEGACY_REWIND_COST_MEMORY_IRREVERSIBLE",
      "SECOND",
    ]);
  });
});

describe("proveClosedZeroStockEras opening eras", () => {
  it("records an opening era closed only by stock running out as unvalidated, then starts later eras after it", () => {
    const openingSale = block(1);
    const laterSale = block(2);
    const { checks, costs } = prove({
      opening: createHistoricalInventoryStateFromSnapshot("3", "10", "30"),
      movements: [
        m("o1", "-1", { sale: sale(1, "1") }),
        m("o2", "-2"),
        m("r", "2", { unitCost: "12" }),
        m("s", "-2", { sale: sale(2, "2") }),
      ],
      checkpointQuantity: "0",
      checks: [openingSale, laterSale],
    });
    expect(checks.find((check) => check.code === "OPENING_ERA_UNVALIDATED")).toMatchObject({
      status: "warning",
      locationId: 10,
      stockItemId: 100,
      expected: "1",
      detail: "Opening era closed at o2 without a recorded live rate; not used as evidence",
    });
    expect(openingSale.status).toBe("block");
    expect(laterSale.status).toBe("warning");
    expect(costs).toEqual({ 2: "12.00" });
  });

  it("proves opening-era sales once two recorded live rates agree", () => {
    const blocked = block(1);
    const { checks, costs, result } = prove({
      opening: createHistoricalInventoryStateFromSnapshot("10", "10", "100"),
      movements: [
        m("o1", "-1", { sale: sale(1, "1") }),
        m("o2", "-1", { sale: sale(2, "1") }),
        observation("p1", "10"),
        m("o3", "-1", { sale: sale(3, "1") }),
        observation("p2", "10"),
        m("o4", "-1", { sale: sale(4, "1") }),
      ],
      checkpointQuantity: "4",
      checks: [blocked],
      proposals: [existing(2, "9.50")],
    });
    expect(blocked.status).toBe("warning");
    expect(blocked.detail).toBe(`blocked 1 (superseded: opening era ${KEY} validated by two recorded live rates)`);
    expect(costs).toEqual({ 1: "10.00", 2: "9.50" });
    expect(checks.find((check) => check.code === "OPENING_ERA_FORWARD_DISAGREES")).toMatchObject({
      salesItemId: 2,
      status: "block",
      expected: "10.00",
      actual: "9.50",
      detail: `Sales item 2: opening era ${KEY} validated by two recorded live rates gives a different cost than the checkpoint rewind`,
    });
    expect(checks.find((check) => check.code === "OPENING_ERA_OBSERVED_PROVEN")).toMatchObject({
      status: "pass",
      expected: "2",
      actual: "1",
      detail: `opening era ${KEY} validated by two recorded live rates; 1 blocked sale(s) priced by forward replay, 1 conflict(s) with the checkpoint rewind`,
    });
    expect(result).toMatchObject({ eraProvenSales: 1, eraConflictSales: 1 });
  });

  it("keeps an observed opening era open through zero stock until the second recorded rate", () => {
    const blocked = block(1);
    const { checks } = prove({
      opening: createHistoricalInventoryStateFromSnapshot("2", "10", "20"),
      movements: [
        m("o1", "-1", { sale: sale(1, "1") }),
        observation("p1", "10"),
        m("r", "5", { unitCost: "10" }),
        observation("p2", "10"),
      ],
      checkpointQuantity: "4",
      checks: [blocked],
    });
    expect(checks.some((check) => check.code === "OPENING_ERA_UNVALIDATED")).toBe(false);
    expect(checks.find((check) => check.code === "OPENING_ERA_OBSERVED_PROVEN")).toMatchObject({ actual: "1" });
    expect(blocked.status).toBe("warning");
  });

  it("does not reuse a receipt inside an unvalidated opening era as a closed-era anchor", () => {
    const blocked = block(1);
    const { checks } = prove({
      opening: createHistoricalInventoryStateFromSnapshot("0", "10", "0"),
      movements: [m("r", "2", { unitCost: "12" }), m("s", "-2", { sale: sale(1, "2") })],
      checkpointQuantity: "0",
      checks: [blocked],
    });
    expect(checks.find((check) => check.code === "OPENING_ERA_UNVALIDATED")).toMatchObject({ expected: "1" });
    expect(blocked.status).toBe("block");
  });

  it("leaves an opening-era sale blocked for a non-rewind reason", () => {
    const blocked = block(1, "OTHER_BLOCK");
    const { checks } = prove({
      opening: createHistoricalInventoryStateFromSnapshot("10", "10", "100"),
      movements: [m("o1", "-1", { sale: sale(1, "1") }), observation("p1", "10"), observation("p2", "10")],
      checkpointQuantity: "7",
      checks: [blocked],
    });
    expect(blocked.status).toBe("block");
    expect(checks).toEqual([blocked]);
  });

  it("does not use an opening era a recorded rate contradicts, one seen only once, or one whose quantity differs", () => {
    const cases: Array<[string, HistoricalSalesRepairMovement[], string]> = [
      ["contradicted", [m("o1", "-1", { sale: sale(1, "1") }), observation("p1", "10"), observation("p2", "11")], "7"],
      ["single observation", [m("o1", "-1", { sale: sale(1, "1") }), observation("p1", "10")], "8"],
    ];
    for (const [label, movements, checkpointQuantity] of cases) {
      const blocked = block(1);
      const { checks } = prove({
        opening: createHistoricalInventoryStateFromSnapshot("10", "10", "100"),
        movements,
        checkpointQuantity,
        checks: [blocked],
      });
      expect(blocked.status, label).toBe("block");
      expect(
        checks.some((check) => check.code.startsWith("OPENING_ERA")),
        label
      ).toBe(false);
    }
    const mismatch = block(1);
    const { checks } = prove({
      opening: createHistoricalInventoryStateFromSnapshot("9", "10", "90"),
      movements: [m("o1", "-1", { sale: sale(1, "1") }), m("o2", "-9")],
      checkpointQuantity: "0",
      checks: [mismatch],
    });
    expect(checks.some((check) => check.code === "OPENING_ERA_UNVALIDATED")).toBe(false);
  });
});

describe("proveClosedZeroStockEras observation-validated open eras", () => {
  const observedMovements = (rate = "10") => [
    m("x0", "-1"),
    m("r1", "5", { unitCost: "8" }),
    m("i1", "-1"),
    m("r2", "10", { unitCost: "10" }),
    m("s1", "-1", { sale: sale(1, "1") }),
    m("s2", "-1", { sale: sale(2, "1") }),
    observation("p1", "10"),
    m("s3", "-1", { sale: sale(3, "1") }),
    observation("p2", rate),
  ];

  it("prices sales before the first recorded rate from the last receipt into empty stock", () => {
    // Quantities: 1 → 0, receipt into empty stock → 10, then down to 5.
    const blocked = block(1);
    const later = block(3);
    const { checks, costs } = prove({
      movements: [
        m("x0", "-1"),
        m("r1", "10", { unitCost: "10" }),
        m("s1", "-1", { sale: sale(1, "1") }),
        m("s2", "-1", { sale: sale(2, "1") }),
        observation("p1", "10"),
        m("s3", "-1", { sale: sale(3, "1") }),
        observation("p2", "10"),
      ],
      checkpointQuantity: "5",
      checks: [blocked, later],
      proposals: [existing(2, "9.90")],
    });
    expect(blocked.detail).toBe("blocked 1 (superseded: observation-validated era r1..p1)");
    expect(blocked.status).toBe("warning");
    expect(later.status).toBe("block");
    expect(costs).toMatchObject({ 1: "10.00", 2: "9.90" });
    expect(checks.find((check) => check.code === "OBSERVED_ERA_FORWARD_DISAGREES")).toMatchObject({
      salesItemId: 2,
      expected: "10.00",
      actual: "9.90",
      detail: "Sales item 2: the observation-validated era from r1 gives a different cost than the checkpoint rewind",
    });
    expect(checks.find((check) => check.code === "OBSERVED_ERA_FORWARD_PROVEN")).toMatchObject({
      status: "pass",
      expected: "2",
      actual: "1",
      detail:
        "Era from r1 (priced receipt into empty stock) replays exactly to the recorded live rates at p1 and p2; 1 blocked sale(s) priced, 1 conflict(s)",
    });
  });

  it("starts from the latest qualifying receipt, skipping receipts into stock", () => {
    // Quantities: 1 → 0, r1 into empty → 5 → 4, r2 into stock → 14.
    const blocked = block(1);
    const { checks } = prove({ movements: observedMovements(), checkpointQuantity: "10", checks: [blocked] });
    // From r1 at 8.00, r2 at 10 gives (4×8 + 10×10)/14 = 9.43: the first recorded rate disagrees.
    expect(blocked.status).toBe("block");
    expect(checks.some((check) => check.code.startsWith("OBSERVED_ERA"))).toBe(false);
  });

  it("rejects the era when a recorded rate disagrees or stock goes short", () => {
    const disagree = block(1);
    prove({
      movements: [
        m("r1", "10", { unitCost: "10" }),
        m("s1", "-1", { sale: sale(1, "1") }),
        observation("p1", "10"),
        observation("p2", "10.50"),
      ],
      checkpointQuantity: "7",
      checks: [disagree],
    });
    expect(disagree.status).toBe("block");

    // Running short closes the zero-stock era first, so that era (not the observed one) prices the sale.
    const short = block(1);
    const { checks } = prove({
      movements: [
        m("r1", "2", { unitCost: "10" }),
        m("s1", "-1", { sale: sale(1, "1") }),
        observation("p1", "10"),
        m("big", "-5"),
        observation("p2", "10"),
      ],
      checkpointQuantity: "-6",
      checks: [short],
    });
    expect(short.detail).toBe("blocked 1 (superseded: closed zero-stock era r1..p1)");
    expect(checks.some((check) => check.code.startsWith("OBSERVED_ERA"))).toBe(false);
  });

  it("leaves a sale blocked for a non-rewind reason", () => {
    const blocked = block(1, "OTHER_BLOCK");
    const { checks } = prove({
      movements: [
        m("r1", "10", { unitCost: "10" }),
        m("s1", "-1", { sale: sale(1, "1") }),
        observation("p1", "10"),
        observation("p2", "10"),
      ],
      checkpointQuantity: "7",
      checks: [blocked],
    });
    expect(blocked.status).toBe("block");
    expect(checks).toEqual([blocked]);
  });

  it("needs a priced receipt into empty stock before the first observation", () => {
    const blocked = block(1);
    const { checks } = prove({
      movements: [
        m("r1", "10"),
        m("s1", "-1", { sale: sale(1, "1") }),
        observation("p1", "10"),
        observation("p2", "10"),
      ],
      checkpointQuantity: "7",
      checks: [blocked],
    });
    expect(blocked.status).toBe("block");
    expect(checks).toEqual([blocked]);
  });
});

describe("reportCheckpointRewindCoverage", () => {
  function report(overrides: Partial<Parameters<typeof reportCheckpointRewindCoverage>[0]> = {}) {
    const checks: RepairCheck[] = [];
    const proposalsBySaleId = new Map<number, HistoricalSalesRepairProposal>();
    const input = {
      companyId: 1,
      checks,
      legacySales: [] as SaleRow[],
      proposalsBySaleId,
      targetKeys: new Set([KEY]),
      checkpointStates: new Map([[KEY, createHistoricalInventoryStateFromSnapshot("0", "10", "0")]]),
      mergedRecovery: { recoveredKeys: new Set<string>(), proposals: [], checks: [] },
      unavailableKeys: new Set<string>(),
      checkpointTargetKeys: new Set([KEY]),
      forwardReplayResolvedKeys: new Set<string>(),
      movementsByTargetKey: new Map<string, HistoricalSalesRepairMovement[]>(),
      rewindAmplification: new Map(),
      REWIND_FAILURE_BLOCKS: /^LEGACY_REWIND_/,
      blockedSaleCodes: new Map<number, RepairCheck[]>(),
      eraProvenSales: 3,
      eraConflictSales: 1,
      ...overrides,
    };
    reportCheckpointRewindCoverage(input);
    return { checks: input.checks, proposalsBySaleId: input.proposalsBySaleId };
  }

  it("classifies each remaining rewind-failure sale by why no era covers it", () => {
    // Quantities ascending: 0 → 2 (start A) → 1 → 0 → 3 (start B) → 2.
    const movements = [
      m("e0", "-1", { sale: sale(1, "1") }),
      m("a", "2", { unitCost: "10" }),
      m("e1", "-1", { sale: sale(2, "1") }),
      m("e2", "-1"),
      m("b", "3"),
      m("e3", "-1", { sale: sale(3, "1") }),
      m("e4", "-1", { sale: sale(4, "1") }),
    ];
    const blockedSaleCodes = new Map<number, RepairCheck[]>([
      [1, [block(1)]],
      [2, [block(2)]],
      [3, [block(3)]],
      [4, [{ ...block(4), status: "warning" }]],
    ]);
    const { checks } = report({
      movementsByTargetKey: new Map([[KEY, movements]]),
      checkpointStates: new Map([[KEY, createHistoricalInventoryStateFromSnapshot("1", "10", "10")]]),
      blockedSaleCodes,
    });
    const gap = checks.find((check) => check.code === "ERA_COVERAGE_GAP_DIAGNOSTIC")!;
    expect(JSON.parse(gap.actual!)).toEqual({ noDeterminedStartBefore: 1, eraNeverCloses: 1, other: 1 });
    expect(gap).toMatchObject({ status: "warning", locationId: null, stockItemId: null });
  });

  it("ignores sales with other blocks and keys that are resolved or have no checkpoint", () => {
    const movements = [m("e0", "-1", { sale: sale(1, "1") })];
    const blockedSaleCodes = new Map<number, RepairCheck[]>([[1, [block(1), block(1, "OTHER")]]]);
    for (const overrides of [
      { blockedSaleCodes },
      { blockedSaleCodes: new Map([[1, [block(1)]]]), forwardReplayResolvedKeys: new Set([KEY]) },
      { blockedSaleCodes: new Map([[1, [block(1)]]]), checkpointStates: new Map() },
    ]) {
      const { checks } = report({ movementsByTargetKey: new Map([[KEY, movements]]), ...overrides });
      const gap = checks.find((check) => check.code === "ERA_COVERAGE_GAP_DIAGNOSTIC")!;
      expect(JSON.parse(gap.actual!)).toEqual({ noDeterminedStartBefore: 0, eraNeverCloses: 0, other: 0 });
    }
  });

  it("reports era totals and amplification above 1x only", () => {
    const { checks } = report({
      rewindAmplification: new Map([
        [KEY, { max: new Decimal("12.345"), maxSalesItemId: 7, proposals: 5, over10: 2, over100: 0 }],
        ["1:11:101", { max: new Decimal(1), maxSalesItemId: 8, proposals: 1, over10: 0, over100: 0 }],
      ]),
    });
    expect(checks.find((check) => check.code === "CLOSED_ZERO_STOCK_ERAS")).toMatchObject({
      status: "pass",
      expected: "3",
      actual: "1",
    });
    const amplification = checks.filter((check) => check.code === "REWIND_ERROR_AMPLIFICATION");
    expect(amplification).toHaveLength(1);
    expect(amplification[0]).toMatchObject({
      locationId: 10,
      stockItemId: 100,
      status: "warning",
      expected: "<=1.00",
      actual: "12.35",
      detail:
        "Rewound rate moves up to 12.35 cents per cent of checkpoint-side model error (worst: sales item 7); 5 rewound proposals, 2 above 10x, 0 above 100x",
    });
  });

  it("keeps the original cost for unpriced legacy sales with a location", () => {
    const priced = existing(2, "7.00");
    const proposalsBySaleId = new Map([[2, priced]]);
    report({
      proposalsBySaleId,
      legacySales: [saleRow(1, "5.55"), saleRow(2, "6.00"), saleRow(3, "4.00", null)],
    });
    expect(proposalsBySaleId.get(1)).toMatchObject({ proposedCostPrice: "5.55", changed: false });
    expect(proposalsBySaleId.get(2)).toBe(priced);
    expect(proposalsBySaleId.has(3)).toBe(false);
  });

  it("passes coverage only when every target key is rewind-ready or recovered", () => {
    const covered = report().checks.find((check) => check.code === "CHECKPOINT_REWIND_COVERAGE")!;
    expect(covered).toMatchObject({ status: "pass", expected: "1", actual: "1" });

    const short = report({ unavailableKeys: new Set([KEY]) }).checks.find(
      (check) => check.code === "CHECKPOINT_REWIND_COVERAGE"
    )!;
    expect(short).toMatchObject({ status: "warning", expected: "1", actual: "0" });

    const recovered = report({
      unavailableKeys: new Set([KEY]),
      mergedRecovery: { recoveredKeys: new Set([KEY]), proposals: [], checks: [] },
    }).checks.find((check) => check.code === "CHECKPOINT_REWIND_COVERAGE")!;
    expect(recovered).toMatchObject({ status: "pass", actual: "1" });
  });
});
