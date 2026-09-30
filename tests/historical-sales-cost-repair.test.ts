import { describe, expect, it } from "vitest";
import {
  applyHistoricalInventoryMovement,
  createHistoricalInventoryState,
  replayHistoricalSalesCosts,
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
});
