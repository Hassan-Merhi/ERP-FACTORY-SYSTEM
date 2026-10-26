import { describe, expect, it } from "vitest";
import { compileRows, groupRows } from "../client/src/pages/factory/production-raw-stock/mixBatchCostExport";
import type { MixBatchRow } from "../client/src/pages/factory/production-raw-stock/MixBatchList";

function batch(
  id: number,
  date: string,
  kg: number,
  cost: number,
  carryForwardFromId: number | null = null,
): MixBatchRow {
  return {
    id,
    batchCode: `FMB-${id}`,
    name: "Example blend",
    batchDate: date,
    createdAt: `${date}T09:00:00.000Z`,
    totalWeightKg: String(kg),
    usedKg: "0",
    remainingKg: String(kg),
    totalCost: String(cost),
    costPerKg: String(kg ? cost / kg : 0),
    status: "ACTIVE",
    operatorUser: null,
    carryForwardFromId,
  };
}

describe("Raw Materials Excel historical cost aggregation", () => {
  it("produces KG-weighted daily and monthly cost, not a simple mean of rates", () => {
    const rows = compileRows([
      batch(1, "2026-10-23", 1000, 600),
      batch(2, "2026-10-23", 3000, 2400),
      batch(3, "2026-10-22", 2000, 1200),
      batch(4, "2026-10-23", 4000, 4000, 1), // carry-forward: never double count
    ]);
    expect(rows).toHaveLength(3);

    const days = groupRows(rows, "date");
    const today = days.find(day => day.key === "2026-10-23");
    expect(today).toMatchObject({ count: 2, kg: 4000, cost: 3000 });
    expect(today!.cost / today!.kg).toBeCloseTo(0.75, 10);

    const month = groupRows(rows, "month").find(m => m.key === "2026-10");
    expect(month).toMatchObject({ count: 3, kg: 6000, cost: 4200 });
    expect(month!.cost / month!.kg).toBeCloseTo(0.7, 10);
  });

  it("retains source zero-cost / zero-weight records and flags them for review", () => {
    const rows = compileRows([batch(5, "2026-10-21", 500, 0), batch(6, "2026-10-21", 0, 10)]);
    expect(rows.map(row => row.flag)).toEqual(["CHECK COST", "CHECK WEIGHT"].reverse());
    const day = groupRows(rows, "date")[0];
    expect(day).toMatchObject({ count: 2, kg: 500, cost: 10, zeroCost: 2 });
  });

  it("groups valid ISO dates without using the export day as the batch day", () => {
    const source = batch(7, "2026-09-30", 110, 77);
    const rows = compileRows([source]);
    expect(rows[0].date).toBe("2026-09-30");
    expect(rows[0].month).toBe("2026-09");
  });
});
