import { describe, expect, it } from "vitest";
import { buildMixBatchCategoryReport, selectMixBatchTarget, mixBatchCategoryTargetKg } from "../client/src/pages/factory/production-raw-stock/mixBatchCategoryTargets";

describe("mix batch production targets", () => {
  it("rounds up according to requested intervals", () => {
    expect(selectMixBatchTarget(15000)).toBe(15);
    expect(selectMixBatchTarget(16000)).toBe(17.5);
    expect(selectMixBatchTarget(17500)).toBe(17.5);
    expect(selectMixBatchTarget(18100)).toBe(20);
    expect(selectMixBatchTarget(18543)).toBe(20);
    expect(selectMixBatchTarget(24000)).toBe(20);
  });
});

describe("mix batch category report", () => {
  const categories = [{ id: 1, name: "Cyprus" }, { id: 2, name: "Australia" }, { id: 3, name: "UK" }];
  const suppliers = [{ id: 101, supplierCategoryId: 1 }, { id: 102, supplierCategoryId: 1 }, { id: 103, supplierCategoryId: 2 }];
  const plan = { "cat:1": 10000, "cat:2": 4000, "cat:3": 6000, "101": 100, "102": 200 };
  it("groups sources and computes weighted $/kg and differences", () => {
    const rows = buildMixBatchCategoryReport([
      { id: 1, sourceName: "Cyprus first", categoryId: 1, weightKg: 9000, totalCost: 4500 },
      { id: 2, sourceName: "Cyprus second", categoryId: 1, weightKg: 500, totalCost: 300 },
      { id: 3, sourceName: "Australia", categoryId: 2, weightKg: 3500, totalCost: 3500 },
    ], categories, plan, suppliers, 20);
    expect(rows.map(r => r.name)).toEqual(["Australia", "Cyprus", "UK"]);
    expect(rows.find(r => r.name === "Cyprus")).toMatchObject({
      weightKg: 9500, totalCost: 4800, averageCostPerKg: 4800/9500, targetKg: 10000, differenceKg: -500,
    });
    expect(rows.find(r => r.name === "UK")).toMatchObject({ weightKg: 0, targetKg: 6000, differenceKg: -6000 });
  });
  it("scales planned 20t category weight for 17.5 and 15 tonne targets", () => {
    expect(mixBatchCategoryTargetKg(1, 17.5, plan, suppliers)).toBe(8750);
    expect(mixBatchCategoryTargetKg(1, 15, plan, suppliers)).toBe(7500);
  });
  it("uses legacy supplier allocations only until category value is saved", () => {
    expect(mixBatchCategoryTargetKg(1, 20, { "101": 100, "102": 200 }, suppliers)).toBe(300);
    expect(mixBatchCategoryTargetKg(1, 20, { "101": 100, "102": 200, "cat:1": 0 }, suppliers)).toBe(0);
  });
  it("credits uncategorized supplier sources to their saved pool and keeps batch sources unmapped", () => {
    const categorylessSuppliers = [{ id: 104, supplierCategoryId: null }];
    const rows = buildMixBatchCategoryReport([
      { id: 1, sourceName: "Supplier without category", supplierId: 104, sourceBatchId: null, categoryId: null, weightKg: 9500, totalCost: 4700 },
      { id: 2, sourceName: "Existing batch", supplierId: null, sourceBatchId: 29, categoryId: null, weightKg: 400, totalCost: 200 },
    ], [], { "cat:uncategorized": 10000 }, categorylessSuppliers, 20);
    expect(rows.find(r => r.id === "cat:uncategorized")).toMatchObject({
      weightKg: 9500, totalCost: 4700, targetKg: 10000, differenceKg: -500,
    });
    expect(rows.find(r => r.id === "unmapped")).toMatchObject({
      weightKg: 400, totalCost: 200, targetKg: null, differenceKg: null,
    });
  });

  it("shows uncategorized shortfall even when no materials from that category were used", () => {
    const rows = buildMixBatchCategoryReport([], [], { "cat:uncategorized": 800 }, [], 17.5);
    expect(rows.find(r => r.id === "cat:uncategorized")).toMatchObject({
      weightKg: 0, targetKg: 700, differenceKg: -700,
    });
  });

  it("preserves unmapped batch sources without a fabricated category target", () => {
    const rows = buildMixBatchCategoryReport([
      { id: 10, sourceName: "Existing Batch", categoryId: null, weightKg: 300, totalCost: 150 },
    ], categories, plan, suppliers, 20);
    expect(rows.find(r => r.id === "unmapped")).toMatchObject({
      weightKg: 300, totalCost: 150, targetKg: null, differenceKg: null,
    });
  });
});
