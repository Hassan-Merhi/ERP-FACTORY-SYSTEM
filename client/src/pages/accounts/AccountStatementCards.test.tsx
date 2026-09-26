import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStatementCards } from "./AccountStatementCards";
import type { AccountStatementRow } from "./AccountTransactionRows";
import type { Account } from "./accountTypes";

vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const row = (overrides: Partial<AccountStatementRow>): AccountStatementRow =>
  ({
    voucherId: 1,
    entryId: 1,
    voucherNumber: "JV-1",
    voucherType: "Journal",
    voucherDate: "2026-09-25",
    voucherDescription: "Receipt from Atlas",
    totalDebit: 0,
    totalCredit: 100,
    runningBalance: -100,
    ...overrides,
  }) as AccountStatementRow;

function renderCards(rows: AccountStatementRow[], onOpen = vi.fn()) {
  render(
    <AccountStatementCards
      vouchersWithBalance={rows}
      selectedVoucherIds={new Set()}
      handleOpenVoucher={onOpen}
      formatAmount={(amount) => `$${amount}`}
      hideBalances={false}
      openingBalance={50}
      closingBalance={-50}
      selectedAccount={{ type: "ledger", accountId: 1, name: "Atlas" } as Account}
      formatDisplayDate={(date) => String(date)}
    />
  );
  return onOpen;
}

describe("AccountStatementCards", () => {
  it("shows opening balance, a card per transaction and the closing balance", () => {
    renderCards([row({})]);
    expect(screen.getByTestId("card-opening-balance")).toHaveTextContent("$50");
    expect(screen.getByTestId("card-voucher-1")).toHaveTextContent("Receipt from Atlas");
    expect(screen.getByTestId("card-voucher-1")).toHaveTextContent("$100Cr");
    expect(screen.getByText("Closing Balance").nextElementSibling).toHaveTextContent("$50Cr");
  });

  it("opens the voucher when its card is tapped, but not historical references", () => {
    const onOpen = renderCards([row({}), row({ voucherId: -2, entryId: 2, voucherType: "Historical PO Reference" })]);
    fireEvent.click(screen.getByRole("button", { name: /Open voucher JV-1/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("card-historical-reference-2").querySelector("button")).toBeNull();
  });

  it("pages long statements", () => {
    renderCards(Array.from({ length: 130 }, (_, index) => row({ voucherId: index + 1, entryId: index + 1 })));
    expect(screen.getAllByTestId(/^card-voucher-/)).toHaveLength(100);
    fireEvent.click(screen.getByTestId("button-statement-show-more"));
    expect(screen.getAllByTestId(/^card-voucher-/)).toHaveLength(130);
  });
});
