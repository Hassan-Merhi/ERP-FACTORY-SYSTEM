export type InventoryValuationRepairClassification =
  | "HIGH_CONFIDENCE_DRY_RUN"
  | "MANUAL_MISSING_BASELINE"
  | "MANUAL_BASELINE_QTY_NONPOSITIVE"
  | "MANUAL_NO_POST_EDIT_SALE"
  | "MANUAL_INTERVENING_TRUE_RECEIPT"
  | "MANUAL_LATER_TRUE_RECEIPT"
  | "MANUAL_NONZERO_ADJUSTMENT_EDIT_NET"
  | "MANUAL_ADJUSTMENT_RATE_CHANGED"
  | "NO_ASSET_REPAIR"
  | "NO_HIGH_CONFIDENCE_DRIFT";

export interface InventoryValuationRepairEvidence {
  companyId: number;
  locationId: number;
  stockItemId: number;
  code: string;
  name: string;
  currentQuantity: number;
  currentRate: number;
  currentValue: number;
  firstEditAt: string;
  baselineAt: string | null;
  baselineRate: number | null;
  firstPostSaleAt: string | null;
  firstPostSaleRate: number | null;
  interveningTrueReceipts: number;
  laterTrueReceipts: number;
  netDeltaSinceEdit: number;
  adjustmentEditNetQuantity: number;
  maxAdjustmentApplyRateDelta: number;
  lastUpdated: string | null;
}

export interface InventoryValuationRepairPlan
  extends InventoryValuationRepairEvidence {
  classification: InventoryValuationRepairClassification;
  baselineQuantityEstimate: number;
  expectedRate: number | null;
  expectedValueEstimate: number | null;
  repairValueDeltaEstimate: number | null;
  dryRunEligible: boolean;
}

const QUANTITY_TOLERANCE = 0.0005;
const RATE_TOLERANCE = 0.05;

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Classify a production valuation anomaly without mutating inventory.
 *
 * A high-confidence candidate is intentionally narrow: the item must have had
 * positive stock before the first POS edit, a stable pre-edit sale cost, a
 * measurable post-edit collapse, no real receipt around/after the edit, and no
 * stock-adjustment edit that introduced a different cost basis.
 *
 * The expected value remains an estimate because average_rate is rounded. Wave
 * 6 must re-check the snapshot and exact historical evidence before any write.
 */
export function buildInventoryValuationRepairPlan(
  evidence: InventoryValuationRepairEvidence
): InventoryValuationRepairPlan {
  const baselineQuantityEstimate =
    evidence.currentQuantity - evidence.netDeltaSinceEdit;
  const expectedRate =
    evidence.baselineRate && evidence.baselineRate > 0
      ? evidence.baselineRate
      : null;
  const expectedValueEstimate =
    expectedRate !== null && evidence.currentQuantity > 0
      ? roundMoney(evidence.currentQuantity * expectedRate)
      : null;
  const repairValueDeltaEstimate =
    expectedValueEstimate === null
      ? null
      : roundMoney(expectedValueEstimate - evidence.currentValue);

  let classification: InventoryValuationRepairClassification;

  if (evidence.currentQuantity <= QUANTITY_TOLERANCE) {
    classification = "NO_ASSET_REPAIR";
  } else if (expectedRate === null) {
    classification = "MANUAL_MISSING_BASELINE";
  } else if (baselineQuantityEstimate <= QUANTITY_TOLERANCE) {
    classification = "MANUAL_BASELINE_QTY_NONPOSITIVE";
  } else if (evidence.firstPostSaleRate === null) {
    classification = "MANUAL_NO_POST_EDIT_SALE";
  } else if (evidence.interveningTrueReceipts > 0) {
    classification = "MANUAL_INTERVENING_TRUE_RECEIPT";
  } else if (evidence.laterTrueReceipts > 0) {
    classification = "MANUAL_LATER_TRUE_RECEIPT";
  } else if (Math.abs(evidence.adjustmentEditNetQuantity) > QUANTITY_TOLERANCE) {
    classification = "MANUAL_NONZERO_ADJUSTMENT_EDIT_NET";
  } else if (evidence.maxAdjustmentApplyRateDelta > RATE_TOLERANCE) {
    classification = "MANUAL_ADJUSTMENT_RATE_CHANGED";
  } else if (
    Math.abs(evidence.firstPostSaleRate - expectedRate) >= RATE_TOLERANCE &&
    Math.abs(evidence.currentRate - expectedRate) >= RATE_TOLERANCE
  ) {
    classification = "HIGH_CONFIDENCE_DRY_RUN";
  } else {
    classification = "NO_HIGH_CONFIDENCE_DRIFT";
  }

  return {
    ...evidence,
    classification,
    baselineQuantityEstimate,
    expectedRate,
    expectedValueEstimate,
    repairValueDeltaEstimate,
    dryRunEligible: classification === "HIGH_CONFIDENCE_DRY_RUN",
  };
}
