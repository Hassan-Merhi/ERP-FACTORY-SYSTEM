import { describe, expect, it } from "vitest";

import {
  accountDisplayBalance,
  calculateAbsoluteTotal,
  calculateCashTotal,
  calculateNetAccountTotal,
  debitSignedBalance,
  calculatePLTotal,
  cashSignedBalance,
  calculateTotal,
  formatCurrency,
  formatSignedSmartCurrency,
  formatSmartCurrency,
  groupAccountsByParent,
  isVisibleAnalyticsAssetAccount,
  parseBalance,
  signedBalance,
} from "@/pages/analyticslegacy/accountMath";
import type { Account } from "@/pages/analyticslegacy/types";

/**
 * These functions lived as closures inside the Analytics component, so the only
 * thing that ever exercised them was rendering the page. The hierarchical
 * deduplication in particular is easy to get wrong in a way no snapshot would
 * catch - a parent counted alongside its children double-counts the money.
 */
const account = (over: Partial<Account> & Pick<Account, "accountId">): Account =>
  ({
    name: `Account ${over.accountId}`,
    type: "ledger",
    balance: 0,
    balanceSide: "Dr",
    parentId: null,
    ...over,
  }) as Account;

describe("analytics account math", () => {
  it("reads balances from either numbers or numeric strings", () => {
    expect(parseBalance(12.5)).toBe(12.5);
    expect(parseBalance("12.5")).toBe(12.5);
    expect(parseBalance("not a number")).toBe(0);
    expect(parseBalance(0)).toBe(0);
  });

  it("signs Cr positive and Dr negative", () => {
    expect(signedBalance(account({ accountId: 1, balance: 100, balanceSide: "Cr" }))).toBe(100);
    expect(signedBalance(account({ accountId: 2, balance: 100, balanceSide: "Dr" }))).toBe(-100);
  });

  it("treats an account whose parent is absent from the list as a root", () => {
    const { parentAccounts, accountMap } = groupAccountsByParent([
      account({ accountId: 1 }),
      account({ accountId: 2, parentId: 1 }),
      // parent 99 is not in this list, so 3 stands on its own
      account({ accountId: 3, parentId: 99 }),
    ]);

    expect(parentAccounts.map((a) => a.accountId)).toEqual([1, 3]);
    expect(accountMap.get(1)?.map((a) => a.accountId)).toEqual([2]);
    expect(accountMap.has(99)).toBe(false);
  });

  it("counts a parent's children instead of the parent, never both", () => {
    const accounts = [
      // parent's own balance is deliberately wrong to prove it is not used
      account({ accountId: 1, balance: 999, balanceSide: "Cr" }),
      account({ accountId: 2, parentId: 1, balance: 30, balanceSide: "Cr" }),
      account({ accountId: 3, parentId: 1, balance: 20, balanceSide: "Cr" }),
      account({ accountId: 4, balance: 5, balanceSide: "Cr" }),
    ];

    expect(calculateTotal(accounts)).toBe(55);
    expect(calculateAbsoluteTotal(accounts)).toBe(55);
  });

  it("uses absolute values for the absolute total and signed ones otherwise", () => {
    const accounts = [
      account({ accountId: 1, balance: 100, balanceSide: "Cr" }),
      account({ accountId: 2, balance: 40, balanceSide: "Dr" }),
    ];

    expect(calculateTotal(accounts)).toBe(60);
    expect(calculateAbsoluteTotal(accounts)).toBe(140);
  });

  it("treats cash debits as positive and cash credits as negative, including grouped children", () => {
    const accounts = [
      account({ accountId: 1, balance: 8375, balanceSide: "Dr" }),
      account({ accountId: 2, balance: "36940" as unknown as number, balanceSide: "Dr" }),
      account({ accountId: 3, balance: 288395, balanceSide: "Dr" }), // Group parent must not be added separately
      account({ accountId: 4, parentId: 3, balance: 288395, balanceSide: "Cr" }),
    ];
    expect(cashSignedBalance(accounts[0])).toBe(8375);
    expect(cashSignedBalance(accounts[3])).toBe(-288395);
    expect(calculateCashTotal(accounts)).toBe(-243080);
    expect(calculateAbsoluteTotal(accounts)).toBe(333710); // Other legacy panels remain unchanged
    expect(formatSignedSmartCurrency(calculateCashTotal(accounts))).toBe("-$243,080");
  });

  it("nets liabilities, assets, and loans/banks using debit-positive credit-negative signs", () => {
    const liabilities = [
      account({ accountId: 1, name: "Accrued Rent Payable", balance: "22200" as unknown as number, balanceSide: "Cr" }),
      account({ accountId: 2, balance: 1250, balanceSide: "Dr" }),
      account({ accountId: 3, name: "BANK LOAN", balance: 8230718.81, balanceSide: "Cr" }),
      account({ accountId: 4, balance: 112000, balanceSide: "Dr" }),
      account({ accountId: 5, balance: 540582.77, balanceSide: "Dr" }),
      account({ accountId: 6, balance: 7330, balanceSide: "Cr" }),
      account({ accountId: 7, balance: 15977.46, balanceSide: "Cr" }),
      account({ accountId: 8, balance: 416283.59, balanceSide: "Dr" }),
    ];
    expect(calculateAbsoluteTotal(liabilities)).toBeCloseTo(9346342.63, 2);
    expect(calculateNetAccountTotal(liabilities)).toBeCloseTo(-7206109.91, 2);
    expect(formatSignedSmartCurrency(calculateNetAccountTotal(liabilities))).toBe("-$7,206,109.91");

    const assets = [
      account({ accountId: 9, balance: 100, balanceSide: "Dr" }),
      account({ accountId: 10, balance: 20, balanceSide: "CR" }),
    ];
    expect(debitSignedBalance(assets[1])).toBe(-20);
    expect(calculateNetAccountTotal(assets)).toBe(80);
    expect(calculateNetAccountTotal([account({ accountId: 11, type: "bank", balance: 50, balanceSide: "Cr" })])).toBe(-50);
  });

  it("never confuses bank and fixed-asset IDs with ledger group IDs", () => {
    const accounts = [
      account({ accountId: 11, type: "ledger", balance: 999, balanceSide: "Dr" }),
      account({ accountId: 12, type: "ledger", parentId: 11, balance: 100, balanceSide: "Cr" }),
      account({ accountId: 11, type: "bank", balance: 15, balanceSide: "Dr", parentId: undefined }),
      account({ accountId: 12, type: "fixedAsset", balance: 20, balanceSide: "Dr", parentId: undefined }),
    ];
    const { parentAccounts, accountMap } = groupAccountsByParent(accounts);
    expect(parentAccounts).toHaveLength(3);
    expect(accountMap.get(11)).toHaveLength(1);
    expect(calculateNetAccountTotal(accounts)).toBe(-65);
  });

  it("nets nested ledger groups without adding intermediate subtotals again", () => {
    const accounts = [
      account({ accountId: 1, balance: 999, balanceSide: "Cr" }),
      account({ accountId: 2, parentId: 1, balance: 888, balanceSide: "Cr" }),
      account({ accountId: 3, parentId: 2, balance: 100, balanceSide: "Dr" }),
      account({ accountId: 4, parentId: 2, balance: 25, balanceSide: "Cr" }),
      account({ accountId: 5, balance: 20, balanceSide: "Dr" }),
    ];
    const { parentAccounts, accountMap } = groupAccountsByParent(accounts);
    expect(accountDisplayBalance(parentAccounts[0], accountMap)).toBe(75);
    expect(calculateNetAccountTotal(accounts)).toBe(95);
  });

  it("hides only Inventory and SP profit correction suspense from the Assets view and total", () => {
    const candidates = [
      account({ accountId: 10, type: "ledger", code: "INVENTORY", name: "Inventory", accountType: "Asset", balance: 40.36 }),
      account({
        accountId: 11, type: "ledger", code: "SP-PROFIT-ADJ-SUSPENSE", name: "SP Profit Correction Suspense",
        accountType: "Asset", subType: "sp_profit_correction_suspense", balance: 9026.41,
      }),
      account({ accountId: 12, type: "ledger", code: "STOCK-OTW", name: "Stock OTW", accountType: "Asset", balance: 34498.20 }),
      account({ accountId: 13, type: "ledger", code: "INVENTORY-ADJUSTMENT", name: "Inventory Adjustment", accountType: "Asset", balance: 5 }),
      account({ accountId: 14, type: "bank", code: "B-1", name: "Bank", balance: 100 }),
      account({ accountId: 15, type: "fixedAsset", code: "F-1", name: "Vehicle", balance: 200 }),
      account({ accountId: 16, type: "ledger", code: "LIABILITY", name: "Liability", accountType: "Liability", balance: 500 }),
    ];
    const visible = candidates.filter(isVisibleAnalyticsAssetAccount);
    expect(visible.map((acc) => acc.accountId)).toEqual([12, 13, 14, 15]);
    expect(calculateAbsoluteTotal(visible)).toBeCloseTo(34803.20, 2);
    expect(calculateAbsoluteTotal(visible.filter((acc) => acc.type === "ledger"))).toBeCloseTo(34503.20, 2);

    // Legacy records without the expected code still match their exact label/subtype.
    expect(isVisibleAnalyticsAssetAccount(account({
      accountId: 17, type: "ledger", code: "", name: "  SP   Profit Correction Suspense ",
      accountType: "Asset", balance: 1,
    }))).toBe(false);
    expect(isVisibleAnalyticsAssetAccount(account({
      accountId: 18, type: "ledger", code: "", name: "Another control ledger",
      subType: "sp_profit_correction_suspense", accountType: "Asset", balance: 1,
    }))).toBe(false);
  });

  it("sums P&L sections flat, without deduplication", () => {
    // Same parent/child shape as above, but P&L sections are flat so both count.
    expect(
      calculatePLTotal([
        account({ accountId: 1, balance: 100, balanceSide: "Cr" }),
        account({ accountId: 2, parentId: 1, balance: 30, balanceSide: "Dr" }),
      ])
    ).toBe(70);
  });

  it("drops decimals on whole amounts and always formats the magnitude", () => {
    expect(formatCurrency(1500)).toBe("$1,500");
    expect(formatCurrency(1500.5)).toBe("$1,500.50");
    expect(formatCurrency(-1500)).toBe("$1,500");

    expect(formatSmartCurrency(1500)).toBe("$1,500");
    expect(formatSmartCurrency(1500.5)).toBe("$1,500.50");
    expect(formatSmartCurrency(-1500.5)).toBe("$1,500.50");
    expect(formatSignedSmartCurrency(-1500.5)).toBe("-$1,500.50");
    expect(formatSignedSmartCurrency(1500.5)).toBe("$1,500.50");
  });
});
