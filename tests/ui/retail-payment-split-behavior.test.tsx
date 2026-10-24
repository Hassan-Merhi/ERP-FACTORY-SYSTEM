/**
 * Retail POS tenders: Split must turn the default single tender that already
 * covers the sale into two positive tenders with the same total (a zero-value
 * second tender cannot be posted), and an unallocated remainder becomes its own
 * tender. Customer credit is only selectable with a customer.
 *
 * outstandingSaleCredit is what the exchange dialog uses to show how much of a
 * return only reduces the customer's unpaid balance rather than paying cash.
 */
import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { RetailPaymentPanel } from "@/pages/pos/RetailPaymentPanel";
import { paymentAccountValue, paymentFromAccount, type RetailPaymentAccounts } from "@/pages/pos/RetailPaymentAccountSelect";
import { outstandingSaleCredit, type RetailPaymentDraft } from "@/pages/pos/retailPosTypes";

const accounts: RetailPaymentAccounts = {
  ledgers: [
    { id: 11, code: "C-001", name: "Main Cash", accountType: "Cash" },
    { id: 12, code: "B-001", name: "Bank Ledger", accountType: "Bank" },
  ],
  banks: [{ id: 21, code: "B-002", name: "Bank Current", }],
};

function Harness({
  total,
  initial,
  canUseCredit = false,
  onChange,
}: {
  total: number;
  initial: RetailPaymentDraft[];
  canUseCredit?: boolean;
  onChange: (payments: RetailPaymentDraft[]) => void;
}) {
  const [payments, setPayments] = useState(initial);
  return (
    <RetailPaymentPanel
      total={total}
      value={payments}
      canUseCredit={canUseCredit}
      accounts={accounts}
      customerName={canUseCredit ? "Test Customer" : null}
      onChange={(next) => {
        setPayments(next);
        onChange(next);
      }}
    />
  );
}

describe("RetailPaymentPanel Split", () => {
  it("splits a fully allocated $100 cash tender into two positive tenders totalling $100", () => {
    const changes: RetailPaymentDraft[][] = [];
    render(
      <Harness
        total={100}
        initial={[{ method: "cash", amount: 100, tenderedAmount: 100 }]}
        onChange={(next) => changes.push(next)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /split/i }));
    const next = changes.at(-1)!;
    expect(next).toHaveLength(2);
    expect(next.every((payment) => Number(payment.amount) > 0)).toBe(true);
    expect(next.reduce((sum, payment) => sum + Number(payment.amount), 0)).toBeCloseTo(100, 2);
  });

  it("adds the unallocated remainder as its own tender", () => {
    const changes: RetailPaymentDraft[][] = [];
    render(
      <Harness
        total={100}
        initial={[{ method: "card", amount: 60, tenderedAmount: null }]}
        onChange={(next) => changes.push(next)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /split/i }));
    expect(changes.at(-1)).toEqual([
      { method: "card", amount: 60, tenderedAmount: null },
      { method: "cash", amount: 40, tenderedAmount: null },
    ]);
  });

  it("offers customer credit only when a customer is selected", () => {
    const { unmount } = render(
      <Harness total={10} initial={[{ method: "cash", amount: 10, tenderedAmount: 10 }]} onChange={() => {}} />
    );
    expect(screen.queryByRole("option", { name: /customer credit/i })).toBeNull();
    unmount();
    render(
      <Harness
        total={10}
        initial={[{ method: "cash", amount: 10, tenderedAmount: 10 }]}
        canUseCredit
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("option", { name: /customer credit/i })).toBeTruthy();
  });
});

describe("Retail money account selection", () => {
  it("posts to a chosen cash ledger or bank account with no stale destination IDs", () => {
    const cash = paymentFromAccount("ledger:11", 75, accounts);
    const bank = paymentFromAccount("bank:21", 75, accounts);
    expect(cash).toMatchObject({ method: "cash", ledgerAccountId: 11, amount: 75 });
    expect(bank).toMatchObject({ method: "bank", bankAccountId: 21, amount: 75 });
    expect(paymentAccountValue(bank)).toBe("bank:21");
    expect(bank.ledgerAccountId).toBeUndefined();
    expect(paymentFromAccount("credit", 10, accounts)).toEqual({ method: "credit", amount: 10, tenderedAmount: null });
    expect(() => paymentFromAccount("ledger:999", 10, accounts)).toThrow();
  });

  it("changes from cash to bank without retaining the prior payment ledger", () => {
    const changes: RetailPaymentDraft[][] = [];
    render(
      <Harness
        total={100}
        initial={[paymentFromAccount("ledger:11", 100, accounts)]}
        onChange={(next) => changes.push(next)}
      />
    );
    fireEvent.change(screen.getByRole("combobox", { name: /account/i }), { target: { value: "bank:21" } });
    expect(changes.at(-1)?.[0]).toMatchObject({ method: "bank", bankAccountId: 21, amount: 100 });
    expect(changes.at(-1)?.[0].ledgerAccountId).toBeUndefined();
  });
});

describe("outstandingSaleCredit", () => {
  const payment = (method: string, paymentType: string, amount: number) => ({
    id: 0,
    method: method as RetailPaymentDraft["method"],
    paymentType,
    amount,
    tenderedAmount: null,
    changeAmount: 0,
    reference: null,
    shiftId: null,
  });

  it("is the on-account tender less receivable reversals, ignoring cash and account credits", () => {
    expect(
      outstandingSaleCredit({
        payments: [
          payment("cash", "payment", 60),
          payment("credit", "payment", 40),
          payment("credit", "refund", 30),
          payment("store_credit", "refund", 5),
        ],
      })
    ).toBe(10);
    expect(outstandingSaleCredit({ payments: [payment("cash", "payment", 100)] })).toBe(0);
    expect(outstandingSaleCredit({})).toBe(0);
  });
});
