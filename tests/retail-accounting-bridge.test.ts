import { describe, expect, it } from "vitest";
import { buildRetailAccountingEntries, type RetailAccountMap } from "../server/services/retail/retailAccountingBridge";

const accounts: RetailAccountMap = {
  cash: 1,
  card_clearing: 2,
  bank: 3,
  sales_revenue: 4,
  inventory_asset: 5,
  cogs: 6,
  discounts: 7,
  tax_payable: 8,
  store_credit_liability: 9,
};

function totals(entries: Array<{ debitAmount?: string; creditAmount?: string }>) {
  return entries.reduce(
    (result, entry) => ({
      debit: result.debit + Number(entry.debitAmount ?? 0),
      credit: result.credit + Number(entry.creditAmount ?? 0),
    }),
    { debit: 0, credit: 0 }
  );
}

describe("Retail accounting bridge", () => {
  it("builds balanced split-payment sale entries with revenue, discount, tax and cost snapshots", () => {
    const built = buildRetailAccountingEntries({
      saleId: 42,
      postingType: "sale",
      amounts: {
        subtotalAmount: "20.00",
        discountAmount: "2.00",
        taxAmount: "1.00",
        totalAmount: "19.00",
        cogsAmount: "8.00",
      },
      payments: [
        { method: "cash", amount: "9.00" },
        { method: "card", amount: "10.00" },
      ],
      accounts,
    });
    const sum = totals(built.entries);
    expect(sum.debit).toBeCloseTo(29, 2);
    expect(sum.credit).toBeCloseTo(29, 2);
    expect(built.debitTotal).toBe("29.00");
    expect(built.entries.every((entry) => entry.narration?.includes("Retail Sale #42"))).toBe(true);
    expect(built.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ledgerAccountId: accounts.cash, debitAmount: "9.00" }),
        expect.objectContaining({ ledgerAccountId: accounts.card_clearing, debitAmount: "10.00" }),
        expect.objectContaining({ ledgerAccountId: accounts.sales_revenue, creditAmount: "20.00" }),
        expect.objectContaining({ ledgerAccountId: accounts.cogs, debitAmount: "8.00" }),
        expect.objectContaining({ ledgerAccountId: accounts.inventory_asset, creditAmount: "8.00" }),
      ])
    );
  });

  it("reverses refund rails and exchanges by reversing old balances without changing snapshots", () => {
    const built = buildRetailAccountingEntries({
      saleId: 51,
      postingType: "return",
      amounts: {
        subtotalAmount: "10.00",
        discountAmount: "1.00",
        taxAmount: "0.50",
        totalAmount: "9.50",
        cogsAmount: "4.00",
      },
      payments: [{ method: "store_credit", amount: "-9.50" }],
      accounts,
    });
    const sum = totals(built.entries);
    expect(sum.debit).toBeCloseTo(14.5, 2);
    expect(sum.credit).toBeCloseTo(14.5, 2);
    expect(built.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ledgerAccountId: accounts.store_credit_liability, creditAmount: "9.50" }),
        expect.objectContaining({ ledgerAccountId: accounts.sales_revenue, debitAmount: "10.00" }),
        expect.objectContaining({ ledgerAccountId: accounts.discounts, creditAmount: "1.00" }),
        expect.objectContaining({ ledgerAccountId: accounts.tax_payable, debitAmount: "0.50" }),
        expect.objectContaining({ ledgerAccountId: accounts.inventory_asset, debitAmount: "4.00" }),
        expect.objectContaining({ ledgerAccountId: accounts.cogs, creditAmount: "4.00" }),
      ])
    );
    expect(() =>
      buildRetailAccountingEntries({
        saleId: 51,
        postingType: "cancellation",
        amounts: {
          subtotalAmount: "1.00",
          discountAmount: "0.00",
          taxAmount: "0.00",
          totalAmount: "1.00",
          cogsAmount: "0.00",
        },
        payments: [{ method: "cash", amount: "1.00" }],
        accounts,
      })
    ).toThrow("must be negative");
  });
});
