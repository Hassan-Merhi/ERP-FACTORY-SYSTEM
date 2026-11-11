import { describe, expect, it } from "vitest";
import {
  parseStockTransferOrderDeliveryReconciliation,
  StockTransferOrderDeliveryReconciliationError,
} from "../server/services/stockTransferOrderWaReconciliationPolicy";

const evidence = {
  action: "verify_delivered",
  expectedStatus: "uncertain",
  reason: "Verified the approved workbook in the linked approval-group WhatsApp chat.",
  checkedWhatsApp: true,
  checkedProvider: true,
  confirmedDelivered: true,
};

describe("Stock Transfer Order Phase 6 administrator reconciliation policy", () => {
  it("accepts a verified file with specific review evidence", () => {
    expect(parseStockTransferOrderDeliveryReconciliation(evidence)).toMatchObject({
      action: "verify_delivered",
      expectedStatus: "uncertain",
      confirmedDelivered: true,
      confirmedNotDelivered: false,
      checkedWhatsApp: true,
      checkedProvider: true,
    });
  });

  it("requires both provider-history and chat verification before marking delivered", () => {
    for (const property of ["checkedWhatsApp", "checkedProvider", "confirmedDelivered"] as const) {
      expect(() => parseStockTransferOrderDeliveryReconciliation({ ...evidence, [property]: false }))
        .toThrow(StockTransferOrderDeliveryReconciliationError);
    }
    expect(() => parseStockTransferOrderDeliveryReconciliation({
      ...evidence, expectedStatus: "accepted",
    })).toThrow();
  });

  it("requires explicit absence and duplicate-risk acknowledgement to retry", () => {
    const retry = {
      ...evidence,
      action: "authorize_retry",
      expectedStatus: "failed",
      confirmedDelivered: false,
      confirmedNotDelivered: true,
      acknowledgeDuplicateRisk: true,
    };
    expect(parseStockTransferOrderDeliveryReconciliation(retry)).toMatchObject({
      action: "authorize_retry",
      expectedStatus: "failed",
      confirmedNotDelivered: true,
      acknowledgeDuplicateRisk: true,
    });
    expect(() => parseStockTransferOrderDeliveryReconciliation({
      ...retry, confirmedNotDelivered: false,
    })).toThrow();
    expect(() => parseStockTransferOrderDeliveryReconciliation({
      ...retry, acknowledgeDuplicateRisk: false,
    })).toThrow();
  });

  it("rejects missing/short/oversized notes and control character injection", () => {
    expect(() => parseStockTransferOrderDeliveryReconciliation({ ...evidence, reason: "checked" }))
      .toThrow();
    expect(() => parseStockTransferOrderDeliveryReconciliation({ ...evidence, reason: "x".repeat(501) }))
      .toThrow();
    expect(() => parseStockTransferOrderDeliveryReconciliation({
      ...evidence, reason: "Verified the chat\nbut added an injected newline",
    })).toThrow();
    expect(() => parseStockTransferOrderDeliveryReconciliation("DONE")).toThrow();
  });

  it("rejects a pending, sending, accepted or verified delivery in the body", () => {
    for(const status of ["pending","sending","accepted","verified"]) {
      expect(() => parseStockTransferOrderDeliveryReconciliation({
        ...evidence, expectedStatus: status,
      })).toThrow();
    }
  });
});
