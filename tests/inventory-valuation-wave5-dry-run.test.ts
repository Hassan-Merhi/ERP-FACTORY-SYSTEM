import { describe, expect, it } from "vitest";
import {
  buildInventoryValuationRepairPlan,
  type InventoryValuationRepairEvidence,
} from "../server/services/inventory/inventoryValuationRepairPlan";

function evidence(overrides: Partial<InventoryValuationRepairEvidence> = {}): InventoryValuationRepairEvidence {
  return {
    companyId: 8,
    locationId: 122,
    stockItemId: 6374,
    code: "SH.MIX3",
    name: "AJ S MIX SHOES III (55PCS)",
    currentQuantity: 17,
    currentRate: 33.92,
    currentValue: 576.56,
    firstEditAt: "2026-09-07T07:50:35.096Z",
    baselineAt: "2026-09-05T12:31:03.290Z",
    baselineRate: 66.65,
    firstPostSaleAt: "2026-09-07T14:47:09.415Z",
    firstPostSaleRate: 55.54,
    interveningTrueReceipts: 0,
    laterTrueReceipts: 0,
    netDeltaSinceEdit: -8,
    adjustmentEditNetQuantity: 0,
    maxAdjustmentApplyRateDelta: 0,
    lastUpdated: "2026-09-11T12:43:29.447Z",
    ...overrides,
  };
}

describe("inventory valuation Wave 5 dry-run planning", () => {
  it("classifies the SH.MIX3 production shape as the high-confidence dry-run candidate", () => {
    const plan = buildInventoryValuationRepairPlan(evidence());

    expect(plan.classification).toBe("HIGH_CONFIDENCE_DRY_RUN");
    expect(plan.dryRunEligible).toBe(true);
    expect(plan.baselineQuantityEstimate).toBe(25);
    expect(plan.expectedRate).toBe(66.65);
    expect(plan.expectedValueEstimate).toBe(1133.05);
    expect(plan.repairValueDeltaEstimate).toBe(556.49);
  });

  it("requires manual review when a real receipt occurred between the baseline sale and first edit", () => {
    const plan = buildInventoryValuationRepairPlan(evidence({ interveningTrueReceipts: 1 }));

    expect(plan.classification).toBe("MANUAL_INTERVENING_TRUE_RECEIPT");
    expect(plan.dryRunEligible).toBe(false);
  });

  it("requires manual review when a real receipt occurred after the first edit", () => {
    const plan = buildInventoryValuationRepairPlan(evidence({ laterTrueReceipts: 1 }));

    expect(plan.classification).toBe("MANUAL_LATER_TRUE_RECEIPT");
    expect(plan.dryRunEligible).toBe(false);
  });

  it("requires manual review when reconstructed stock before the first edit was not positive", () => {
    const plan = buildInventoryValuationRepairPlan(
      evidence({ currentQuantity: 1, currentValue: 33.92, netDeltaSinceEdit: 2 })
    );

    expect(plan.classification).toBe("MANUAL_BASELINE_QTY_NONPOSITIVE");
    expect(plan.dryRunEligible).toBe(false);
  });

  it("requires manual review when a later adjustment edit introduced a different rate", () => {
    const plan = buildInventoryValuationRepairPlan(evidence({ maxAdjustmentApplyRateDelta: 4.11 }));

    expect(plan.classification).toBe("MANUAL_ADJUSTMENT_RATE_CHANGED");
    expect(plan.dryRunEligible).toBe(false);
  });

  it("does not flag an item whose post-edit and current rate stayed on the baseline", () => {
    const plan = buildInventoryValuationRepairPlan(
      evidence({ currentRate: 66.65, currentValue: 1133.05, firstPostSaleRate: 66.65 })
    );

    expect(plan.classification).toBe("NO_HIGH_CONFIDENCE_DRIFT");
    expect(plan.dryRunEligible).toBe(false);
  });

  it("does not plan an asset-value repair when current on-hand quantity is zero", () => {
    const plan = buildInventoryValuationRepairPlan(
      evidence({ currentQuantity: 0, currentRate: 66.65, currentValue: 0, netDeltaSinceEdit: -25 })
    );

    expect(plan.classification).toBe("NO_ASSET_REPAIR");
    expect(plan.expectedValueEstimate).toBeNull();
    expect(plan.dryRunEligible).toBe(false);
  });
});
