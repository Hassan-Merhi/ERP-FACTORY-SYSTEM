import { describe, expect, it } from "vitest";
import { GOLDEN_COAST_CUTOVER_FIFO_SOURCE, buildGoldenCoastCutoverFifoPlan } from "./goldenCoastCutoverFifo";

const rows = [
  {
    inventoryId: 11,
    locationId: 2,
    stockItemId: 101,
    articleCode: "GC-A",
    description: "Grade A",
    quantity: "10",
    averageRate: "20",
  },
  {
    inventoryId: 12,
    locationId: 3,
    stockItemId: 102,
    articleCode: "GC-B",
    quantity: "5",
    averageRate: "30",
  },
];

describe("Golden Coast Phase 4 cutover FIFO planner", () => {
  it("creates company/location-scoped FIFO lots without changing accounting", () => {
    const plan = buildGoldenCoastCutoverFifoPlan({
      companyId: 7,
      stockInHandOpeningUsd: "350",
      inventory: rows,
    });
    expect(plan.totalValueUsd).toBe("350.00");
    expect(plan.rowCount).toBe(2);
    expect(plan.movements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          companyId: 7,
          sourceType: GOLDEN_COAST_CUTOVER_FIFO_SOURCE,
          stockItemId: 101,
          locationId: 2,
          qtyIn: "10.0000",
          qtyRemaining: "10.0000",
          finalUnitCostUsd: "20.000000",
        }),
      ])
    );
  });

  it("ignores zero-quantity rows", () => {
    const plan = buildGoldenCoastCutoverFifoPlan({
      companyId: 7,
      stockInHandOpeningUsd: "0",
      inventory: [{ ...rows[0], quantity: "0", averageRate: "0" }],
    });
    expect(plan.movements).toEqual([]);
  });

  it("fails closed when ERP inventory value does not match Phase 3 Stock in Hand", () => {
    expect(() =>
      buildGoldenCoastCutoverFifoPlan({
        companyId: 7,
        stockInHandOpeningUsd: "349.99",
        inventory: rows,
      })
    ).toThrow(/does not reconcile/);
  });

  it("rejects positive stock with zero cost", () => {
    expect(() =>
      buildGoldenCoastCutoverFifoPlan({
        companyId: 7,
        stockInHandOpeningUsd: "0",
        inventory: [{ ...rows[0], averageRate: "0" }],
      })
    ).toThrow(/zero average rate/);
  });

  it("rejects duplicate item/location snapshots", () => {
    expect(() =>
      buildGoldenCoastCutoverFifoPlan({
        companyId: 7,
        stockInHandOpeningUsd: "400",
        inventory: [rows[0], { ...rows[0], inventoryId: 99 }],
      })
    ).toThrow(/duplicate stock item\/location/);
  });
});
