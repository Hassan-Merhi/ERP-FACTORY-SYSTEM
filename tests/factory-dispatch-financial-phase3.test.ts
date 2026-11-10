/** Phase 3 tests authored for later local execution; CI intentionally not run. */
import { describe, expect, it } from "vitest";
import {
  accountAcceptsCharge, accountAcceptsOffset, buildTripChargePreview,
  tripChargeFingerprint, validChargeInput, type TripChargeRow,
} from "../server/routes/factory/customer-orders/loadingDispatchFinancialChargeModel";

const charge = (id: number, kind: TripChargeRow["kind"], amount: string): TripChargeRow => ({
  id, revision: 1, name: "Charge " + id, kind, amount, currency: "USD",
  ledgerAccountId: 25, offsetLedgerAccountId: kind === "INTERNAL" ? 44 : null,
  erpChargeType: null, notes: null, lockedAt: null,
});

describe("Factory financial trip charge previews", () => {
  it("keeps customer charges, discounts and internal expenses separate", () => {
    const actual = buildTripChargePreview("100.20", [
      charge(1, "BILLABLE", "3.40"),
      charge(2, "DISCOUNT", "0.60"),
      charge(3, "INTERNAL", "70.00"),
    ]);
    expect(actual).toEqual({
      goodsSubtotal: "100.20", billableChargesTotal: "3.40",
      discountTotal: "0.60", internalExpenseTotal: "70.00",
      customerTotal: "103.00", chargeCount: 3,
    });
  });

  it("rejects a negative payable or an excessive customer discount", () => {
    expect(() => buildTripChargePreview("1.00", [charge(2, "DISCOUNT", "3.00")]))
      .toThrow("Discounts exceed");
    expect(() => validChargeInput({ name: "Bad", kind: "BILLABLE", amount: "-2.00", ledgerAccountId: 12 }))
      .toThrow("Charge must be");
  });

  it("requires valid company account selections and proper internal offset", () => {
    expect(() => validChargeInput({ name: "Internal", kind: "INTERNAL", amount: "4", ledgerAccountId: 3 }))
      .toThrow("require a payable");
    expect(() => validChargeInput({
      name: "Billable", kind: "BILLABLE", amount: "4", ledgerAccountId: 3,
      offsetLedgerAccountId: 5,
    })).toThrow("Only internal");
    expect(accountAcceptsCharge("BILLABLE", "Income")).toBe(true);
    expect(accountAcceptsCharge("BILLABLE", "Liability")).toBe(false);
    expect(accountAcceptsCharge("INTERNAL", "Expense")).toBe(true);
    expect(accountAcceptsOffset("Liability")).toBe(true);
  });

  it("maps only recognized ERP PO charge types, never internal expenses", () => {
    expect(validChargeInput({
      name: "Freight", kind: "BILLABLE", amount: "12.50",
      ledgerAccountId: 3, erpChargeType: "freight",
    }).erpChargeType).toBe("freight");
    expect(() => validChargeInput({
      name: "Custom", kind: "BILLABLE", amount: "12",
      ledgerAccountId: 3, erpChargeType: "handling",
    })).toThrow("supported charge types");
    expect(() => validChargeInput({
      name: "Internal", kind: "INTERNAL", amount: "12",
      ledgerAccountId: 3, offsetLedgerAccountId: 4, erpChargeType: "freight",
    })).toThrow("cannot become ERP");
    expect(() => validChargeInput({
      name: "Discount", kind: "DISCOUNT", amount: "12",
      ledgerAccountId: 3, erpChargeType: "freight",
    })).toThrow("Discounts use");
  });

  it("normalizes decimal charges to exact cents and refuses excessive precision", () => {
    expect(validChargeInput({
      name: "Transport", kind: "BILLABLE", amount: "0.1", ledgerAccountId: 12,
    }).amount).toBe("0.10");
    expect(() => validChargeInput({
      name: "Transport", kind: "BILLABLE", amount: "1.001", ledgerAccountId: 12,
    })).toThrow("decimal places");
  });

  it("computes a deterministic charge fingerprint and changes on financial edits", () => {
    const original = [charge(1, "BILLABLE", "10.00"), charge(2, "INTERNAL", "5.00")];
    const fp = tripChargeFingerprint(original);
    expect(tripChargeFingerprint([...original].reverse())).toBe(fp);
    expect(tripChargeFingerprint([
      { ...original[0], amount: "10.01" }, original[1],
    ])).not.toBe(fp);
    expect(tripChargeFingerprint([
      { ...original[0], lockedAt: "2026-11-10T07:30:00Z" }, original[1],
    ])).not.toBe(fp);
  });
});
