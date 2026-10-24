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
import { outstandingSaleCredit, type RetailPaymentDraft } from "@/pages/pos/retailPosTypes";

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
      { method: "cash", amount: 40, tenderedAmount: 40 },
    ]);
  });

  it("offers customer credit only when a customer is selected", () => {
    const { unmount } = render(
      <Harness total={10} initial={[{ method: "cash", amount: 10, tenderedAmount: 10 }]} onChange={() => {}} />
    );
    expect((screen.getByRole("option", { name: /customer credit/i }) as HTMLOptionElement).disabled).toBe(true);
    unmount();
    render(
      <Harness
        total={10}
        initial={[{ method: "cash", amount: 10, tenderedAmount: 10 }]}
        canUseCredit
        onChange={() => {}}
      />
    );
    expect((screen.getByRole("option", { name: /customer credit/i }) as HTMLOptionElement).disabled).toBe(false);
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
