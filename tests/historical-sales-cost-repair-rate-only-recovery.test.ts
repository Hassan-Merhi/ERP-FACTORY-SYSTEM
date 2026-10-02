import { describe, expect, it } from "vitest";
import {
  applyHistoricalForwardReplayMovement,
  createHistoricalForwardReplayState,
  createHistoricalInventoryStateFromSnapshot,
} from "../server/services/inventory/historicalSalesCostRepairEngine";

import { reverseHistoricalSalesRepairMovement } from "../server/services/inventory/historicalSalesCostRepairEngineReverse";
import { movement } from "./helpers/historicalSalesCostRepairMovement";

describe("historical sales cost repair rate-only recovery", () => {
  it("does not treat a POS reversal journal cost as a receipt rate", () => {
    const start = createHistoricalForwardReplayState(
      createHistoricalInventoryStateFromSnapshot("5", "100.00", "500.00")
    );
    const next = applyHistoricalForwardReplayMovement(
      start,
      movement({
        movementId: "canonical:pos-reverse",
        occurredAt: "2026-09-01T10:00:00.000Z",
        quantityDelta: "2",
        unitCost: "80.00",
        sourceType: "pos-sale",
        evidence: "canonical",
      })
    );

    expect(next.inventory.quantity.toFixed(3)).toBe("7.000");
    expect(next.inventory.totalValue.toFixed(2)).toBe("700.00");
    expect(next.inventory.averageRate.toFixed(2)).toBe("100.00");
  });

  it("does not replace a previously reversible POS receipt inverse with a locally ambiguous branch", () => {
    const start = createHistoricalInventoryStateFromSnapshot("5", "100.00", "500.00");
    const posReversal = movement({
      movementId: "canonical:pos-reverse-inverse",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "2",
      unitCost: "80.00",
      sourceType: "pos-sale",
      evidence: "canonical",
    });
    const after = applyHistoricalForwardReplayMovement(
      createHistoricalForwardReplayState(start),
      posReversal
    ).inventory;

    const reversed = reverseHistoricalSalesRepairMovement(after, posReversal);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;

    // The one-step inverse has two plausible histories. V20 keeps the prior
    // V18 branch here; an unpriced POS-reversal branch must only replace it
    // after a complete checkpoint proof, never from local reversibility alone.
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("5.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("540.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("108.00");
  });

  it("recovers a failed positive POS reversal only when the unique unpriced rate-only inverse preserves quantity and value", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("455", "59.63", "27135.99");
    const posReversal = movement({
      movementId: "canonical:13396",
      occurredAt: "2026-08-27T09:53:43.552Z",
      quantityDelta: "4",
      unitCost: "59.630000",
      sourceType: "pos-sale",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, posReversal);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("451.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("26897.43");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("59.64");
  });

  it("recovers a failed outbound stock transfer only when the unique source-rate inverse preserves quantity and value", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("462", "59.63", "27553.36");
    const transferOut = movement({
      movementId: "canonical:9247",
      occurredAt: "2026-08-24T06:41:01.603Z",
      quantityDelta: "-25",
      unitCost: "59.630000",
      sourceType: "stock-transfer",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, transferOut);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("487.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("29044.36");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("59.64");
  });

  it("recovers a legacy sale issue only when the pre-sale rate is uniquely implied by quantity and value", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("62", "94.62", "5872.89");
    const legacySale = movement({
      movementId: "sale-marker:88647",
      occurredAt: "2026-08-11T12:52:21.673Z",
      quantityDelta: "-1",
      unitCost: null,
      sourceType: "legacy-sale",
      evidence: "legacy",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, legacySale);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("LEGACY_ISSUE_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("63.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("5967.61");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("94.72");
  });

  it("keeps an ambiguous legacy sale rate blocked", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("7", "57.62", "403.72");
    const ambiguousSale = movement({
      movementId: "sale-marker:89383",
      occurredAt: "2026-08-13T10:41:29.724Z",
      quantityDelta: "-2",
      unitCost: null,
      sourceType: "legacy-sale",
      evidence: "legacy",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, ambiguousSale);
    expect(reversed.reversible).toBe(false);
  });

  it("falls back to the value-derived center for a uniquely solvable POS reversal only after the stored-rate search finds none", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("14", "128.85", "1815.12");
    const posReversal = movement({
      movementId: "canonical:29139",
      occurredAt: "2026-09-09T09:42:29.570Z",
      quantityDelta: "1",
      unitCost: "128.850000",
      sourceType: "pos-sale",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, posReversal);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("13.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("1685.47");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("129.65");
  });

  it("falls back to the value-derived center for a uniquely solvable legacy sale issue", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("9", "19.62", "675.19");
    const legacySale = movement({
      movementId: "sale-marker:51181",
      occurredAt: "2026-04-07T12:06:54.887Z",
      quantityDelta: "-1",
      unitCost: null,
      sourceType: "legacy-sale",
      evidence: "legacy",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, legacySale);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("LEGACY_ISSUE_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("10.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("750.21");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("75.02");
  });

  it("keeps a derived-center stock-transfer inverse blocked when more than one exact rate candidate exists", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("165", "61.35", "10056.39");
    const transferOut = movement({
      movementId: "canonical:16798",
      occurredAt: "2026-08-31T13:01:41.856Z",
      quantityDelta: "-98",
      unitCost: "61.340000",
      sourceType: "stock-transfer",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, transferOut);
    expect(reversed.reversible).toBe(false);
  });

  it("recovers a legacy offload from its exact stored value when only the reconstructed rate is stale", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("115", "78.25", "8969.47");
    const legacyOffload = movement({
      movementId: "offload:24505",
      occurredAt: "2026-08-15T00:00:00.000Z",
      quantityDelta: "6",
      unitCost: "84.54",
      exactValue: "507.24",
      sourceType: "legacy-container-offload",
      sourceId: "438",
      evidence: "legacy",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, legacyOffload);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("LEGACY_RECEIPT_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("109.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("8462.23");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("77.64");
  });

  it("recovers a canonical POS issue when quantity and value invert exactly but the reconstructed rate is stale", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("9", "100.00", "990.00");
    const saleIssue = movement({
      movementId: "canonical:rate-only-pos-issue",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "-1",
      unitCost: "100.00",
      sourceType: "pos-sale",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, saleIssue);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("10.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("1090.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
  });

  it("recovers a canonical priced receipt when only the reconstructed post-rate disagrees", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("10", "100.00", "1100.00");
    const transferIn = movement({
      movementId: "canonical:rate-only-transfer-in",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "2",
      unitCost: "150.00",
      sourceType: "stock-transfer",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, transferIn);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("8.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("800.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
  });

  it("recovers a canonical exact-value offload when only the reconstructed post-rate disagrees", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("10", "100.00", "1100.00");
    const offload = movement({
      movementId: "canonical:rate-only-offload",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "2",
      unitCost: "150.00",
      exactValue: "300.00",
      sourceType: "container-offload",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, offload);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("8.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("800.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
  });

  it("recovers a negative canonical sale lifecycle correction from its pinned issue rate", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("9", "100.00", "990.00");
    const correction = movement({
      movementId: "canonical-correction:100:500:10:100",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "-1",
      unitCost: "100.00",
      sourceType: "canonical-sale-lifecycle-correction",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, correction);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RATE_ONLY");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("10.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("1090.00");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("100.00");
  });

  it("keeps the same rate-only shortcut disabled for legacy evidence", () => {
    const staleAfter = createHistoricalInventoryStateFromSnapshot("10", "100.00", "1100.00");
    const legacyTransferIn = movement({
      movementId: "legacy:rate-only-transfer-in",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "2",
      unitCost: "150.00",
      sourceType: "legacy-stock-transfer-in",
      evidence: "legacy",
    });

    const reversed = reverseHistoricalSalesRepairMovement(staleAfter, legacyTransferIn);
    expect(reversed.reversible).toBe(false);
  });

  it("recovers an outbound stock-adjustment edit apply from its persisted canonical line value", () => {
    const after = createHistoricalInventoryStateFromSnapshot("232", "67.75", "15757.78");
    const editApply = movement({
      movementId: "canonical:21820",
      occurredAt: "2026-09-04T06:31:33.476Z",
      quantityDelta: "-1",
      unitCost: "67.750000",
      sourceType: "stock_adjustment_edit_apply",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(after, editApply);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_ADJUSTMENT_EDIT_VALUE");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("233.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("15825.53");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("67.92");
  });

  it("prefers the canonical recorded sale rate when a zero-crossing issue leaves ambiguous cost memory", () => {
    const after = createHistoricalInventoryStateFromSnapshot("0", "72.56", "0.00");
    const sale = movement({
      movementId: "canonical:recorded-rate-priority",
      occurredAt: "2026-09-01T10:00:00.000Z",
      quantityDelta: "-1",
      unitCost: "72.55",
      sourceType: "pos-sale",
      evidence: "canonical",
    });

    const reversed = reverseHistoricalSalesRepairMovement(after, sale);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.recovery).toBe("CANONICAL_RECORDED_ISSUE_RATE");
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("1.000");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("72.55");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("72.55");
  });
});
