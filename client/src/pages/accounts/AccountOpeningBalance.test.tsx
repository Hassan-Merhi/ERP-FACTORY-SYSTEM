import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AccountTransactionRows } from "./AccountTransactionRows";
import type { AccountStatementRow } from "./AccountTransactionRows";
import type { Account } from "./accountTypes";

afterEach(cleanup);

function renderStatement(openingBalance: number, hideBalances = false) {
  const transaction = {
    voucherId: 1,
    entryId: 1,
    voucherNumber: "JV-1",
    voucherType: "Journal",
    voucherDate: "2026-01-02",
    voucherDescription: "First payment",
    totalDebit: 100,
    totalCredit: 0,
    runningBalance: openingBalance + 100,
  } as AccountStatementRow;
  render(
    <AccountTransactionRows
      vouchersWithBalance={[transaction]}
      selectedVoucherIds={new Set()}
      toggleSelectAll={vi.fn()}
      toggleVoucherSelection={vi.fn()}
      handleOpenVoucher={vi.fn()}
      formatAmount={(amount) => `$${amount.toFixed(2)}`}
      hideBalances={hideBalances}
      appMode="erp"
      openingBalance={openingBalance}
      closingBalance={openingBalance + 100}
      selectedAccount={{ type: "ledger", accountId: 101, name: "Example" } as Account}
      formatDisplayDate={(date) => String(date)}
    />,
  );
}

describe("account statement opening balance", () => {
  it("renders the opening balance before the first transaction, with its Dr/Cr side", () => {
    renderStatement(-250);
    const opening = screen.getByTestId("row-opening-balance");
    const body = opening.closest("tbody");
    expect(body?.firstElementChild).toBe(opening);
    expect(opening).toHaveTextContent("Opening Balance");
    expect(opening).toHaveTextContent("$250.00");
    expect(opening).toHaveTextContent("Cr");
    expect(screen.getByTestId("row-voucher-1")).toHaveTextContent("First payment");
  });

  it("does not reveal account balances when balances are hidden", () => {
    renderStatement(250, true);
    expect(screen.queryByTestId("row-opening-balance")).toBeNull();
  });

  it("keeps the opening row visible in the ledger theme", () => {
    const css = readFileSync("client/src/pages/accounts/propertiesLedger.css", "utf8");
    expect(css).toContain('tbody tr[data-testid="row-opening-balance"]');
    expect(css).not.toMatch(/\[data-testid="row-opening-balance"\]\s*\{\s*display:\s*none/);
  });

  it("includes the brought-forward balance in both desktop and phone KPI summaries", () => {
    const source = readFileSync("client/src/pages/accounts/AccountStatementView.tsx", "utf8");
    expect(source).toContain('data-testid="account-statement-kpi-opening-balance"');
    expect(source).toContain('label: showNativeBalance ? "Historical USD opening" : "Opening Balance"');
    expect(source).toContain("formatAmount(Math.abs(openingBalance))");
  });
});
