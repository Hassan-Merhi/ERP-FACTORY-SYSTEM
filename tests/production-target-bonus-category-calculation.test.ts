import { describe, expect, it } from "vitest";
import {
  calculateCategoryBonusDay,
  type CategoryEvidenceForCalculation,
} from "../shared/productionTargetBonusCategoryCalculation";
import type { ProductionBonusCategoryRateVersion } from "../shared/productionTargetBonusCategoryRates";

function fixture(): CategoryEvidenceForCalculation {
  return {
    productionDate: "2026-10-30", finalized: true, captured: true,
    readyForTargetAllocation: true, issues: [],
    workers: [{
      workerId: 51, workerName: "Worker A", status: "Present",
      dailyTargetBales: 10, savedProducedBales: 14, creditedBales: 14,
      issues: [], categories: [
        { categoryKey: "bags", categoryLabel: "Bags",
          creditedBales: 6, sourceBales: 6, firstFinalizedAt: null, lastFinalizedAt: null },
        { categoryKey: "toys", categoryLabel: "Toys",
          creditedBales: 4, sourceBales: 4, firstFinalizedAt: null, lastFinalizedAt: null },
        { categoryKey: "shoes", categoryLabel: "Shoes",
          creditedBales: 4, sourceBales: 4, firstFinalizedAt: null, lastFinalizedAt: null },
      ],
    }],
    allocations: [
      { workerId: 51, categoryKey: "bags", categoryLabel: "Bags", creditedBales: 6, targetBales: 4 },
      { workerId: 51, categoryKey: "toys", categoryLabel: "Toys", creditedBales: 4, targetBales: 3 },
      { workerId: 51, categoryKey: "shoes", categoryLabel: "Shoes", creditedBales: 4, targetBales: 3 },
    ],
  };
}
const rates: ProductionBonusCategoryRateVersion[] = [
  { id: 1, categoryKey: "bags", categoryLabel: "Bags", enabled: true,
    effectiveFrom: "2026-10-01", ratePerExtraBale: "0.5000" },
  { id: 2, categoryKey: "toys", categoryLabel: "Toys", enabled: true,
    effectiveFrom: "2026-10-01", ratePerExtraBale: "1.0000" },
  { id: 3, categoryKey: "shoes", categoryLabel: "Shoes", enabled: true,
    effectiveFrom: "2026-10-01", ratePerExtraBale: "2.0000" },
];

describe("Phase 10 category-weighted worker/day proposed bonuses", () => {
  it("uses the actual category for every extra bale across intra-day switches", () => {
    const result = calculateCategoryBonusDay(fixture(), rates);
    expect(result.calculationVersion).toBe("production-target-category-v1");
    expect(result.proposalOnly).toBe(true);
    expect(result.canApprove).toBe(false);
    expect(result.canPost).toBe(false);
    expect(result.blockedWorkerCount).toBe(0);
    expect(result.totalProposedBonusUsd).toBe("4.00");
    const worker = result.workers[0];
    expect(worker.extraBales).toBe("4.00");
    expect(worker.proposedBonusUsd).toBe("4.00");
    expect(worker.lines.map(line => [line.categoryKey, line.extraBales, line.ratePerExtraBaleUsd, line.unroundedBonusUsd]))
      .toEqual([
        ["bags", "2.00", "0.5000", "1.000000"],
        ["toys", "1.00", "1.0000", "1.000000"],
        ["shoes", "1.00", "2.0000", "2.000000"],
      ]);
  });

  it("resolves historical effective dates rather than tomorrow's different rate", () => {
    const newer = { ...rates[0], id: 9, effectiveFrom: "2026-11-01", ratePerExtraBale: "9.0000" };
    const sameDay = { ...rates[0], id: 8, effectiveFrom: "2026-10-30", ratePerExtraBale: "0.2500" };
    const result = calculateCategoryBonusDay(fixture(), [...rates, newer, sameDay]);
    expect(result.workers[0].lines[0].rateVersionId).toBe(8);
    expect(result.totalProposedBonusUsd).toBe("3.50");
  });

  it("does not silently use the old worker-day rate if a needed category rate is missing", () => {
    const result = calculateCategoryBonusDay(fixture(), rates.filter(rate => rate.categoryKey !== "toys"));
    expect(result.totalProposedBonusUsd).toBe("0.00");
    expect(result.workers[0].reasons).toContain("MISSING_CATEGORY_RATE");
    expect(result.workers[0].lines[1].issue).toBe("NO_RATE");
  });

  it("honors an explicit disabled category rate without inheriting a different category", () => {
    const disabled = { ...rates[1], enabled: false, ratePerExtraBale: "20.0000", id: 100 };
    const result = calculateCategoryBonusDay(fixture(), [rates[0], disabled, rates[2]]);
    expect(result.workers[0].blocked).toBe(false);
    expect(result.workers[0].lines[1].issue).toBe("RATE_DISABLED");
    expect(result.workers[0].lines[1].unroundedBonusUsd).toBe("0.000000");
    expect(result.totalProposedBonusUsd).toBe("3.00");
  });

  it("rounds only once at the worker/day total, retaining 6dp intermediate precision", () => {
    const target = fixture();
    target.allocations = [
      { workerId: 51, categoryKey: "bags", categoryLabel: "Bags", creditedBales: 6, targetBales: 5 },
      { workerId: 51, categoryKey: "toys", categoryLabel: "Toys", creditedBales: 4, targetBales: 3 },
      { workerId: 51, categoryKey: "shoes", categoryLabel: "Shoes", creditedBales: 4, targetBales: 2 },
    ];
    const microRates = rates.map(rate => ({ ...rate, ratePerExtraBale: "0.0033" }));
    const result = calculateCategoryBonusDay(target, microRates);
    expect(result.workers[0].lines.map(line => line.unroundedBonusUsd))
      .toEqual(["0.003300", "0.003300", "0.006600"]);
    expect(result.totalProposedBonusUsd).toBe("0.01");
  });

  it("does not create a second bonus after any pre-existing worker/day review", () => {
    const result = calculateCategoryBonusDay(fixture(), rates, new Map([[51, "approved"]]));
    expect(result.totalProposedBonusUsd).toBe("0.00");
    expect(result.workers[0].legacyReviewStatus).toBe("approved");
    expect(result.workers[0].reasons).toContain("EXISTING_BONUS_REVIEW");
  });

  it("fails closed on missing target allocation and mismatched physical credits", () => {
    const missing = fixture();
    missing.allocations = [];
    expect(calculateCategoryBonusDay(missing, rates).workers[0].reasons)
      .toContain("MISSING_CATEGORY_ALLOCATION");
    const mismatch = fixture();
    mismatch.allocations[0].creditedBales = 12;
    expect(calculateCategoryBonusDay(mismatch, rates).workers[0].reasons)
      .toContain("CREDIT_MISMATCH");
  });

  it("fails closed on unknown source, absence, zero target and unfinished day", () => {
    const unfinished = fixture();
    unfinished.finalized = false;
    unfinished.captured = false;
    unfinished.readyForTargetAllocation = false;
    unfinished.workers[0].status = "Absent";
    unfinished.workers[0].dailyTargetBales = 0;
    const result = calculateCategoryBonusDay(unfinished, rates);
    expect(result.workers[0].proposedBonusUsd).toBe("0.00");
    expect(result.workers[0].reasons).toEqual(expect.arrayContaining([
      "DAY_NOT_FINALIZED", "UNVERIFIED_CATEGORY_EVIDENCE", "INVALID_DAILY_TARGET",
      "WORKER_ABSENT", "ALLOCATION_MISMATCH",
    ]));
  });

  it("does not block an observed category without excess merely for an absent rate", () => {
    const day=fixture();
    day.allocations=[
      {workerId:51,categoryKey:"bags",categoryLabel:"Bags",creditedBales:6,targetBales:4},
      {workerId:51,categoryKey:"toys",categoryLabel:"Toys",creditedBales:4,targetBales:4},
      {workerId:51,categoryKey:"shoes",categoryLabel:"Shoes",creditedBales:4,targetBales:2},
    ];
    const result=calculateCategoryBonusDay(day,rates.filter(r=>r.categoryKey!=="toys"));
    expect(result.workers[0].blocked).toBe(false);
    expect(result.workers[0].lines[1].extraBales).toBe("0.00");
    expect(result.totalProposedBonusUsd).toBe("5.00");
  });
});
