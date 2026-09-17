import { describe, expect, it } from "vitest";
import { classifyEquityAccounts, classifyNetPositionAccounts } from "../server/netPositionHelper";

const account = (overrides: Record<string, unknown>) => ({
  id: 1,
  name: "Test account",
  code: "TEST",
  accountType: "Asset",
  openingBalance: "0",
  openingBalanceSide: "Dr",
  ...overrides,
});

describe("net position account classification", () => {
  it("treats the canonical plural Loans type as a liability", () => {
    const result = classifyNetPositionAccounts(
      [account({ id: 2979, name: "Hassan Savings", accountType: "Loans" })],
      new Map([[2979, { debit: 0, credit: 28250 }]])
    );

    expect(result.forUsTotal).toBe(0);
    expect(result.onUsTotal).toBe(28250);
    expect(result.onUsAccounts[0]).toMatchObject({
      id: 2979,
      name: "Hassan Savings",
      value: 28250,
      category: "Loans",
    });
  });

  it("returns equity balances separately without adding them to net position", () => {
    const accounts = [
      account({
        id: 2977,
        name: "Fresh Start FZ Equity",
        accountType: "Equity",
        openingBalance: "207997",
        openingBalanceSide: "Dr",
      }),
      account({
        id: 2978,
        name: "Hassan Dakik Equity",
        accountType: "Equity",
        openingBalance: "289242",
        openingBalanceSide: "Dr",
      }),
    ];
    const balances = new Map<number, { debit: number; credit: number }>();

    const netPosition = classifyNetPositionAccounts(accounts, balances);
    const equity = classifyEquityAccounts(accounts, balances);

    expect(netPosition.forUsTotal).toBe(0);
    expect(netPosition.onUsTotal).toBe(0);
    expect(equity.total).toBe(497239);
    expect(equity.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 2977, value: 207997, balanceSide: "Dr" }),
        expect.objectContaining({ id: 2978, value: 289242, balanceSide: "Dr" }),
      ])
    );
  });

  it("excludes current and legacy account migration clearing accounts from net position presentation", () => {
    const accounts = [
      account({
        id: 3348,
        name: "Account Migration Clearing - HASSAN PROPERTIES",
        code: "3348",
        accountType: "Asset",
        openingBalance: "300000",
        openingBalanceSide: "Dr",
      }),
      account({
        id: 3328,
        name: "Account Migration Clearing TO - Hassan Properties",
        code: "3328",
        accountType: "Liability",
        openingBalance: "600000",
        openingBalanceSide: "Cr",
      }),
      account({
        id: 3350,
        name: "Internal migration balance",
        code: "AM-FROM-HASSAN",
        accountType: "Liability",
        subType: "account_migration_clearing",
        openingBalance: "125000",
        openingBalanceSide: "Cr",
      }),
      account({
        id: 4000,
        name: "Visible Cash",
        accountType: "Cash",
        openingBalance: "250",
        openingBalanceSide: "Dr",
      }),
    ];

    const result = classifyNetPositionAccounts(accounts, new Map());

    expect(result.forUsTotal).toBe(250);
    expect(result.onUsTotal).toBe(0);
    expect(result.forUsAccounts).toHaveLength(1);
    expect(result.forUsAccounts[0]).toMatchObject({ id: 4000, name: "Visible Cash", value: 250 });
    expect(result.onUsAccounts).toHaveLength(0);
  });
});
