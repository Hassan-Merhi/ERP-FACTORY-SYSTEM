import { describe, expect, it } from "vitest";
import {
  applyHistoricalForwardReplayMovement,
  applyHistoricalInventoryMovement,
  applyHistoricalSalesRepairMovement,
  createHistoricalForwardReplayState,
  createHistoricalInventoryState,
  createHistoricalInventoryStateFromSnapshot,
  historicalSaleProposalFromState,
  replayHistoricalSalesCosts,
  reverseHistoricalInventoryMovement,
  reverseHistoricalSalesRepairMovement,
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
    occurredAt: overrides.occurredAt ?? "2026-01-01T00:00:00.000Z",
    createdAt: overrides.createdAt,
    sequence: overrides.sequence ?? 1,
    quantityDelta: overrides.quantityDelta,
    unitCost: overrides.unitCost ?? null,
    exactValue: overrides.exactValue ?? null,
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

  it("replays and rewinds a positive-stock offload from its exact stored value", () => {
    const before = createHistoricalInventoryStateFromSnapshot("5", "100.00", "500.00");
    const offload = movement({
      movementId: "offload:500",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "3",
      unitCost: "83.33",
      exactValue: "250.01",
      sourceType: "legacy-container-offload",
      sourceId: "500",
    });

    const after = applyHistoricalSalesRepairMovement(before, offload);
    expect(after.quantity.toFixed(3)).toBe("8.000");
    expect(after.totalValue.toFixed(2)).toBe("750.01");
    expect(after.averageRate.toFixed(2)).toBe("93.75");

    const reversed = reverseHistoricalSalesRepairMovement(after, offload);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("5.000");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("500.00");
  });

  it("treats a post-hotfix negative-to-positive offload as a cost-memory reset", () => {
    const before = createHistoricalInventoryStateFromSnapshot("-2", "10.00", "0.00");
    const offload = movement({
      movementId: "offload:501",
      occurredAt: "2026-04-01T10:00:00.000Z",
      quantityDelta: "5",
      unitCost: "12.00",
      exactValue: "60.00",
      sourceType: "legacy-container-offload",
      sourceId: "501",
    });

    const after = applyHistoricalSalesRepairMovement(before, offload);
    expect(after.quantity.toFixed(3)).toBe("3.000");
    expect(after.averageRate.toFixed(2)).toBe("12.00");
    expect(after.totalValue.toFixed(2)).toBe("36.00");

    expect(reverseHistoricalSalesRepairMovement(after, offload)).toEqual({
      reversible: false,
      reason: "COST_MEMORY_IRREVERSIBLE",
    });

    const anchored = reverseHistoricalSalesRepairMovement(after, offload, {
      priorCostMemoryRate: "10.00",
    });
    expect(anchored.reversible).toBe(true);
    if (!anchored.reversible) return;
    expect(anchored.stateBefore.quantity.toFixed(3)).toBe("-2.000");
    expect(anchored.stateBefore.averageRate.toFixed(2)).toBe("10.00");
  });

  it("replays and rewinds offload suspension by exact stored value", () => {
    const before = createHistoricalInventoryStateFromSnapshot("10", "100.00", "1000.00");
    const suspend = movement({
      movementId: "canonical:9001",
      occurredAt: "2026-09-10T10:00:00.000Z",
      quantityDelta: "-3",
      unitCost: "100.00",
      exactValue: "299.99",
      sourceType: "offload_optional_suspend",
      sourceId: "501",
      evidence: "canonical",
    });

    const after = applyHistoricalSalesRepairMovement(before, suspend);
    expect(after.quantity.toFixed(3)).toBe("7.000");
    expect(after.totalValue.toFixed(2)).toBe("700.01");
    expect(after.averageRate.toFixed(2)).toBe("100.00");

    const reversed = reverseHistoricalSalesRepairMovement(after, suspend);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("10.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("1000.00");
  });

  it("keeps offload restore on the generic receipt path", () => {
    const before = createHistoricalInventoryStateFromSnapshot("7", "100.00", "700.01");
    const restore = movement({
      movementId: "canonical:9002",
      occurredAt: "2026-09-10T11:00:00.000Z",
      quantityDelta: "3",
      unitCost: "100.00",
      exactValue: "299.99",
      sourceType: "offload_optional_restore",
      sourceId: "501",
      evidence: "canonical",
    });

    const after = applyHistoricalSalesRepairMovement(before, restore);
    expect(after.quantity.toFixed(3)).toBe("10.000");
    expect(after.totalValue.toFixed(2)).toBe("1000.01");
  });


  it("replays the pre-March-13 signed-value inventory bug exactly", () => {
    const start = createHistoricalForwardReplayState(
      createHistoricalInventoryStateFromSnapshot("1", "10.00", "10.00")
    );
    const issue = applyHistoricalForwardReplayMovement(
      start,
      movement({
        movementId: "legacy-issue",
        occurredAt: "2026-03-01T10:00:00.000Z",
        quantityDelta: "-2",
      })
    );

    expect(issue.inventory.quantity.toFixed(3)).toBe("-1.000");
    expect(issue.inventory.averageRate.toFixed(2)).toBe("10.00");
    expect(issue.inventory.totalValue.toFixed(2)).toBe("-10.00");

    const receipt = applyHistoricalForwardReplayMovement(
      issue,
      movement({
        movementId: "legacy-receipt",
        occurredAt: "2026-03-02T10:00:00.000Z",
        quantityDelta: "2",
        unitCost: "20.00",
      })
    );

    expect(receipt.inventory.quantity.toFixed(3)).toBe("1.000");
    expect(receipt.inventory.totalValue.toFixed(2)).toBe("30.00");
    expect(receipt.inventory.averageRate.toFixed(2)).toBe("30.00");
  });

  it("replays the March-13 safety clamp before negative layers existed", () => {
    const start = createHistoricalForwardReplayState(
      createHistoricalInventoryStateFromSnapshot("1", "10.00", "10.00")
    );
    const next = applyHistoricalForwardReplayMovement(
      start,
      movement({
        movementId: "post-safety-issue",
        occurredAt: "2026-03-13T12:00:00.000Z",
        quantityDelta: "-2",
      })
    );

    expect(next.inventory.quantity.toFixed(3)).toBe("-1.000");
    expect(next.inventory.averageRate.toFixed(2)).toBe("0.00");
    expect(next.inventory.totalValue.toFixed(2)).toBe("0.00");
    expect(next.negativeLayerQuantity.toFixed(3)).toBe("0.000");
  });

  it("replays the pre-July full-shortage negative-layer overcount", () => {
    const start = createHistoricalForwardReplayState(
      createHistoricalInventoryStateFromSnapshot("-2", "100.00", "0.00"),
      "2"
    );
    const next = applyHistoricalForwardReplayMovement(
      start,
      movement({
        movementId: "april-shortage",
        occurredAt: "2026-04-01T10:00:00.000Z",
        quantityDelta: "-1",
      })
    );

    expect(next.inventory.quantity.toFixed(3)).toBe("-3.000");
    // Old engine added the full 3-unit shortage again instead of only +1.
    expect(next.negativeLayerQuantity.toFixed(3)).toBe("5.000");
  });

  it("uses incremental shortage creation after the July hardening", () => {
    const start = createHistoricalForwardReplayState(
      createHistoricalInventoryStateFromSnapshot("-3", "100.00", "0.00"),
      "3"
    );
    const next = applyHistoricalForwardReplayMovement(
      start,
      movement({
        movementId: "july-shortage",
        occurredAt: "2026-07-13T10:00:00.000Z",
        quantityDelta: "-1",
      })
    );

    expect(next.inventory.quantity.toFixed(3)).toBe("-4.000");
    expect(next.negativeLayerQuantity.toFixed(3)).toBe("4.000");
  });

  it("consumes stale layers from positive stock before the September-11 fix", () => {
    const start = createHistoricalForwardReplayState(
      createHistoricalInventoryStateFromSnapshot("10", "100.00", "1000.00"),
      "5"
    );
    const next = applyHistoricalForwardReplayMovement(
      start,
      movement({
        movementId: "pre-fix-receipt",
        occurredAt: "2026-09-10T10:00:00.000Z",
        quantityDelta: "5",
        unitCost: "100.00",
        sourceType: "legacy-stock-transfer-in",
      })
    );

    expect(next.inventory.quantity.toFixed(3)).toBe("15.000");
    expect(next.inventory.totalValue.toFixed(2)).toBe("1000.00");
    expect(next.inventory.averageRate.toFixed(2)).toBe("66.67");
    expect(next.negativeLayerQuantity.toFixed(3)).toBe("0.000");
  });

  it("preserves stale layers when live stock is positive after the September-11 fix", () => {
    const start = createHistoricalForwardReplayState(
      createHistoricalInventoryStateFromSnapshot("10", "100.00", "1000.00"),
      "5"
    );
    const next = applyHistoricalForwardReplayMovement(
      start,
      movement({
        movementId: "post-fix-receipt",
        occurredAt: "2026-09-12T10:00:00.000Z",
        quantityDelta: "5",
        unitCost: "100.00",
        sourceType: "legacy-stock-transfer-in",
      })
    );

    expect(next.inventory.quantity.toFixed(3)).toBe("15.000");
    expect(next.inventory.totalValue.toFixed(2)).toBe("1500.00");
    expect(next.inventory.averageRate.toFixed(2)).toBe("100.00");
    expect(next.negativeLayerQuantity.toFixed(3)).toBe("5.000");
  });

  it("does not treat a POS reversal journal cost as a receipt rate", () => {
    const start = createHistoricalForwardReplayState(
      createHistoricalInventoryStateFromSnapshot("5", "100.00", "500.00")
    );
    const next = applyHistoricalForwardReplayMovement(
      start,
      movement({
        movementId: "canonical:pos-reverse",
        occurredAt: "2026-09-01T10:00:00.000Z",
        quantityDelta: "2",
        unitCost: "80.00",
        sourceType: "pos-sale",
        evidence: "canonical",
      })
    );

    expect(next.inventory.quantity.toFixed(3)).toBe("7.000");
    expect(next.inventory.totalValue.toFixed(2)).toBe("700.00");
    expect(next.inventory.averageRate.toFixed(2)).toBe("100.00");
  });

  it("does not replace a previously reversible POS receipt inverse with a locally ambiguous branch", () => {
    const start = createHistoricalInventoryStateFromSnapshot("5", "100.00", "500.00");
    const posReversal = movement({
      movementId: "canonical:pos-reverse-inverse",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "2",
      unitCost: "80.00",
      sourceType: "pos-sale",
      evidence: "canonical",
    });
    const after = applyHistoricalForwardReplayMovement(
      createHistoricalForwardReplayState(start),
      posReversal
    ).inventory;

    const reversed = reverseHistoricalSalesRepairMovement(after, posReversal);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;

    // The one-step inverse has two plausible histories. V20 keeps the prior
    // V18 branch here; an unpriced POS-reversal branch must only replace it
    // after a complete checkpoint proof, never from local reversibility alone.
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("5.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("540.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("108.00");
  });

  it("recovers a canonical POS issue when quantity and value invert exactly but the reconstructed rate is stale", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("9", "100.00", "990.00");
    const saleIssue = movement({
      movementId: "canonical:rate-only-pos-issue",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "-1",
      unitCost: "100.00",
      sourceType: "pos-sale",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, saleIssue);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("10.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("1090.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
  });

  it("recovers a canonical priced receipt when only the reconstructed post-rate disagrees", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("10", "100.00", "1100.00");
    const transferIn = movement({
      movementId: "canonical:rate-only-transfer-in",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "2",
      unitCost: "150.00",
      sourceType: "stock-transfer",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, transferIn);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("8.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("800.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
  });

  it("recovers a canonical exact-value offload when only the reconstructed post-rate disagrees", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("10", "100.00", "1100.00");
    const offload = movement({
      movementId: "canonical:rate-only-offload",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "2",
      unitCost: "150.00",
      exactValue: "300.00",
      sourceType: "container-offload",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, offload);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("8.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("800.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
  });

  it("keeps the same rate-only shortcut disabled for legacy evidence", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("10", "100.00", "1100.00");
    const legacyTransferIn = movement({
      movementId: "legacy:rate-only-transfer-in",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "2",
      unitCost: "150.00",
      sourceType: "legacy-stock-transfer-in",
      evidence: "legacy",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, legacyTransferIn);
    expect(reversed.reversible).toBe(false);
  });

});
