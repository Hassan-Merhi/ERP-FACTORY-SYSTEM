/**
 * Unit tests for the Agent Ledger Excel row builder extracted from
 * pages/Agents.tsx. Pins the header, FX-note row, opening-balance row, and
 * per-voucher row shapes of the exported statement.
 */
import { describe, expect, it } from "vitest";
import { buildAgentStatementExcelRows } from "./agentStatementExcel";
import { computeRunningBalances, type Account, type GroupedVoucher } from "./agentStatementMath";

const formatAmount = (n: number) => `$${n.toFixed(2)}`;

const account: Account = {
  id: "acc-1",
  accountId: 1,
  type: "customer",
  code: "C-1",
  name: "Alpha Agent",
  balance: 60,
  balanceSide: "Dr",
  active: true,
};

const vouchers: GroupedVoucher[] = [
  {
    voucherId: 91,
    voucherNumber: "JV-91",
    voucherType: "Journal",
    voucherDate: "2026-08-20",
    voucherDescription: "Agent sale",
    narration: "Agent sale",
    totalDebit: 30,
    totalCredit: 5,
  },
  {
    voucherId: 92,
    voucherNumber: "JV-92",
    voucherType: "Receipt",
    voucherDate: "2026-08-21",
    voucherDescription: "",
    narration: "Payment received",
    totalDebit: 0,
    totalCredit: 20,
  },
];

describe("buildAgentStatementExcelRows", () => {
  it("builds header, opening row, and voucher rows without an FX note", () => {
    const rows = buildAgentStatementExcelRows({
      account,
      vouchersWithBalance: computeRunningBalances(vouchers, 25, account.type),
      openingBalance: 25,
      formatAmount,
      fxNote: null,
    });

    expect(rows[0]).toEqual(["Ledger", "Type", "Debit", "Credit", "Running Balance", "Date", "Notes"]);
    expect(rows[1]).toEqual(["Alpha Agent", "Opening Balance", "", "", "$25.00", "20 Aug 2026", ""]);
    expect(rows[2]).toEqual(["Alpha Agent", "Journal", "$30.00", "$5.00", "$50.00", "20 Aug 2026", "Agent sale"]);
    expect(rows[3]).toEqual(["Alpha Agent", "Receipt", "", "$20.00", "$30.00", "21 Aug 2026", "Payment received"]);
  });

  it("adds an FX-rate column and note row when exporting in a converted currency", () => {
    const rows = buildAgentStatementExcelRows({
      account,
      vouchersWithBalance: computeRunningBalances(vouchers, 25, account.type),
      openingBalance: 25,
      formatAmount,
      fxNote: "EUR @ rate 0.92 per USD",
    });

    expect(rows[0]).toEqual(["Ledger", "Type", "Debit", "Credit", "Running Balance", "Date", "Notes", "FX Rate"]);
    expect(rows[1]).toEqual(["", "", "", "", "", "", "", "EUR @ rate 0.92 per USD"]);
  });

  it("falls back to the narration when the description is empty", () => {
    const rows = buildAgentStatementExcelRows({
      account,
      vouchersWithBalance: computeRunningBalances(vouchers, 0, account.type),
      openingBalance: 0,
      formatAmount,
      fxNote: null,
    });
    expect(rows[3][6]).toBe("Payment received");
  });
});
