import { describe, expect, it } from "vitest";
import {
  accountBalanceHistoryBridge,
  propertiesAccountBalanceSplit,
  reconciledHistoryTsv,
  cashCents,
  nonCashCents,
  paymentHistoryTsv,
  receiptTotals,
  type ReceiptRow,
} from "../client/src/pages/properties/property-rental/paymentsReceiptMath";

const receipt = (id: number, amount: number, overrides: Partial<ReceiptRow> = {}): ReceiptRow => ({
  id,
  amount,
  paymentDate: "2026-10-26",
  postingStatus: "POSTED",
  voucherId: id,
  cashAccountId: 969,
  tenantName: "Example Tenant",
  unitNumber: "A1",
  locationGroup: "HMD LUBUMBASHI",
  // USD exports require recorded USD on every row (rentalCurrencyBasis): a
  // missing currency is unknown, not proof of USD.
  currency: "USD",
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

  it("splits the $353,295 historical account total into $328,195 cash-side and $25,100 deposits", () => {
    // Withdrawal through 26 Oct + full ALI cash ($6,400 rent + $1,400 guarantee cash).
    const split = propertiesAccountBalanceSplit(32039500, 2510000, 780000);
    expect(split).toEqual({
      rentAndCashBalance: 32819500,
      depositBalance: 2510000,
      accountSum: 35329500,
    });
    // Neither category is silently rebalanced if an actual ledger differs.
    expect(propertiesAccountBalanceSplit(32039500, 2510000, 780100).accountSum).toBe(35329600);
    expect(propertiesAccountBalanceSplit(null, 2510000, 780000).accountSum).toBeNull();
  });

  it("adds future cashbox entries without treating a guarantee deposit as unique cash twice", () => {
    const futureRows = [
      ...rows,
      receipt(1000, 100, {
        paymentDate: "2026-11-06",
        cashAccountId: 5000,
        receiptKind: "GUARANTEE_DEPOSIT",
      }),
      receipt(1001, 50, { paymentDate: "2026-11-06", cashAccountId: 5000 }),
    ];
    const bridge = accountBalanceHistoryBridge(futureRows, [4134, 5000]);
    expect(bridge.cashAndLiabilityOverlap).toBe(150000);
    expect(bridge.removeNonCashBilling).toBe(80000);
    expect(bridge.reconciledTotal).toBe(35354500);
    const split = propertiesAccountBalanceSplit(32039500, 2520000, 780000, 15000);
    expect(split.accountSum).toBe(35354500);
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

  it("bridges the recorded history to the three-account total without inventing payments", () => {
    const bridge = accountBalanceHistoryBridge(rows, 4134);
    expect(bridge.history.recorded).toBe(35269500);
    expect(bridge.cashAndLiabilityOverlap).toBe(140000);
    expect(bridge.removeNonCashBilling).toBe(80000);
    expect(bridge.netAdjustment).toBe(60000);
    expect(bridge.reconciledTotal).toBe(35329500);
  });

  it("exports an auditable bridge and leaves the dated rows unmodified", () => {
    const before = JSON.stringify(rows);
    const tsv = reconciledHistoryTsv(rows, { aliCashLedgerId: 4134, threeAccountsTotal: 35329500 });
    const lines = tsv.split("\n");
    expect(tsv).toContain("Account Reconciliation (USD)");
    expect(tsv).toContain("ACCOUNT RECONCILIATION: GUARANTEE OVERLAP");
    expect(tsv).toContain("ACCOUNT RECONCILIATION: REMOVE NON-CASH BILLING");
    expect(tsv).toContain("NET RECONCILIATION ADJUSTMENT");
    expect(tsv).toContain("RECONCILED HISTORY + ADJUSTMENT");
    expect(lines.some((line) => line.includes("NET RECONCILIATION ADJUSTMENT") && line.endsWith("\t600.00"))).toBe(
      true
    );
    expect(lines.some((line) => line.includes("RECONCILED HISTORY + ADJUSTMENT") && line.endsWith("\t353295.00"))).toBe(
      true
    );
    expect(lines.some((line) => line.includes("UNRECONCILED DIFFERENCE") && line.endsWith("\t0.00"))).toBe(true);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("reports a residual instead of automatically forcing any arbitrary account total", () => {
    const tsv = reconciledHistoryTsv(rows, { aliCashLedgerId: 4134, threeAccountsTotal: 35379500 });
    expect(tsv.split("\n").some((line) => line.includes("UNRECONCILED DIFFERENCE") && line.endsWith("\t500.00"))).toBe(
      true
    );
  });

  it("escapes spreadsheet formulas in copied tenant names", () => {
    const text = paymentHistoryTsv([receipt(9, 1, { tenantName: "=CMD()\tnew-row" })]);
    expect(text).toContain("'=CMD() new-row");
  });
});
