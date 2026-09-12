/**
 * Behavior tests for the voucher edit round-trip mapping extracted from
 * VoucherEditDialog.tsx. The critical contracts: multi-currency fields must
 * survive the stored-voucher → form → PUT payload cycle, the payload shape
 * must match what the server's with-entries endpoint expects, and the
 * balance check must use the 0.01 tolerance the UI displays.
 */

import { describe, expect, it } from "vitest";
import {
  computeEntryTotals,
  emptyVoucherEntry,
  parseConsumptionNarration,
  parseConsumptionNarrationQty,
  voucherDataToFormValues,
  voucherFormToPayload,
} from "./voucherEditMapping";
import type { VoucherFormData } from "./voucherEditSchema";

function formValues(overrides: Partial<VoucherFormData> = {}): VoucherFormData {
  return {
    voucherNumber: "V-123",
    voucherType: "Journal",
    voucherDate: new Date("2026-07-15T00:00:00Z"),
    description: "test",
    optional: false,
    entries: [{ ...emptyVoucherEntry, debitAmount: "10", creditAmount: "10" }],
    ...overrides,
  };
}

describe("voucherDataToFormValues", () => {
  it("maps stored voucher fields with safe defaults", () => {
    const values = voucherDataToFormValues({
      voucherNumber: "V-1",
      voucherType: "Payment",
      voucherDate: "2026-07-15T00:00:00Z",
      description: "paid supplier",
      optional: true,
      entries: [
        {
          ledgerAccountId: 7,
          bankAccountId: null,
          fixedAssetId: null,
          supplierId: null,
          employeeId: null,
          debitAmount: "100.50",
          creditAmount: "0",
          narration: "note",
        },
      ],
    });
    expect(values.voucherNumber).toBe("V-1");
    expect(values.voucherType).toBe("Payment");
    expect(values.voucherDate).toEqual(new Date("2026-07-15T00:00:00Z"));
    expect(values.optional).toBe(true);
    expect(values.entries).toHaveLength(1);
    expect(values.entries[0].ledgerAccountId).toBe(7);
    expect(values.entries[0].debitAmount).toBe("100.50");
  });

  it("falls back to a single empty entry when the voucher has none", () => {
    const values = voucherDataToFormValues({
      voucherNumber: "V-2",
      voucherType: "",
      voucherDate: "2026-07-15T00:00:00Z",
      description: "",
      optional: false,
      entries: [],
    });
    expect(values.voucherType).toBe("Journal");
    expect(values.entries).toEqual([emptyVoucherEntry]);
  });

  it("preserves multi-currency fields on the round-trip", () => {
    const values = voucherDataToFormValues({
      voucherNumber: "V-3",
      voucherType: "Purchase",
      voucherDate: "2026-07-15T00:00:00Z",
      description: "LBP purchase",
      optional: false,
      entries: [
        {
          ledgerAccountId: 1,
          bankAccountId: null,
          fixedAssetId: null,
          supplierId: null,
          employeeId: null,
          debitAmount: "100",
          creditAmount: "0",
          narration: "",
          transactionCurrency: "LBP",
          transactionDebitAmount: "150000",
          transactionCreditAmount: "0",
          historicalExchangeRate: "1500",
          rateConvention: "historical",
        },
      ],
    });
    expect(values.entries[0]).toMatchObject({
      transactionCurrency: "LBP",
      transactionDebitAmount: "150000",
      transactionCreditAmount: "0",
      historicalExchangeRate: "1500",
      rateConvention: "historical",
    });
  });

  it("normalizes missing multi-currency fields to null (not undefined)", () => {
    const values = voucherDataToFormValues({
      voucherNumber: "V-4",
      voucherType: "Journal",
      voucherDate: "2026-07-15T00:00:00Z",
      description: "",
      optional: false,
      entries: [
        {
          ledgerAccountId: 1,
          bankAccountId: null,
          fixedAssetId: null,
          supplierId: null,
          employeeId: null,
          debitAmount: "1",
          creditAmount: "1",
          narration: "",
        },
      ],
    });
    expect(values.entries[0].transactionCurrency).toBeNull();
    expect(values.entries[0].historicalExchangeRate).toBeNull();
  });
});

describe("voucherFormToPayload", () => {
  it("builds the voucher header and entry payloads", () => {
    const payload = voucherFormToPayload(
      formValues({
        voucherType: "Payment",
        voucherDate: new Date("2026-07-15T00:00:00Z"),
        entries: [
          { ...emptyVoucherEntry, debitAmount: "50" },
          { ...emptyVoucherEntry, creditAmount: "50" },
        ],
      })
    );
    expect(payload.voucher).toEqual({
      voucherType: "Payment",
      voucherDate: "2026-07-15",
      description: "test",
      optional: false,
    });
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0].debitAmount).toBe("50");
    expect(payload.entries[1].creditAmount).toBe("50");
  });

  it("carries historical multi-currency fields through to the payload", () => {
    const payload = voucherFormToPayload(
      formValues({
        entries: [
          {
            ...emptyVoucherEntry,
            debitAmount: "100",
            transactionCurrency: "EUR",
            transactionDebitAmount: "90",
            historicalExchangeRate: "1.1",
            rateConvention: "historical",
          },
        ],
      })
    );
    expect(payload.entries[0]).toMatchObject({
      transactionCurrency: "EUR",
      historicalExchangeRate: "1.1",
      rateConvention: "historical",
    });
  });

  it("omits undefined multi-currency fields instead of sending nulls", () => {
    // Fields are mapped to `?? undefined` so JSON serialization drops them
    // entirely (the server treats absent fields as "no historical rate").
    const payload = voucherFormToPayload(formValues({}));
    const entryJson = JSON.parse(JSON.stringify(payload.entries[0]));
    expect(payload.entries[0].transactionCurrency).toBeUndefined();
    expect(payload.entries[0].historicalExchangeRate).toBeUndefined();
    expect(payload.entries[0].rateConvention).toBeUndefined();
    expect(entryJson).not.toHaveProperty("transactionCurrency");
    expect(entryJson).not.toHaveProperty("historicalExchangeRate");
    expect(entryJson).not.toHaveProperty("rateConvention");
  });
});

describe("computeEntryTotals", () => {
  it("sums debits and credits from string amounts", () => {
    const { totalDebits, totalCredits, isBalanced } = computeEntryTotals([
      { ...emptyVoucherEntry, debitAmount: "10.5" },
      { ...emptyVoucherEntry, creditAmount: "4" },
      { ...emptyVoucherEntry, creditAmount: "6.5" },
    ]);
    expect(totalDebits).toBeCloseTo(10.5);
    expect(totalCredits).toBeCloseTo(10.5);
    expect(isBalanced).toBe(true);
  });

  it("treats a 0.005 rounding difference as balanced (0.01 tolerance)", () => {
    const { isBalanced } = computeEntryTotals([
      { ...emptyVoucherEntry, debitAmount: "10.005" },
      { ...emptyVoucherEntry, creditAmount: "10" },
    ]);
    expect(isBalanced).toBe(true);
  });

  it("flags a real mismatch as unbalanced", () => {
    const { isBalanced } = computeEntryTotals([
      { ...emptyVoucherEntry, debitAmount: "10.02" },
      { ...emptyVoucherEntry, creditAmount: "10" },
    ]);
    expect(isBalanced).toBe(false);
  });

  it("parses empty strings as zero", () => {
    const { totalDebits, totalCredits } = computeEntryTotals([
      { ...emptyVoucherEntry, debitAmount: "", creditAmount: "" },
    ]);
    expect(totalDebits).toBe(0);
    expect(totalCredits).toBe(0);
  });
});

describe("consumption narration parsing", () => {
  it("parses the full 'of -1.000 x NAME @ $rate' pattern", () => {
    expect(parseConsumptionNarration("Consumption of -1.500 x Basmati Rice 25kg @ $98.62")).toEqual({
      qty: 1.5,
      itemName: "Basmati Rice 25kg",
      rate: 98.62,
    });
  });

  it("parses positive quantities and rates without a dollar sign", () => {
    expect(parseConsumptionNarration("Production of 2 x Wheat Flour @ 12.34")).toEqual({
      qty: 2,
      itemName: "Wheat Flour",
      rate: 12.34,
    });
  });

  it("returns null when the pattern is absent", () => {
    expect(parseConsumptionNarration("random note")).toBeNull();
    expect(parseConsumptionNarration("Consumption of 1 x No rate")).toBeNull();
  });

  it("qty-only parsing works without the rate tail", () => {
    expect(parseConsumptionNarrationQty("Consumption of -2.250 x Rice @ $5")).toBe(2.25);
    expect(parseConsumptionNarrationQty("Consumption of 3 x Rice")).toBe(3);
    expect(parseConsumptionNarrationQty("no quantity here")).toBeNull();
  });
});
