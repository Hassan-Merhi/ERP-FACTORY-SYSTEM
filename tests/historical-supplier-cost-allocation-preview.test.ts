import { describe, expect, it } from "vitest";
import { previewHistoricalCostAllocation, type CostTraceInput } from "../scripts/historical-supplier-cost-allocation-preview";

const goods: CostTraceInput = {
  kind: "goods",
  sourceMixCount: 4,
  sourceMixWeightKg: "17980",
  sourceMixCostUsd: "10974.16",
  rawRemainingKg: "0",
  rawRemainingValueUsd: "0",
  rawOverusedKg: "0",
  rawUnvaluedRows: 0,
};
const missingLineage = {
  factoryBaleCount: 45514,
  directlyMixLinkedBales: 0,
  pressingBatchLinkedBales: 0,
  inventoryCutoverApplied: false,
};

describe("Historical supplier per-container allocation preview: never posts", () => {
  it("separately reports source mixes and blocks sold-goods allocation without bale provenance", () => {
    const result = previewHistoricalCostAllocation(goods, missingLineage);
    expect(result.sourceMixCount).toBe(4);
    expect(result.blockers).toContain("NO_MIX_TO_FINISHED_OR_SOLD_BALE_LINEAGE");
    expect(result.blockers).toContain("NO_APPLIED_INVENTORY_GL_CUTOVER");
    expect(result.soldCostUsd).toBeNull();
    expect(result.finishedGoodsCostUsd).toBeNull();
    expect(result.workInProgressCostUsd).toBeNull();
    expect(result.verifiedOverstatedExpenseUsd).toBeNull();
    expect(result.proposedGLCorrection).toBeNull();
    expect(result.proposedSupplierAdjustment).toBeNull();
  });
  it("shows current raw value as evidence, not an approved GL debit", () => {
    const result = previewHistoricalCostAllocation({
      ...goods, sourceMixCount: 0,
      rawRemainingKg: "20740",
      rawRemainingValueUsd: "20219.78",
    }, missingLineage);
    expect(result.currentOperationalRawValueUsd).toBe("20219.78");
    expect(result.blockers).toContain("NO_SOURCE_TO_MIX_LINK");
    expect(result.verifiedOverstatedExpenseUsd).toBeNull();
  });
  it("refuses to infer commission capitalization, even with no physical stock", () => {
    const result = previewHistoricalCostAllocation({ ...goods, kind:"commission" }, missingLineage);
    expect(result.blockers).toContain("COMMISSION_LANDED_COST_AND_EXPENSE_TREATMENT_UNPROVEN");
    expect(result.proposedGLCorrection).toBeNull();
  });
  it("flags source overusage and missing raw cost without fabricating inventory valuation", () => {
    const result = previewHistoricalCostAllocation({
      ...goods,
      rawOverusedKg: "3516",
      rawRemainingKg: "0",
      rawRemainingValueUsd: null,
      rawUnvaluedRows: 1,
    }, missingLineage);
    expect(result.blockers).toContain("NEGATIVE_SOURCE_STOCK_USAGE");
    expect(result.blockers).toContain("UNVALUED_REMAINING_RAW_MATERIAL");
    expect(result.currentOperationalRawValueUsd).toBeNull();
  });
  it("still requires proof of historical GL recognition even with complete links", () => {
    const result = previewHistoricalCostAllocation(goods, {
      ...missingLineage, directlyMixLinkedBales: 100, inventoryCutoverApplied: true,
    });
    expect(result.blockers).toContain("HISTORICAL_GL_RECOGNITION_AND_COST_PERIOD_UNPROVEN");
    expect(result.verifiedOverstatedExpenseUsd).toBeNull();
  });
});
