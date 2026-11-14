import { describe, expect, it } from "vitest";
import { cancellationFingerprint } from "../server/services/intercompany/phase5Cancel";
import { exactDestinationReceiptPlan, receiptFingerprint } from "../server/services/intercompany/phase5Receipt";

describe("Phase 5 linked ERP receiving exact-value invariants", () => {
  it("allocates the original entire confirmed landed cost to the destination stock and keeps the last cent", () => {
    const lines = [
      { stockItemId: 15, quantity: "2.000", lineTotal: "18.00" },
      { stockItemId: 4, quantity: "3.000", lineTotal: "29.00" },
      { stockItemId: 15, quantity: "1.000", lineTotal: "9.00" },
    ];
    const received = exactDestinationReceiptPlan(lines, "56.00", "57.01");
    expect(received.map((row) => row.stockItemId)).toEqual([4, 15]);
    expect(received.map((row) => row.quantity)).toEqual(["3.000", "3.000"]);
    expect(received.map((row) => row.value)).toEqual(["29.52", "27.49"]);
    expect(received.reduce((sum, item) => sum + Math.round(Number(item.value) * 100), 0)).toBe(5701);
  });

  it("handles discounts without creating an extra cash entry", () => {
    const result = exactDestinationReceiptPlan(
      [{ stockItemId: 1, quantity: "5.000", lineTotal: "100.00" }],
      "100.00",
      "97.99"
    );
    expect(result).toEqual([{ stockItemId: 1, quantity: "5.000", value: "97.99" }]);
  });

  it("refuses unresolved purchase values and unsupported stock quantity precision", () => {
    const lines = [{ stockItemId: 1, quantity: "1.000", lineTotal: "23.00" }];
    expect(() => exactDestinationReceiptPlan(lines, "24.00", "23.00")).toThrow(/reconcile/);
    expect(() => exactDestinationReceiptPlan(lines, "23.00", "0.00")).toThrow(/positive/);
    expect(() => exactDestinationReceiptPlan([{ ...lines[0], quantity: "1.0004" }], "23.00", "23.00")).toThrow(
      /quantity/
    );
    expect(() => exactDestinationReceiptPlan([{ ...lines[0], stockItemId: -1 }], "23.00", "23.00")).toThrow(/identity/);
    expect(() => exactDestinationReceiptPlan([], "1.00", "1.00")).toThrow(/missing/);
  });

  it("gives different replay fingerprints to changed real-world receiving evidence", () => {
    const original = {
      tradeId: 1,
      expectedVersion: 2,
      requestKey: "phase5-receipt-a",
      postingDate: "2026-11-05",
      locationId: 10,
      inventoryAccountId: 14,
      arrivalEvidence: "signed warehouse receipt",
      reason: "Arrived verified",
      confirmPhysicalArrival: true,
      confirmNoAdditionalUnpostedCharges: true,
    };
    const a = receiptFingerprint(original);
    expect(receiptFingerprint({ ...original })).toBe(a);
    expect(receiptFingerprint({ ...original, locationId: 11 })).not.toBe(a);
    expect(receiptFingerprint({ ...original, arrivalEvidence: "different warehouse receipt" })).not.toBe(a);
  });

  it("ties cancellation retry to version, invoice disposition and BOTH cash confirmations", () => {
    const original = {
      tradeId: 1,
      expectedVersion: 2,
      requestKey: "phase5-cancel-a",
      postingDate: "2026-11-05",
      cancellationEvidence: "Shipment canceled by forwarder",
      reason: "Cargo remains in transit",
      sharedChargeDecision: "none" as const,
      confirmGoodsNotReceived: true,
      confirmNoRealCashReversal: true,
    };
    const a = cancellationFingerprint(original);
    expect(cancellationFingerprint({ ...original })).toBe(a);
    expect(cancellationFingerprint({ ...original, expectedVersion: 3 })).not.toBe(a);
    expect(cancellationFingerprint({ ...original, sharedChargeDecision: "redistributed" })).not.toBe(a);
    expect(cancellationFingerprint({ ...original, confirmNoRealCashReversal: false })).not.toBe(a);
  });
});
