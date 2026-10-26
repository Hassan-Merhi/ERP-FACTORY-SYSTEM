import { describe, expect, it } from "vitest";
import { compileRows, groupRows, groupDailySupplierCosts, type MixBatchCostSourceRow } from "../client/src/pages/factory/production-raw-stock/mixBatchCostExport";
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
  const source = (id: number, mixBatchId: number, supplierId: number, supplierName: string,
    kg: number, cost: number): MixBatchCostSourceRow => ({
    id, mixBatchId, supplierId, supplierName, categoryName: "Raw Materials",
    containerNumber: `CONT-${id}`, sourceBatchId: null,
    weightKg: String(kg), totalCost: String(cost), costPerKg: String(kg ? cost / kg : 0),
  });

  it("breaks down each day by supplier with KG-weighted rates and distinct batch counts", () => {
    const batches = [batch(1, "2026-10-23", 2000, 1300), batch(2, "2026-10-23", 3000, 2100)];
    const sources = [
      source(1, 1, 11, "Supplier A", 1000, 500),
      source(2, 1, 11, "Supplier A", 500, 300),
      source(3, 1, 12, "Supplier B", 500, 500),
      source(4, 2, 11, "Supplier A", 2000, 1600),
      source(5, 2, 12, "Supplier B", 1000, 500),
    ];
    const rows = groupDailySupplierCosts(batches, sources);
    expect(rows).toHaveLength(2);
    const a = rows.find(row => row.supplierName === "Supplier A")!;
    expect(a).toMatchObject({ date: "2026-10-23", batches: 2, kg: 3500, cost: 2400 });
    expect(a.cost / a.kg).toBeCloseTo(2400 / 3500);
    expect(rows.find(row => row.supplierName === "Supplier B")).toMatchObject({ kg: 1500, cost: 1000 });
    expect(rows.some(row => row.review === "REVIEW SOURCE VS BATCH")).toBe(false);
  });

  it("does not include carry-forward batches and flags incomplete supplier records", () => {
    const rows = groupDailySupplierCosts(
      [batch(1, "2026-10-22", 1000, 700), batch(2, "2026-10-22", 1000, 700, 1)],
      [source(1, 1, 10, "Supplier A", 800, 560), source(2, 2, 10, "Supplier A", 1000, 700)],
    );
    expect(rows.find(row => row.supplierName === "Supplier A")).toMatchObject({ kg: 800, cost: 560 });
    expect(rows.find(row => row.review === "REVIEW SOURCE VS BATCH"))
      .toMatchObject({ kg: 200, cost: 140 });
  });

  it("keeps supplier costs distinct by day and supplier ID", () => {
    const rows = groupDailySupplierCosts(
      [batch(1, "2026-10-21", 100, 60), batch(2, "2026-10-22", 100, 80)],
      [source(1, 1, 10, "Supplier A", 100, 60), source(2, 2, 10, "Supplier A", 100, 80)],
    );
    expect(rows.map(row => row.date)).toEqual(["2026-10-22", "2026-10-21"]);
    expect(rows.map(row => row.cost / row.kg)).toEqual([0.8, 0.6]);
  });

});
