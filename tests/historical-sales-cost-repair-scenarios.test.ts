import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  historicalRateWithinEvidencedRange,
  historicalIssueInverseCandidates,
  historicalSaleProposalFromState,
  isRecordedLiveRateObservation,
  reanchorHistoricalRewindAtRecordedRate,
  applyHistoricalForwardReplayMovement,
  createHistoricalForwardReplayState,
  reverseHistoricalSalesRepairMovement,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
} from "../server/services/inventory/historicalSalesCostRepairEngine";

/*
 * Historical COGS reconstruction scenarios. Every scenario asserts the actual
 * reconstructed cost (or that the sale stays blocked), worked out by hand from
 * weighted-average rules, never just that "something" was produced.
 *
 * The rewind helper mirrors the dry-run's checkpoint rewind: newest movement
 * first, every inverse must replay exactly, every original canonical sale's
 * recorded live rate must equal the reconstructed pre-sale rate, and the
 * Q_after/Q_before amplification is tracked per sale.
 */

let sequence = 0;
function mv(
  overrides: Partial<HistoricalSalesRepairMovement> &
    Pick<HistoricalSalesRepairMovement, "movementId" | "quantityDelta" | "occurredAt">
): HistoricalSalesRepairMovement {
  sequence += 1;
  return {
    companyId: 1,
    locationId: 10,
    stockItemId: 100,
    createdAt: overrides.createdAt ?? overrides.occurredAt,
    sequence,
    unitCost: null,
    exactValue: null,
    sourceType: "test",
    sourceId: overrides.movementId,
    evidence: "legacy",
    ...overrides,
  };
}

function legacySale(id: number, at: string, quantity: string, extra: Partial<HistoricalSalesRepairMovement> = {}) {
  return mv({
    movementId: `legacy-sale:${id}`,
    occurredAt: at,
    quantityDelta: `-${quantity}`,
    sourceType: "legacy-sale",
    sale: {
      salesItemId: id,
      voucherId: id,
      quantity,
      totalSales: new Decimal(quantity).times(50).toFixed(2),
      originalCostPrice: "999.99",
      originalTotalCost: new Decimal(quantity).times("999.99").toFixed(2),
      originalProfit: "0",
    },
    ...extra,
  });
}

function canonicalSale(id: string, at: string, quantity: string, recordedRate: string) {
  return mv({
    movementId: `canonical:${id}`,
    occurredAt: at,
    quantityDelta: `-${quantity}`,
    unitCost: recordedRate,
    sourceType: "pos-sale",
    evidence: "canonical",
    canonicalPosRole: "sale-issue",
  });
}

function offload(id: string, at: string, quantity: string, exactValue: string) {
  return mv({
    movementId: `offload:${id}`,
    occurredAt: at,
    quantityDelta: quantity,
    unitCost: new Decimal(exactValue).dividedBy(quantity).toFixed(6),
    exactValue,
    sourceType: "legacy-container-offload",
  });
}

function valuationOverride(
  id: string,
  at: string,
  before: [string, string, string],
  after: [string, string, string]
) {
  return mv({
    movementId: `valuation-override:${id}`,
    occurredAt: at,
    quantityDelta: new Decimal(after[0]).minus(before[0]).toFixed(3),
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
}

function state(quantity: string, rate: string, value: string): HistoricalInventoryState {
  return createHistoricalInventoryStateFromSnapshot(quantity, rate, value);
}

type RewindResult =
  | { ok: true; costs: Map<number, string>; sensitivity: Map<number, Decimal>; reached: HistoricalInventoryState }
  | { ok: false; at: string; reason: string; recorded?: string; inferred?: string; costs: Map<number, string> };

function rewind(
  checkpoint: HistoricalInventoryState,
  movementsAscending: HistoricalSalesRepairMovement[],
  hints: Map<string, string> = new Map()
): RewindResult {
  let current = checkpoint;
  const costs = new Map<number, string>();
  const sensitivity = new Map<number, Decimal>();
  let amplification = checkpoint.quantity.gt(0) ? new Decimal(1).dividedBy(checkpoint.quantity) : new Decimal(1);
  for (const movement of [...movementsAscending].reverse()) {
    const reversed = reverseHistoricalSalesRepairMovement(current, movement, {
      priorCostMemoryRate: hints.get(movement.movementId) ?? null,
    });
    if (!reversed.reversible) {
      // As in the dry-run: an erased cost memory is a safe stop when no
      // earlier sale needs the state below it.
      const earlierSale = movementsAscending
        .slice(0, movementsAscending.indexOf(movement))
        .some((earlier) => earlier.sale);
      if (reversed.reason === "COST_MEMORY_IRREVERSIBLE" && !earlierSale) {
        return { ok: true, costs, sensitivity, reached: current };
      }
      return { ok: false, at: movement.movementId, reason: reversed.reason, costs };
    }
    if (
      isRecordedLiveRateObservation(movement) &&
      new Decimal(movement.unitCost!).toFixed(2) !== reversed.stateBefore.averageRate.toFixed(2)
    ) {
      return {
        ok: false,
        at: movement.movementId,
        reason: "CANONICAL_SALE_COST_EVIDENCE_MISMATCH",
        recorded: new Decimal(movement.unitCost!).toFixed(2),
        inferred: reversed.stateBefore.averageRate.toFixed(2),
        costs,
      };
    }
    if (new Decimal(movement.quantityDelta).gt(0) && current.quantity.gt(0) && reversed.stateBefore.quantity.gt(0)) {
      amplification = amplification.times(current.quantity).dividedBy(reversed.stateBefore.quantity);
    }
    if (movement.sale) {
      costs.set(movement.sale.salesItemId, historicalSaleProposalFromState(movement, reversed.stateBefore).proposedCostPrice);
      sensitivity.set(movement.sale.salesItemId, amplification);
    }
    current = reversed.stateBefore;
  }
  return { ok: true, costs, sensitivity, reached: current };
}

/** Forward replay through the production forward-proof path, per company/location/item. */
function forwardCosts(
  openings: Array<{ locationId?: number; companyId?: number; stockItemId?: number; quantity: string; averageRate: string }>,
  movements: HistoricalSalesRepairMovement[]
): Map<number, string> {
  const key = (companyId: number, locationId: number, stockItemId: number) => `${companyId}:${locationId}:${stockItemId}`;
  const states = new Map<string, ReturnType<typeof createHistoricalForwardReplayState>>();
  for (const opening of openings) {
    const quantity = new Decimal(opening.quantity);
    states.set(
      key(opening.companyId ?? 1, opening.locationId ?? 10, opening.stockItemId ?? 100),
      createHistoricalForwardReplayState(
        createHistoricalInventoryStateFromSnapshot(quantity, opening.averageRate, quantity.times(opening.averageRate))
      )
    );
  }
  const costs = new Map<number, string>();
  const ordered = [...movements].sort(
    (a, b) => Date.parse(a.createdAt ?? a.occurredAt) - Date.parse(b.createdAt ?? b.occurredAt) || a.sequence - b.sequence
  );
  for (const movement of ordered) {
    const k = key(movement.companyId, movement.locationId, movement.stockItemId);
    const current = states.get(k) ?? createHistoricalForwardReplayState(state("0", "0", "0"));
    if (movement.sale) {
      costs.set(movement.sale.salesItemId, historicalSaleProposalFromState(movement, current.inventory).proposedCostPrice);
    }
    states.set(k, applyHistoricalForwardReplayMovement(current, movement));
  }
  return costs;
}

describe("historical COGS reconstruction scenarios", () => {
  it("1. canonical sale, then an unrecorded revaluation, then re-anchoring proves the earlier legacy sale", () => {
    // 10 @ 10.00 offloaded into empty stock; legacy sale of 4 (true cost 10.00);
    // canonical sale of 2 at a recorded 10.00; an unrecorded rewrite to 12.00;
    // canonical sale of 1 at a recorded 12.00; checkpoint 3 @ 12.00 = 36.00.
    const receipt = offload("1", "2026-08-01T08:00:00Z", "10", "100.00");
    const legacy = legacySale(1, "2026-08-02T08:00:00Z", "4");
    const anchor = canonicalSale("1", "2026-08-20T08:00:00Z", "2", "10.00");
    const afterJump = canonicalSale("2", "2026-09-02T08:00:00Z", "1", "12.00");
    const checkpoint = state("3", "12.00", "36.00");

    const plain = rewind(checkpoint, [receipt, legacy, anchor, afterJump]);
    expect(plain).toMatchObject({ ok: false, at: anchor.movementId, recorded: "10.00", inferred: "12.00" });

    const reanchored = reanchorHistoricalRewindAtRecordedRate({
      anchorQuantity: "6",
      recordedRate: "10.00",
      earlierMovementsDescending: [legacy, receipt],
      targetSaleIds: new Set([1]),
    });
    expect(reanchored.status).toBe("proven");
    // Only the value 60.00 replays the exact 100.00 offload; 59.97..60.02 die.
    expect(reanchored.survivorCount).toBe(1);
    expect(reanchored.proposals.get(1)?.proposedCostPrice).toBe("10.00");
  });

  it("2. multiple canonical sales with an evidenced rate change between them rewind exactly", () => {
    const receipt = offload("2a", "2026-08-01T08:00:00Z", "10", "100.00");
    const legacy = legacySale(2, "2026-08-02T08:00:00Z", "4");
    const first = canonicalSale("3", "2026-08-20T08:00:00Z", "1", "10.00");
    const priced = offload("2b", "2026-08-21T08:00:00Z", "5", "70.00");
    const second = canonicalSale("4", "2026-08-22T08:00:00Z", "2", "12.00");
    const result = rewind(state("8", "12.00", "96.00"), [receipt, legacy, first, priced, second]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.costs.get(2)).toBe("10.00");
    expect(result.reached.quantity.toFixed(3)).toBe("10.000");
  });

  it("3. canonical sales with no movement between them and identical cost are consistent", () => {
    const receipt = offload("3", "2026-08-01T08:00:00Z", "10", "150.00");
    const legacy = legacySale(3, "2026-08-02T08:00:00Z", "2");
    const a = canonicalSale("5", "2026-08-20T08:00:00Z", "3", "15.00");
    const b = canonicalSale("6", "2026-08-21T08:00:00Z", "1", "15.00");
    const result = rewind(state("4", "15.00", "60.00"), [receipt, legacy, a, b]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.costs.get(3)).toBe("15.00");
  });

  it("4. canonical sales with different cost and a recorded valuation override rewind through the override", () => {
    const receipt = offload("4", "2026-08-01T08:00:00Z", "10", "100.00");
    const legacy = legacySale(4, "2026-08-02T08:00:00Z", "4");
    const a = canonicalSale("7", "2026-08-20T08:00:00Z", "1", "10.00");
    const override = valuationOverride("4", "2026-09-01T09:00:00Z", ["5", "10.00", "50.00"], ["5", "12.00", "60.00"]);
    const b = canonicalSale("8", "2026-09-02T08:00:00Z", "1", "12.00");
    const result = rewind(state("4", "12.00", "48.00"), [receipt, legacy, a, override, b]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.costs.get(4)).toBe("10.00");
  });

  it("5. canonical sales with different cost and no independent evidence stay blocked when no anchor is unique", () => {
    // A legacy receipt with no stored total value sits between the legacy
    // sale and the anchor, so each candidate value at the anchor implies a
    // different earlier rate: no single reconstruction exists.
    const legacy = legacySale(5, "2026-08-02T08:00:00Z", "4");
    const receipt = mv({
      movementId: "legacy-receipt:5",
      occurredAt: "2026-08-03T08:00:00Z",
      quantityDelta: "2",
      unitCost: "20.00",
      sourceType: "legacy-receipt",
    });
    const anchor = canonicalSale("9", "2026-08-20T08:00:00Z", "2", "10.00");
    const after = canonicalSale("10", "2026-09-02T08:00:00Z", "1", "12.00");
    const plain = rewind(state("3", "12.00", "36.00"), [legacy, receipt, anchor, after]);
    expect(plain).toMatchObject({ ok: false, reason: "CANONICAL_SALE_COST_EVIDENCE_MISMATCH" });

    const reanchored = reanchorHistoricalRewindAtRecordedRate({
      anchorQuantity: "6",
      recordedRate: "10.00",
      earlierMovementsDescending: [receipt, legacy],
      targetSaleIds: new Set([5]),
    });
    expect(reanchored.status).toBe("ambiguous");
    expect(reanchored.distinctOutcomeCount).toBeGreaterThan(1);
    expect(reanchored.proposals.size).toBe(0);
  });

  it("6. a zero-stock reset followed by a new receipt starts a new average", () => {
    const costs = forwardCosts(
      [{ quantity: "2", averageRate: "10" }],
      [
        legacySale(61, "2026-03-01T08:00:00Z", "2"),
        offload("6", "2026-03-02T08:00:00Z", "3", "45.00"),
        legacySale(62, "2026-03-03T08:00:00Z", "1"),
      ]
    );
    expect(costs.get(61)).toBe("10.00");
    expect(costs.get(62)).toBe("15.00");
  });

  it("7. a negative-stock sale uses cost memory and the following receipt settles the shortage", () => {
    const costs = forwardCosts(
      [{ quantity: "1", averageRate: "10" }],
      [
        legacySale(71, "2026-04-01T08:00:00Z", "3"),
        offload("7", "2026-04-02T08:00:00Z", "5", "60.00"),
        legacySale(72, "2026-04-03T08:00:00Z", "1"),
      ]
    );
    expect(costs.get(71)).toBe("10.00");
    // 2 short units are settled from the receipt; the remaining 3 @ 12.00 set the rate.
    expect(costs.get(72)).toBe("12.00");
  });

  it("8. transfers move source cost between locations without cross-company leakage", () => {
    const out = mv({
      movementId: "transfer-out:8",
      occurredAt: "2026-03-01T08:00:00Z",
      quantityDelta: "-2",
      sourceType: "legacy-transfer",
    });
    const into = mv({
      movementId: "transfer-in:8",
      locationId: 20,
      occurredAt: "2026-03-01T08:00:01Z",
      quantityDelta: "2",
      unitCost: "10.00",
      sourceType: "legacy-transfer",
    });
    const destinationSale = legacySale(81, "2026-03-02T08:00:00Z", "1", { locationId: 20 });
    const sourceSale = legacySale(82, "2026-03-02T08:00:00Z", "1");
    const otherCompanySale = legacySale(83, "2026-03-02T08:00:00Z", "1", { companyId: 2 });
    const costs = forwardCosts(
      [
        { quantity: "4", averageRate: "10" },
        { locationId: 20, quantity: "2", averageRate: "20" },
        { companyId: 2, quantity: "1", averageRate: "99" },
      ],
      [out, into, destinationSale, sourceSale, otherCompanySale]
    );
    expect(costs.get(81)).toBe("15.00");
    expect(costs.get(82)).toBe("10.00");
    expect(costs.get(83)).toBe("99.00");
  });

  it("9. a quantity-only adjustment keeps the rate", () => {
    const costs = forwardCosts(
      [{ quantity: "4", averageRate: "10" }],
      [
        mv({ movementId: "adjust:9", occurredAt: "2026-03-01T08:00:00Z", quantityDelta: "2", sourceType: "legacy-adjustment" }),
        legacySale(91, "2026-03-02T08:00:00Z", "1"),
      ]
    );
    expect(costs.get(91)).toBe("10.00");
  });

  it("10. a priced adjustment legitimately changes the rate", () => {
    const costs = forwardCosts(
      [{ quantity: "4", averageRate: "10" }],
      [
        mv({
          movementId: "adjust:10",
          occurredAt: "2026-03-01T08:00:00Z",
          quantityDelta: "2",
          unitCost: "16.00",
          sourceType: "legacy-adjustment",
        }),
        legacySale(101, "2026-03-02T08:00:00Z", "1"),
      ]
    );
    expect(costs.get(101)).toBe("12.00");
  });

  it("11. a container offload updates the weighted average from its exact value", () => {
    const costs = forwardCosts(
      [{ quantity: "4", averageRate: "10" }],
      [offload("11", "2026-03-01T08:00:00Z", "6", "90.00"), legacySale(111, "2026-03-02T08:00:00Z", "1")]
    );
    expect(costs.get(111)).toBe("13.00");
  });

  it("12. a credit-note return re-enters at its recorded cost", () => {
    const costs = forwardCosts(
      [{ quantity: "4", averageRate: "10" }],
      [
        legacySale(121, "2026-03-01T08:00:00Z", "2"),
        offload("12", "2026-03-02T08:00:00Z", "3", "60.00"),
        mv({
          movementId: "credit-note:12",
          occurredAt: "2026-03-03T08:00:00Z",
          quantityDelta: "1",
          unitCost: "10.00",
          sourceType: "credit-note",
        }),
        legacySale(122, "2026-03-04T08:00:00Z", "1"),
      ]
    );
    expect(costs.get(121)).toBe("10.00");
    // 2 @ 10 + 3 @ 20 = 80 over 5; the return adds 1 @ 10 => 90 / 6 = 15.00.
    expect(costs.get(122)).toBe("15.00");
  });

  it("13. an item merge carries the source value into the kept item", () => {
    const mergeOut = mv({
      movementId: "merge-out:13",
      stockItemId: 200,
      occurredAt: "2026-03-02T08:00:00Z",
      quantityDelta: "-2",
      sourceType: "stock-item-merge",
    });
    const mergeIn = mv({
      movementId: "merge-in:13",
      occurredAt: "2026-03-02T08:00:01Z",
      quantityDelta: "2",
      unitCost: "16.00",
      sourceType: "stock-item-merge",
    });
    const costs = forwardCosts(
      [
        { quantity: "2", averageRate: "10" },
        { stockItemId: 200, quantity: "3", averageRate: "16" },
      ],
      [
        legacySale(131, "2026-03-01T08:00:00Z", "1", { stockItemId: 200 }),
        mergeOut,
        mergeIn,
        legacySale(132, "2026-03-03T08:00:00Z", "1"),
      ]
    );
    expect(costs.get(131)).toBe("16.00");
    expect(costs.get(132)).toBe("13.00");
  });

  it("14. a recorded manual valuation override splits the sales into two valuation eras", () => {
    const override = valuationOverride("14", "2026-03-02T08:00:00Z", ["3", "10.00", "30.00"], ["3", "12.00", "36.00"]);
    const before = legacySale(141, "2026-03-01T08:00:00Z", "1");
    const after = legacySale(142, "2026-03-03T08:00:00Z", "1");
    const forward = forwardCosts([{ quantity: "4", averageRate: "10" }], [before, override, after]);
    expect(forward.get(141)).toBe("10.00");
    expect(forward.get(142)).toBe("12.00");

    const rewound = rewind(state("2", "12.00", "24.00"), [before, override, after]);
    expect(rewound).toMatchObject({ ok: true });
    if (!rewound.ok) return;
    expect(rewound.costs.get(141)).toBe("10.00");
    expect(rewound.costs.get(142)).toBe("12.00");
  });

  it("15. a cost-memory reset above a canonical sale is crossed by re-anchoring at the sale", () => {
    // Company 1 / 135 / 730 shape: the last unit sells at a recorded 168.81,
    // stock is empty, POS edit legs journal the old 168.83 line cost, and a
    // 19-unit offload into empty stock sets 169.23. The checkpoint holds no
    // information about the rate before the offload.
    const receipt = offload("15", "2026-08-01T08:00:00Z", "3", "506.43");
    const legacy = legacySale(15, "2026-08-02T08:00:00Z", "2");
    const anchor = canonicalSale("30043", "2026-09-09T13:30:40Z", "1", "168.81");
    const editReversal = mv({
      movementId: "canonical:30863",
      occurredAt: "2026-09-10T08:16:33Z",
      quantityDelta: "1",
      unitCost: "168.83",
      sourceType: "pos-sale",
      evidence: "canonical",
      canonicalPosRole: "edit-reversal",
    });
    const editIssue = mv({
      movementId: "canonical:30942",
      occurredAt: "2026-09-10T08:16:33Z",
      quantityDelta: "-1",
      unitCost: "168.83",
      sourceType: "pos-sale",
      evidence: "canonical",
      canonicalPosRole: "edit-issue",
    });
    const reset = offload("33026", "2026-09-11T08:33:40Z", "19", "3215.37");
    const history = [receipt, legacy, anchor, editReversal, editIssue, reset];
    const checkpoint = state("19", "169.23", "3215.37");

    // Without a cost-memory hint the rewind cannot cross the empty-stock offload.
    expect(rewind(checkpoint, history)).toMatchObject({ ok: false, at: reset.movementId, reason: "COST_MEMORY_IRREVERSIBLE" });
    // Even with the edit leg's old 168.83 line cost as the cost-memory hint,
    // the zero-crossing sale is inverted at its recorded 168.81, so the
    // legacy sale is priced from the recorded live rate, not from the hint.
    const hinted = rewind(checkpoint, history, new Map([[reset.movementId, "168.83"]]));
    expect(hinted).toMatchObject({ ok: true });
    if (hinted.ok) expect(hinted.costs.get(15)).toBe("168.81");

    const reanchored = reanchorHistoricalRewindAtRecordedRate({
      anchorQuantity: "1",
      recordedRate: "168.81",
      earlierMovementsDescending: [legacy, receipt],
      targetSaleIds: new Set([15]),
    });
    expect(reanchored.status).toBe("proven");
    expect(reanchored.proposals.get(15)?.proposedCostPrice).toBe("168.81");
  });

  it("16. bad rewind math that leaves the evidenced rate range is rejected", () => {
    // A one-unit key: each receipt of 4 @ ~100 multiplies a checkpoint-side
    // error by 5 when rewound. A 2-cent drift explodes far outside the range
    // of every rate the item carried.
    const history: HistoricalSalesRepairMovement[] = [];
    for (let i = 0; i < 6; i += 1) {
      history.push(offload(`16-${i}`, `2026-0${(i % 6) + 1}-01T08:00:00Z`, "4", "400.00"));
      history.push(legacySale(160 + i, `2026-0${(i % 6) + 1}-02T08:00:00Z`, "4"));
    }
    const truth = rewind(state("1", "100.00", "100.00"), history);
    expect(truth).toMatchObject({ ok: true });
    if (truth.ok) expect(truth.costs.get(160)).toBe("100.00");

    const drifted = rewind(state("1", "100.02", "100.02"), history);
    if (drifted.ok) {
      const earliest = new Decimal(drifted.costs.get(160)!);
      expect(historicalRateWithinEvidencedRange(earliest, { min: new Decimal("100.00"), max: new Decimal("100.00") })).toBe(
        false
      );
    } else {
      expect(drifted.reason).toMatch(/INVALID|IRREVERSIBLE/);
    }
  });

  it("17. a reconstruction amplified more than 100x is measured as such", () => {
    const history: HistoricalSalesRepairMovement[] = [];
    for (let i = 0; i < 4; i += 1) {
      history.push(offload(`17-${i}`, `2026-0${i + 1}-01T08:00:00Z`, "9", "900.00"));
      history.push(legacySale(170 + i, `2026-0${i + 1}-02T08:00:00Z`, "9"));
    }
    const result = rewind(state("1", "100.00", "100.00"), history);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Three receipts of 9 onto 1 unit (10/1 each) lie between sale 170 and the checkpoint.
    expect(result.sensitivity.get(170)!.toNumber()).toBeGreaterThan(100);
    expect(result.sensitivity.get(173)!.toNumber()).toBeLessThanOrEqual(1);
  });

  it("18. several valuation eras within one key are each priced from their own era", () => {
    const first = valuationOverride("18a", "2026-03-02T08:00:00Z", ["5", "10.00", "50.00"], ["5", "11.00", "55.00"]);
    const second = valuationOverride("18b", "2026-03-04T08:00:00Z", ["4", "11.00", "44.00"], ["4", "13.50", "54.00"]);
    const sales = [
      legacySale(181, "2026-03-01T08:00:00Z", "1"),
      legacySale(182, "2026-03-03T08:00:00Z", "1"),
      legacySale(183, "2026-03-05T08:00:00Z", "1"),
    ];
    const history = [sales[0], first, sales[1], second, sales[2]];
    const forward = forwardCosts([{ quantity: "6", averageRate: "10" }], history);
    expect([forward.get(181), forward.get(182), forward.get(183)]).toEqual(["10.00", "11.00", "13.50"]);

    const rewound = rewind(state("3", "13.50", "40.50"), history);
    expect(rewound).toMatchObject({ ok: true });
    if (!rewound.ok) return;
    expect([rewound.costs.get(181), rewound.costs.get(182), rewound.costs.get(183)]).toEqual([
      "10.00",
      "11.00",
      "13.50",
    ]);
    // A drifted era boundary is not crossed silently.
    expect(rewind(state("3", "13.50", "40.51"), history)).toMatchObject({ ok: false });
  });

  it("applies the recorded live rate only for original sale issues", () => {
    expect(isRecordedLiveRateObservation(canonicalSale("x", "2026-09-01T00:00:00Z", "1", "10"))).toBe(true);
    expect(
      isRecordedLiveRateObservation(
        mv({
          movementId: "canonical:edit",
          occurredAt: "2026-09-01T00:00:00Z",
          quantityDelta: "-1",
          unitCost: "10",
          sourceType: "pos-sale",
          evidence: "canonical",
          canonicalPosRole: "edit-issue",
        })
      )
    ).toBe(false);
    expect(isRecordedLiveRateObservation(legacySale(1, "2026-03-01T00:00:00Z", "1"))).toBe(false);
    void applyHistoricalSalesRepairMovement;
  });

  it("keeps every exact inverse of a large live-rate issue and lets a recorded live rate choose (1/134/113)", () => {
    const item = { locationId: 134, stockItemId: 113, evidence: "canonical" as const };
    const sale14647 = { ...canonicalSale("14647", "2026-08-28T13:57:21Z", "2", "78.25"), ...item };
    const transfer15602 = mv({ movementId: "canonical:15602", occurredAt: "2026-08-29T10:06:06Z", quantityDelta: "-10", unitCost: "78.25", sourceType: "stock-transfer", ...item });
    const offload18586 = mv({ movementId: "canonical:18586", occurredAt: "2026-09-02T07:19:11Z", quantityDelta: "10", unitCost: "84.31", exactValue: "843.10", sourceType: "container-offload", ...item });
    const editReversal = mv({ movementId: "canonical:20609", occurredAt: "2026-09-03T07:42:37Z", quantityDelta: "2", unitCost: "78.81", sourceType: "pos-sale", canonicalPosRole: "edit-reversal", ...item });
    const editIssue = mv({ movementId: "canonical:20635", occurredAt: "2026-09-03T07:42:37Z", quantityDelta: "-2", unitCost: "78.81", sourceType: "pos-sale", canonicalPosRole: "edit-issue", ...item });
    const offload22587 = mv({ movementId: "canonical:22587", occurredAt: "2026-09-05T06:12:41Z", quantityDelta: "6", unitCost: "84.47", exactValue: "506.82", sourceType: "container-offload", ...item });
    const transfer23667 = mv({ movementId: "canonical:23667", occurredAt: "2026-09-05T11:28:54Z", quantityDelta: "-100", unitCost: "78.81", sourceType: "stock-transfer", ...item });

    const candidates = historicalIssueInverseCandidates(state("14", "79.10", "1107.34"), transfer23667);
    expect(candidates.map((candidate) => candidate.averageRate.toFixed(2))).toEqual(
      expect.arrayContaining(["79.10", "79.11"])
    );

    const reachedRates = candidates.map((candidate) => {
      const branch = rewind(candidate, [sale14647, transfer15602, offload18586, editReversal, editIssue, offload22587]);
      return branch.ok ? "ok" : `${branch.at}:${branch.inferred ?? branch.reason}`;
    });
    // The first exact inverse (79.10) the generic rewind takes contradicts the
    // recorded 78.25; the 79.11 branch replays every movement and agrees.
    const byRate = new Map(candidates.map((candidate, index) => [candidate.averageRate.toFixed(2), reachedRates[index]]));
    expect(byRate.get("79.10")).toBe("canonical:14647:78.24");
    expect(byRate.get("79.11")).toBe("ok");
  });

  it("re-anchors through an ambiguous restored POS line by branching and recovers the true legacy cost", () => {
    // Forward truth: 7 offloaded into empty stock, a legacy sale of 1, a
    // canonical sale journaled 2 with a 3-unit line dropped, then the anchor.
    const receipt = offload("re-1", "2026-08-01T08:00:00Z", "7", "1181.79");
    const legacy = legacySale(901, "2026-08-02T08:00:00Z", "1");
    let truth = applyHistoricalSalesRepairMovement(state("0", "0", "0"), receipt);
    const legacyCost = truth.averageRate.toFixed(2);
    truth = applyHistoricalSalesRepairMovement(truth, legacy);
    const original = canonicalSale("26001", "2026-09-07T14:27:31Z", "2", truth.averageRate.toFixed(2));
    truth = applyHistoricalSalesRepairMovement(truth, original);
    const dropped = mv({
      movementId: "canonical-dropped-line:26001:2",
      occurredAt: "2026-09-07T14:27:31Z",
      quantityDelta: "-3",
      sourceType: "pos-sale",
      evidence: "canonical",
      canonicalPosRole: "dropped-line",
    });
    truth = applyHistoricalSalesRepairMovement(truth, dropped);

    const result = reanchorHistoricalRewindAtRecordedRate({
      anchorQuantity: truth.quantity,
      recordedRate: truth.averageRate,
      earlierMovementsDescending: [dropped, original, legacy, receipt],
      targetSaleIds: new Set([901]),
    });
    expect(result.status).toBe("proven");
    expect(result.proposals.get(901)?.proposedCostPrice).toBe(legacyCost);
  });
});
