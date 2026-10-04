import { describe, expect, it } from "vitest";
import {
  canonicalPosRoleFromIdempotencyKey,
  historicalRateWithinEvidencedRange,
  historicalStateRateMatchesValue,
  applyHistoricalForwardReplayMovement,
  applyHistoricalSalesRepairMovement,
  createHistoricalForwardReplayState,
  createHistoricalInventoryStateFromSnapshot,
} from "../server/services/inventory/historicalSalesCostRepairEngine";

import {
  reverseHistoricalInventoryMovement,
  reverseHistoricalSalesRepairMovement,
} from "../server/services/inventory/historicalSalesCostRepairEngineReverse";
import { movement } from "./helpers/historicalSalesCostRepairMovement";

describe("historical sales cost repair recorded evidence", () => {
  it("replays and rewinds the exact guarded Wave 6 valuation reset only on a matching state", () => {
    const reset = movement({
      movementId: "valuation-reset:wave6-sh-mix3",
      occurredAt: "2026-09-11T19:58:31.453Z",
      createdAt: "2026-09-11T19:58:31.453Z",
      quantityDelta: "0.000",
      unitCost: null,
      sourceType: "inventory-valuation-wave6-reset",
      evidence: "legacy",
      valuationReset: {
        beforeQuantity: "17.000",
        beforeAverageRate: "33.92",
        beforeTotalValue: "576.56",
        afterQuantity: "17.000",
        afterAverageRate: "66.65",
        afterTotalValue: "1133.05",
      },
    });

    const before = createHistoricalInventoryStateFromSnapshot("17", "33.92", "576.56");
    const after = applyHistoricalSalesRepairMovement(before, reset);
    expect(after.quantity.toFixed(3)).toBe("17.000");
    expect(after.averageRate.toFixed(2)).toBe("66.65");
    expect(after.totalValue.toFixed(2)).toBe("1133.05");

    const reversed = reverseHistoricalSalesRepairMovement(after, reset);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("17.000");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("33.92");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("576.56");

    const wrong = createHistoricalInventoryStateFromSnapshot("17", "66.65", "1133.04");
    const rejected = reverseHistoricalSalesRepairMovement(wrong, reset);
    expect(rejected).toEqual({
      reversible: false,
      reason: "MOVEMENT_INVERSE_INVALID",
    });
  });

  it("derives canonical POS roles from immutable idempotency keys", () => {
    expect(canonicalPosRoleFromIdempotencyKey("pos-sale", "pos-sale:13532:rev0:510")).toBe("sale-issue");
    expect(canonicalPosRoleFromIdempotencyKey("pos-sale", "pos-sale:14743:rev46:issue:6421:line:1")).toBe("edit-issue");
    expect(canonicalPosRoleFromIdempotencyKey("pos-sale", "pos-sale:13559:rev57:issue:6310")).toBe("edit-issue");
    expect(canonicalPosRoleFromIdempotencyKey("pos-sale", "pos-sale:14989:rev31:reverse:52:line:108419")).toBe(
      "edit-reversal"
    );
    expect(canonicalPosRoleFromIdempotencyKey("pos-sale", "pos-sale:13471:rev54:reverse:1521")).toBe("edit-reversal");
    expect(canonicalPosRoleFromIdempotencyKey("stock-transfer", "pos-sale:1:rev1:reverse:2")).toBe(undefined);
  });

  it("accepts half-up and float-tie stored rates but rejects any other rate/value pair", () => {
    // 251.66 / 4 = 62.915 exactly: Decimal writers store 62.92, historical float
    // writers stored 62.91 (present in the immutable Phase 3 checkpoint).
    expect(historicalStateRateMatchesValue(createHistoricalInventoryStateFromSnapshot("4", "62.92", "251.66"))).toBe(
      true
    );
    expect(historicalStateRateMatchesValue(createHistoricalInventoryStateFromSnapshot("4", "62.91", "251.66"))).toBe(
      true
    );
    expect(historicalStateRateMatchesValue(createHistoricalInventoryStateFromSnapshot("4", "62.90", "251.66"))).toBe(
      false
    );
    expect(historicalStateRateMatchesValue(createHistoricalInventoryStateFromSnapshot("0", "70.00", "0"))).toBe(true);
  });

  it("inverts a production POS edit pair at the live stored rate instead of the old line cost", () => {
    // Company 1, location 134, item 2329, voucher 13580 (canonical 31380/31470).
    // The checkpoint rewind pins the state after the re-issue exactly.
    const afterReissue = createHistoricalInventoryStateFromSnapshot("8", "105.21", "841.65");
    const reissue = movement({
      movementId: "canonical:31470",
      occurredAt: "2026-09-10T09:45:55.118Z",
      quantityDelta: "-2",
      unitCost: "105.200000",
      sourceType: "pos-sale",
      evidence: "canonical",
      canonicalPosRole: "edit-issue",
    });
    const reversal = movement({
      movementId: "canonical:31380",
      occurredAt: "2026-09-10T09:45:55.118Z",
      quantityDelta: "2",
      unitCost: "105.200000",
      sourceType: "pos-sale",
      evidence: "canonical",
      canonicalPosRole: "edit-reversal",
    });

    const beforeReissue = reverseHistoricalSalesRepairMovement(afterReissue, reissue);
    expect(beforeReissue.reversible).toBe(true);
    if (!beforeReissue.reversible) return;
    expect(beforeReissue.stateBefore.quantity.toFixed(3)).toBe("10.000");
    expect(beforeReissue.stateBefore.averageRate.toFixed(2)).toBe("105.21");
    expect(beforeReissue.stateBefore.totalValue.toFixed(2)).toBe("1052.07");

    const beforeReversal = reverseHistoricalSalesRepairMovement(beforeReissue.stateBefore, reversal);
    expect(beforeReversal.reversible).toBe(true);
    if (!beforeReversal.reversible) return;
    expect(beforeReversal.stateBefore.quantity.toFixed(3)).toBe("8.000");
    expect(beforeReversal.stateBefore.averageRate.toFixed(2)).toBe("105.21");
    expect(beforeReversal.stateBefore.totalValue.toFixed(2)).toBe("841.65");

    // Forward replay of the recovered pre-state reproduces the pinned state.
    const replayed = applyHistoricalSalesRepairMovement(
      applyHistoricalSalesRepairMovement(beforeReversal.stateBefore, reversal),
      reissue
    );
    expect(replayed.quantity.toFixed(3)).toBe("8.000");
    expect(replayed.averageRate.toFixed(2)).toBe("105.21");
    expect(replayed.totalValue.toFixed(2)).toBe("841.65");
  });

  it("does not rewind a recorded document rate into an impossible pre-issue state", () => {
    // A caller-supplied document rate (105.10) that differs from the live
    // average would rewind to 10|105.10|1051.85, a rate/value pair no production
    // writer stores. Inference continues from the exact post-issue value.
    const afterIssue = createHistoricalInventoryStateFromSnapshot("8", "105.21", "841.65");
    const reversed = reverseHistoricalInventoryMovement(afterIssue, {
      quantityDelta: "-2",
      unitCost: "105.10",
    });
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("105.21");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("1052.07");
  });

  it("still uses a consistent recorded sale-issue rate for an original POS sale", () => {
    const after = createHistoricalInventoryStateFromSnapshot("8", "100.00", "800.00");
    const sale = movement({
      movementId: "canonical:sale-issue",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "-2",
      unitCost: "100.00",
      sourceType: "pos-sale",
      evidence: "canonical",
      canonicalPosRole: "sale-issue",
    });
    const reversed = reverseHistoricalSalesRepairMovement(after, sale);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("1000.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
  });

  it("replays an identified POS reversal receipt at the live rate in every replay path", () => {
    const start = createHistoricalInventoryStateFromSnapshot("5", "100.00", "500.00");
    const reversal = movement({
      movementId: "canonical:tagged-reverse",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "2",
      unitCost: "80.00",
      sourceType: "pos-sale",
      evidence: "canonical",
      canonicalPosRole: "edit-reversal",
    });
    const next = applyHistoricalSalesRepairMovement(start, reversal);
    expect(next.totalValue.toFixed(2)).toBe("700.00");
    expect(next.averageRate.toFixed(2)).toBe("100.00");

    const reversed = reverseHistoricalSalesRepairMovement(next, reversal);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("500.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
  });

  it("treats any reconstructed cost outside the evidenced rate range as impossible", () => {
    const range = { low: "95.00", high: "120.00" };
    expect(historicalRateWithinEvidencedRange("107.34", range)).toBe(true);
    expect(historicalRateWithinEvidencedRange("94.99", range)).toBe(true);
    expect(historicalRateWithinEvidencedRange("120.01", range)).toBe(true);
    expect(historicalRateWithinEvidencedRange("94.98", range)).toBe(false);
    // Run #33 marked this item-702 proposal "ready".
    expect(historicalRateWithinEvidencedRange("536372383.50", range)).toBe(false);
    expect(historicalRateWithinEvidencedRange("0.00", range)).toBe(false);
    expect(historicalRateWithinEvidencedRange("107.34", undefined)).toBe(false);
  });

  it("replays and rewinds a recorded valuation override, including a quantity change, only on an exact match", () => {
    const override = movement({
      movementId: "valuation-override:1",
      occurredAt: "2026-10-02T09:00:00.000Z",
      createdAt: "2026-10-02T09:00:00.000Z",
      quantityDelta: "2.000",
      unitCost: null,
      sourceType: "inventory-valuation-override",
      evidence: "legacy",
      valuationReset: {
        beforeQuantity: "4.000",
        beforeAverageRate: "33.15",
        beforeTotalValue: "132.60",
        afterQuantity: "6.000",
        afterAverageRate: "37.07",
        afterTotalValue: "222.42",
      },
    });

    const before = createHistoricalInventoryStateFromSnapshot("4", "33.15", "132.60");
    const after = applyHistoricalSalesRepairMovement(before, override);
    expect(after.quantity.toFixed(3)).toBe("6.000");
    expect(after.averageRate.toFixed(2)).toBe("37.07");
    expect(after.totalValue.toFixed(2)).toBe("222.42");

    const forward = applyHistoricalForwardReplayMovement(createHistoricalForwardReplayState(before), override);
    expect(forward.inventory.totalValue.toFixed(2)).toBe("222.42");

    const reversed = reverseHistoricalSalesRepairMovement(after, override);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("4.000");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("33.15");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("132.60");

    const drifted = createHistoricalInventoryStateFromSnapshot("6", "37.07", "222.43");
    expect(reverseHistoricalSalesRepairMovement(drifted, override)).toEqual({
      reversible: false,
      reason: "MOVEMENT_INVERSE_INVALID",
    });
  });
});
