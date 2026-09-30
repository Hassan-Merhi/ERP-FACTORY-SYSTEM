import { describe, expect, it } from "vitest";
import {
  applyHistoricalInventoryMovement,
  createHistoricalInventoryState,
  createHistoricalInventoryStateFromSnapshot,
  historicalSaleProposalFromState,
  replayHistoricalSalesCosts,
  reverseHistoricalInventoryMovement,
  type HistoricalSalesRepairMovement,
} from "../server/services/inventory/historicalSalesCostRepairEngine";

function movement(
  overrides: Partial<HistoricalSalesRepairMovement> &
    Pick<HistoricalSalesRepairMovement, "movementId" | "quantityDelta">
): HistoricalSalesRepairMovement {
  return {
    movementId: overrides.movementId,
    companyId: 1,
    locationId: 10,
    stockItemId: 100,
    occurredAt: "2026-01-01T00:00:00.000Z",
    sequence: 1,
    quantityDelta: overrides.quantityDelta,
    unitCost: overrides.unitCost ?? null,
    sourceType: overrides.sourceType ?? "test",
    sourceId: overrides.sourceId ?? overrides.movementId,
    evidence: overrides.evidence ?? "legacy",
    sale: overrides.sale,
  };
}

describe("historical sales cost repair replay", () => {
  it("captures the weighted average immediately before each sale", () => {
    const result = replayHistoricalSalesCosts({
      openings: [{ companyId: 1, locationId: 10, stockItemId: 100, quantity: "10", averageRate: "10" }],
      movements: [
        movement({
          movementId: "sale-1",
          occurredAt: "2026-01-02T10:00:00.000Z",
          sequence: 1,
          quantityDelta: "-2",
          sale: {
            salesItemId: 1,
            voucherId: 11,
            quantity: "2",
            totalSales: "30",
            originalCostPrice: "99",
            originalTotalCost: "198",
            originalProfit: "-168",
          },
        }),
        movement({
          movementId: "receipt",
          occurredAt: "2026-01-03T10:00:00.000Z",
          sequence: 2,
          quantityDelta: "8",
          unitCost: "20",
        }),
        movement({
          movementId: "sale-2",
          occurredAt: "2026-01-04T10:00:00.000Z",
          sequence: 3,
          quantityDelta: "-4",
          sale: {
            salesItemId: 2,
            voucherId: 12,
            quantity: "4",
            totalSales: "100",
            originalCostPrice: "195.05",
            originalTotalCost: "780.20",
            originalProfit: "-680.20",
          },
        }),
      ],
    });

    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]).toMatchObject({
      salesItemId: 1,
      proposedCostPrice: "10.00",
      proposedTotalCost: "20.00",
      proposedProfit: "10.00",
      changed: true,
    });
    // 8 units @ $10 remain, then 8 @ $20 arrive => 16 units @ $15.
    expect(result.proposals[1]).toMatchObject({
      salesItemId: 2,
      proposedCostPrice: "15.00",
      proposedTotalCost: "60.00",
      proposedProfit: "40.00",
      changed: true,
    });
  });

  it("does not allow a later receipt to reprice an earlier sale", () => {
    const result = replayHistoricalSalesCosts({
      openings: [{ companyId: 1, locationId: 10, stockItemId: 100, quantity: "1", averageRate: "100.65" }],
      movements: [
        movement({
          movementId: "sale",
          occurredAt: "2026-01-01T10:00:00.000Z",
          sequence: 1,
          quantityDelta: "-1",
          sale: {
            salesItemId: 7,
            voucherId: 77,
            quantity: "1",
            totalSales: "150",
            originalCostPrice: "195.05",
            originalTotalCost: "195.05",
            originalProfit: "-45.05",
          },
        }),
        movement({
          movementId: "later-offload",
          occurredAt: "2026-01-02T10:00:00.000Z",
          sequence: 2,
          quantityDelta: "12",
          unitCost: "96.89",
        }),
      ],
    });

    expect(result.proposals[0].proposedCostPrice).toBe("100.65");
    expect(result.proposals[0].proposedTotalCost).toBe("100.65");
    expect(result.proposals[0].proposedProfit).toBe("49.35");
  });

  it("replaces zero-stock cost memory when a priced receipt arrives", () => {
    const zero = createHistoricalInventoryState("0", "195.05");
    const next = applyHistoricalInventoryMovement(zero, { quantityDelta: "12", unitCost: "96.89" });

    expect(next.quantity.toFixed(3)).toBe("12.000");
    expect(next.averageRate.toFixed(2)).toBe("96.89");
    expect(next.totalValue.toFixed(2)).toBe("1162.68");
  });

  it("settles a negative shortage before valuing the positive receipt remainder", () => {
    const negative = applyHistoricalInventoryMovement(createHistoricalInventoryState("1", "10"), {
      quantityDelta: "-3",
      unitCost: "10",
    });
    expect(negative.quantity.toFixed(3)).toBe("-2.000");
    expect(negative.totalValue.toFixed(2)).toBe("0.00");

    const next = applyHistoricalInventoryMovement(negative, {
      quantityDelta: "5",
      unitCost: "12",
    });
    expect(next.quantity.toFixed(3)).toBe("3.000");
    expect(next.averageRate.toFixed(2)).toBe("12.00");
    expect(next.totalValue.toFixed(2)).toBe("36.00");
  });

  it("uses the existing average for legacy positive movements with no incoming cost", () => {
    const next = applyHistoricalInventoryMovement(createHistoricalInventoryState("5", "8"), {
      quantityDelta: "2",
      unitCost: null,
    });
    expect(next.quantity.toFixed(3)).toBe("7.000");
    expect(next.averageRate.toFixed(2)).toBe("8.00");
    expect(next.totalValue.toFixed(2)).toBe("56.00");
  });

  it("is deterministic when timestamps are equal by using sequence order", () => {
    const result = replayHistoricalSalesCosts({
      openings: [{ companyId: 1, locationId: 10, stockItemId: 100, quantity: "10", averageRate: "10" }],
      movements: [
        movement({
          movementId: "sale",
          occurredAt: "2026-01-02T10:00:00.000Z",
          sequence: 2,
          quantityDelta: "-1",
          sale: {
            salesItemId: 5,
            voucherId: 15,
            quantity: "1",
            totalSales: "50",
            originalCostPrice: "0",
            originalTotalCost: "0",
            originalProfit: "50",
          },
        }),
        movement({
          movementId: "receipt",
          occurredAt: "2026-01-02T10:00:00.000Z",
          sequence: 1,
          quantityDelta: "10",
          unitCost: "20",
        }),
      ],
    });
    expect(result.proposals[0].proposedCostPrice).toBe("15.00");
  });
  it("preserves exact checkpoint value instead of regenerating it from the rounded rate", () => {
    const checkpoint = createHistoricalInventoryStateFromSnapshot("7", "10.01", "70.05");
    expect(checkpoint.quantity.toFixed(3)).toBe("7.000");
    expect(checkpoint.averageRate.toFixed(2)).toBe("10.01");
    expect(checkpoint.totalValue.toFixed(2)).toBe("70.05");
  });

  it("rewinds an outbound sale and derives the pre-sale transaction-time cost", () => {
    const before = createHistoricalInventoryStateFromSnapshot("10", "100.65", "1006.50");
    const after = applyHistoricalInventoryMovement(before, { quantityDelta: "-1", unitCost: "100.65" });
    const reversed = reverseHistoricalInventoryMovement(after, { quantityDelta: "-1", unitCost: "100.65" });
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("10.000");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.65");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("1006.50");

    const proposal = historicalSaleProposalFromState(
      movement({
        movementId: "sale-rewind",
        quantityDelta: "-1",
        unitCost: null,
        sale: {
          salesItemId: 91,
          voucherId: 92,
          quantity: "1",
          totalSales: "150",
          originalCostPrice: "195.05",
          originalTotalCost: "195.05",
          originalProfit: "-45.05",
        },
      }),
      reversed.stateBefore
    );
    expect(proposal.proposedCostPrice).toBe("100.65");
    expect(proposal.proposedTotalCost).toBe("100.65");
    expect(proposal.proposedProfit).toBe("49.35");
  });

  it("rewinds a priced receipt while prior stock was positive", () => {
    const before = createHistoricalInventoryStateFromSnapshot("8", "10", "80");
    const after = applyHistoricalInventoryMovement(before, { quantityDelta: "8", unitCost: "20" });
    const reversed = reverseHistoricalInventoryMovement(after, { quantityDelta: "8", unitCost: "20" });
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("8.000");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("10.00");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("80.00");
  });

  it("blocks rewind across a priced receipt that overwrote zero/negative cost memory", () => {
    const before = createHistoricalInventoryStateFromSnapshot("-2", "10", "0");
    const after = applyHistoricalInventoryMovement(before, { quantityDelta: "5", unitCost: "12" });
    const reversed = reverseHistoricalInventoryMovement(after, { quantityDelta: "5", unitCost: "12" });
    expect(reversed).toEqual({ reversible: false, reason: "COST_MEMORY_IRREVERSIBLE" });
  });

  it("rewinds a priced receipt across zero when canonical history pins the prior cost memory", () => {
    const before = createHistoricalInventoryStateFromSnapshot("-2", "10", "0");
    const after = applyHistoricalInventoryMovement(before, { quantityDelta: "5", unitCost: "12" });
    const reversed = reverseHistoricalInventoryMovement(after, {
      quantityDelta: "5",
      unitCost: "12",
      priorCostMemoryRate: "10",
    });
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("-2.000");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("10.00");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("0.00");
  });

  it("rejects an incorrect prior cost-memory anchor", () => {
    const before = createHistoricalInventoryStateFromSnapshot("-2", "10", "0");
    const after = applyHistoricalInventoryMovement(before, { quantityDelta: "5", unitCost: "12" });
    const reversed = reverseHistoricalInventoryMovement(after, {
      quantityDelta: "5",
      unitCost: "12",
      priorCostMemoryRate: "99",
    });
    expect(reversed).toEqual({ reversible: false, reason: "MOVEMENT_INVERSE_INVALID" });
  });

  it("can rewind an unpriced receipt across zero because cost memory is retained", () => {
    const before = createHistoricalInventoryStateFromSnapshot("-2", "10", "0");
    const after = applyHistoricalInventoryMovement(before, { quantityDelta: "5", unitCost: null });
    const reversed = reverseHistoricalInventoryMovement(after, { quantityDelta: "5", unitCost: null });
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("-2.000");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("10.00");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("0.00");
  });

  it("uses full canonical receipt precision before rounding stored inventory values", () => {
    const before = createHistoricalInventoryStateFromSnapshot("1", "10.00", "10.00");
    const after = applyHistoricalInventoryMovement(before, {
      quantityDelta: "24",
      unitCost: "69.194444",
    });

    expect(after.quantity.toFixed(3)).toBe("25.000");
    expect(after.averageRate.toFixed(2)).toBe("66.83");
    expect(after.totalValue.toFixed(2)).toBe("1670.67");

    const reversed = reverseHistoricalInventoryMovement(after, {
      quantityDelta: "24",
      unitCost: "69.194444",
    });
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("1.000");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("10.00");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("10.00");
  });

  it("proves a merged source by rewinding the kept checkpoint and conserving merge value", () => {
    const sourceOpening = createHistoricalInventoryStateFromSnapshot("10", "112.77", "1127.70");
    const sourceAfterReceipt = applyHistoricalInventoryMovement(sourceOpening, {
      quantityDelta: "6",
      unitCost: "117.56",
    });
    const sourceAtMerge = applyHistoricalInventoryMovement(sourceAfterReceipt, {
      quantityDelta: "-5",
      unitCost: sourceAfterReceipt.averageRate,
    });

    const keptOpening = createHistoricalInventoryStateFromSnapshot("0", "0", "0");
    const keptAtMerge = applyHistoricalInventoryMovement(keptOpening, {
      quantityDelta: "3",
      unitCost: "130.30",
    });

    const combinedQty = sourceAtMerge.quantity.plus(keptAtMerge.quantity);
    const combinedValue = sourceAtMerge.totalValue.plus(keptAtMerge.totalValue);
    const combinedAtMerge = createHistoricalInventoryStateFromSnapshot(
      combinedQty,
      combinedValue.dividedBy(combinedQty),
      combinedValue
    );

    const afterSale = applyHistoricalInventoryMovement(combinedAtMerge, {
      quantityDelta: "-4",
      unitCost: combinedAtMerge.averageRate,
    });
    const checkpoint = applyHistoricalInventoryMovement(afterSale, {
      quantityDelta: "6",
      unitCost: "127.79",
    });

    const undoReceipt = reverseHistoricalInventoryMovement(checkpoint, {
      quantityDelta: "6",
      unitCost: "127.79",
    });
    expect(undoReceipt.reversible).toBe(true);
    if (!undoReceipt.reversible) return;
    const undoSale = reverseHistoricalInventoryMovement(undoReceipt.stateBefore, {
      quantityDelta: "-4",
      unitCost: combinedAtMerge.averageRate,
    });
    expect(undoSale.reversible).toBe(true);
    if (!undoSale.reversible) return;
    expect(undoSale.stateBefore.quantity.toFixed(3)).toBe(combinedAtMerge.quantity.toFixed(3));
    expect(undoSale.stateBefore.totalValue.toFixed(2)).toBe(combinedAtMerge.totalValue.toFixed(2));

    const recoveredSourceQty = undoSale.stateBefore.quantity.minus(keptAtMerge.quantity);
    const recoveredSourceValue = undoSale.stateBefore.totalValue.minus(keptAtMerge.totalValue);
    const recoveredSourceAtMerge = createHistoricalInventoryStateFromSnapshot(
      recoveredSourceQty,
      recoveredSourceValue.dividedBy(recoveredSourceQty),
      recoveredSourceValue
    );
    expect(recoveredSourceAtMerge.quantity.toFixed(3)).toBe(sourceAtMerge.quantity.toFixed(3));
    expect(recoveredSourceAtMerge.totalValue.toFixed(2)).toBe(sourceAtMerge.totalValue.toFixed(2));

    const undoSourceSale = reverseHistoricalInventoryMovement(recoveredSourceAtMerge, {
      quantityDelta: "-5",
      unitCost: sourceAfterReceipt.averageRate,
    });
    expect(undoSourceSale.reversible).toBe(true);
    if (!undoSourceSale.reversible) return;
    const undoSourceReceipt = reverseHistoricalInventoryMovement(undoSourceSale.stateBefore, {
      quantityDelta: "6",
      unitCost: "117.56",
    });
    expect(undoSourceReceipt.reversible).toBe(true);
    if (!undoSourceReceipt.reversible) return;
    expect(undoSourceReceipt.stateBefore.quantity.toFixed(3)).toBe("10.000");
    expect(undoSourceReceipt.stateBefore.averageRate.toFixed(2)).toBe("112.77");
    expect(undoSourceReceipt.stateBefore.totalValue.toFixed(2)).toBe("1127.70");
  });
});
