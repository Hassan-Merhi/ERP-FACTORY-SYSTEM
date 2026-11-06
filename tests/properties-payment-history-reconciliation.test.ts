import { describe, expect, it } from "vitest";
import {
  cashCents,
  nonCashCents,
  paymentHistoryTsv,
  receiptTotals,
  type ReceiptRow,
} from "../client/src/pages/properties/property-rental/paymentsReceiptMath";

const receipt = (
  id: number,
  amount: number,
  overrides: Partial<ReceiptRow> = {}
): ReceiptRow => ({
  id,
  amount,
  paymentDate: "2026-10-26",
  postingStatus: "POSTED",
  voucherId: id,
  cashAccountId: 969,
  tenantName: "Example Tenant",
  unitNumber: "A1",
  locationGroup: "HMD LUBUMBASHI",
  ...overrides,
});

describe("Properties read-only payment history reconciliation", () => {
  const rows = [
    receipt(1, 320395, { notes: "Historical rent" }),
    receipt(2, 23700, { notes: "Guarantee releases" }),
    receipt(3, 6400, { paymentDate: "2026-10-30", cashAccountId: 4134 }),
    receipt(-16841, 1400, {
      paymentDate: "2026-10-30",
      voucherId: 16841,
      cashAccountId: 4134,
      receiptKind: "GUARANTEE_DEPOSIT",
      notes: "Guarantee deposit (voucher-backed, read-only)",
      readOnly: true,
    }),
    receipt(342, 800, {
      paymentDate: "2026-07-25",
      voucherId: null,
      cashAccountId: 859,
      notes: "Billing transition adjustment",
    }),
  ];

  it("reconciles $351,895 cash while preserving the $800 non-cash adjustment", () => {
    expect(receiptTotals(rows)).toEqual({
      cash: 35189500,
      nonCash: 80000,
      scheduled: 0,
      recorded: 35269500,
    });
    expect(cashCents(rows[3])).toBe(140000);
    expect(cashCents(rows[4])).toBe(0);
    expect(nonCashCents(rows[4])).toBe(80000);
  });

  it("copies the same cash and noncash columns shown in the table", () => {
    const copied = paymentHistoryTsv(rows);
    const lines = copied.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("Cash Received (USD)\tNon-cash Adjustment (USD)");
    expect(lines[4]).toContain("1400.00\t0.00");
    expect(lines[5]).toContain("0.00\t800.00");
    expect(lines[6]).toContain("351895.00\t800.00");
    expect(copied).toContain("Voucher-backed guarantee (read-only)");
  });

  it("does not treat scheduled entries or rent allocations without cash as receipts", () => {
    const scheduled = receipt(7, 1000, { postingStatus: "SCHEDULED", voucherId: null });
    const guaranteeAsRent = receipt(8, 400, { cashAccountId: null });
    expect(receiptTotals([scheduled, guaranteeAsRent])).toEqual({
      cash: 0,
      nonCash: 40000,
      scheduled: 100000,
      recorded: 140000,
    });
  });

  it("escapes spreadsheet formulas in copied tenant names", () => {
    const text = paymentHistoryTsv([receipt(9, 1, { tenantName: "=CMD()\tnew-row" })]);
    expect(text).toContain("'=CMD() new-row");
  });
});
