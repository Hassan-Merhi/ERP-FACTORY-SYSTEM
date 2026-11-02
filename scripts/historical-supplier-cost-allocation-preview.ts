/**
 * Backend-only preview: current factory operational costs cannot be treated
 * as historically recognized GL inventory without an inventory cutover and
 * complete source-to-sale lineage. This helper has NO posting capabilities.
 */
export type HistoricalCostKind = "goods" | "commission";
export interface CostTraceInput {
  kind: HistoricalCostKind;
  sourceMixCount: number;
  sourceMixWeightKg: string;
  sourceMixCostUsd: string;
  rawRemainingKg: string;
  rawRemainingValueUsd: string | null;
  rawOverusedKg: string;
  rawUnvaluedRows: number;
}
export interface LineageCoverage {
  factoryBaleCount: number;
  directlyMixLinkedBales: number;
  pressingBatchLinkedBales: number;
  inventoryCutoverApplied: boolean;
}
export function previewHistoricalCostAllocation(
  input: CostTraceInput,
  coverage: LineageCoverage
) {
  const blockers: string[] = [];
  if (!coverage.inventoryCutoverApplied) blockers.push("NO_APPLIED_INVENTORY_GL_CUTOVER");
  if (input.kind === "commission") blockers.push("COMMISSION_LANDED_COST_AND_EXPENSE_TREATMENT_UNPROVEN");
  else {
    if (input.sourceMixCount === 0) blockers.push("NO_SOURCE_TO_MIX_LINK");
    if (input.sourceMixCount > 0 &&
        coverage.directlyMixLinkedBales + coverage.pressingBatchLinkedBales === 0) {
      blockers.push("NO_MIX_TO_FINISHED_OR_SOLD_BALE_LINEAGE");
    }
    if (input.rawRemainingValueUsd === null || input.rawUnvaluedRows > 0) {
      blockers.push("UNVALUED_REMAINING_RAW_MATERIAL");
    }
    if (Number(input.rawOverusedKg) > 0) blockers.push("NEGATIVE_SOURCE_STOCK_USAGE");
  }
  blockers.push("HISTORICAL_GL_RECOGNITION_AND_COST_PERIOD_UNPROVEN");
  return {
    status: "REVIEW_REQUIRED_NO_POSTING" as const,
    sourceMixCount: input.sourceMixCount,
    attributedMixSourceKg: input.sourceMixWeightKg,
    attributedMixSourceCostUsd: input.sourceMixCostUsd,
    currentOperationalRawRemainingKg: input.rawRemainingKg,
    currentOperationalRawValueUsd: input.rawRemainingValueUsd,
    rawOverusedKg: input.rawOverusedKg,
    soldCostUsd: null,
    finishedGoodsCostUsd: null,
    workInProgressCostUsd: null,
    verifiedOverstatedExpenseUsd: null,
    proposedGLCorrection: null,
    proposedSupplierAdjustment: null,
    blockers,
  };
}
