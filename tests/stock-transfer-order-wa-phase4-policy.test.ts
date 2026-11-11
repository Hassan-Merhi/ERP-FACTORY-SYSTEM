import { describe, expect, it } from "vitest";
import {
  chooseStockTransferOrderWaApprovalLeaders,
  stockTransferOrderWaBusinessConflictCode,
} from "../server/services/stockTransferOrderWhatsAppDecisionPolicy";

describe("Stock Transfer Order WhatsApp Phase 4 batch selection", () => {
  it("selects one leader for every order, not per source location", () => {
    const result = chooseStockTransferOrderWaApprovalLeaders([201, 202, 203], [
      { transfer_id: 201, revision_id: 901, revision_number_snapshot: 1 },
      { transfer_id: 202, revision_id: 902, revision_number_snapshot: 1 },
      { transfer_id: 201, revision_id: 904, revision_number_snapshot: 3 },
      { transfer_id: 203, revision_id: 903, revision_number_snapshot: 1 },
      { transfer_id: 201, revision_id: 905, revision_number_snapshot: 2 },
    ]);
    expect([...result]).toEqual([[201, 904], [202, 902], [203, 903]]);
  });

  it("is independent of input order, with deterministic revision-id tie-breaking", () => {
    const revisions = [
      { transfer_id: 10, revision_id: 110, revision_number_snapshot: 3 },
      { transfer_id: 10, revision_id: 112, revision_number_snapshot: 3 },
      { transfer_id: 10, revision_id: 105, revision_number_snapshot: 2 },
    ];
    expect(chooseStockTransferOrderWaApprovalLeaders([10], [...revisions].reverse()).get(10)).toBe(112);
  });

  it("fails closed for revisions outside selected orders", () => {
    expect(() => chooseStockTransferOrderWaApprovalLeaders([10], [
      { transfer_id: 11, revision_id: 101, revision_number_snapshot: 1 },
    ])).toThrow("Frozen revision does not belong");
  });

  it("requires at least one pending revision for each selected order", () => {
    expect(() => chooseStockTransferOrderWaApprovalLeaders([10, 20], [
      { transfer_id: 10, revision_id: 101, revision_number_snapshot: 1 },
    ])).toThrow("Every selected order");
    expect(() => chooseStockTransferOrderWaApprovalLeaders([], [])).toThrow();
  });

  it("refuses malformed selected IDs and duplicate order IDs", () => {
    expect(() => chooseStockTransferOrderWaApprovalLeaders([10, 10], [
      { transfer_id: 10, revision_id: 101, revision_number_snapshot: 1 },
    ])).toThrow();
    expect(() => chooseStockTransferOrderWaApprovalLeaders([10, -2], [
      { transfer_id: 10, revision_id: 101, revision_number_snapshot: 1 },
    ])).toThrow();
  });

  it("only marks known business conflicts terminal; database errors remain retryable", () => {
    expect(stockTransferOrderWaBusinessConflictCode({ code: "STOCK_TRANSFER_INSUFFICIENT_STOCK" }))
      .toBe("STOCK_TRANSFER_INSUFFICIENT_STOCK");
    expect(stockTransferOrderWaBusinessConflictCode({ code: "STO_WA_DESTINATION_CHANGED" }))
      .toBe("STO_WA_DESTINATION_CHANGED");
    expect(stockTransferOrderWaBusinessConflictCode({ code: "40P01" })).toBeNull();
    expect(stockTransferOrderWaBusinessConflictCode({ code: "ECONNRESET" })).toBeNull();
    expect(stockTransferOrderWaBusinessConflictCode(new Error("network unavailable"))).toBeNull();
  });
});
