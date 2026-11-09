import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AccountTransactionRows } from "./AccountTransactionRows";
import type { AccountStatementRow } from "./AccountTransactionRows";
import type { Account } from "./accountTypes";
import {
  AccountStatementOpeningBalanceKpi,
  OpeningBalanceAmount,
  openingBalanceLabel,
} from "./AccountStatementOpeningBalance";
import ledgerThemeCss from "./propertiesLedger.css?raw";

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
    />
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
    // Apply the real ledger stylesheet and check the row's computed style.
    const style = document.createElement("style");
    style.textContent = ledgerThemeCss;
    document.head.appendChild(style);
    const container = document.createElement("div");
    container.className = "account-ledger-modern";
    container.innerHTML =
      '<div data-testid="account-statement-scroll-region"><table><tbody>' +
      '<tr data-testid="row-opening-balance"><td>Opening Balance</td></tr>' +
      "</tbody></table></div>";
    document.body.appendChild(container);
    try {
      const row = container.querySelector('[data-testid="row-opening-balance"]') as HTMLElement;
      const computed = getComputedStyle(row);
      expect(computed.display).not.toBe("none");
      expect(computed.visibility).not.toBe("hidden");
    } finally {
      document.head.removeChild(style);
      document.body.removeChild(container);
    }
  });

  it("includes the brought-forward balance in both desktop and phone KPI summaries", () => {
    const formatAmount = (amount: number) => `$${amount.toFixed(2)}`;
    render(
      <AccountStatementOpeningBalanceKpi
        showNativeBalance={false}
        openingBalance={-250}
        side="Cr"
        formatAmount={formatAmount}
      />
    );
    const kpi = screen.getByTestId("account-statement-kpi-opening-balance");
    expect(kpi).toHaveTextContent("Opening Balance");
    expect(kpi).toHaveTextContent("$250.00");
    expect(kpi).toHaveTextContent("Cr");
    cleanup();

    render(
      <AccountStatementOpeningBalanceKpi showNativeBalance openingBalance={90} side="Dr" formatAmount={formatAmount} />
    );
    expect(screen.getByTestId("account-statement-kpi-opening-balance")).toHaveTextContent("Historical USD opening");
    cleanup();

    // The phone summary grid uses the same label and amount.
    expect(openingBalanceLabel(false)).toBe("Opening Balance");
    expect(openingBalanceLabel(true)).toBe("Historical USD opening");
    render(<OpeningBalanceAmount openingBalance={-12.5} side="Cr" formatAmount={formatAmount} />);
    expect(document.body).toHaveTextContent("$12.50Cr");
  });
});
