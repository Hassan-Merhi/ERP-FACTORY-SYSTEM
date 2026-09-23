/**
 * The balance shown next to the Paid From / Received Into account while a
 * voucher is entered. The server-computed sidebar balance wins; otherwise the
 * hook derives it per account type with that type's sign convention —
 * debit-positive for ledgers, customers and fixed assets, credit-positive for
 * suppliers and employees — plus per-currency balances for suppliers.
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAccountBalance } from "@/pages/vouchers/useAccountBalance";

function respond(routes: Record<string, unknown>) {
  const calls: string[] = [];
  (global as any).fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const body = routes[url];
    return { ok: body !== undefined, json: async () => body };
  });
  return calls;
}

function run(props: Partial<Parameters<typeof useAccountBalance>[0]>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useAccountBalance({
        paymentAccountType: "ledger",
        paymentAccountId: 1,
        bankAccounts: [],
        ...props,
      } as any),
    { wrapper }
  );
}

const tx = [
  { debitAmount: "100", creditAmount: "0", currency: "USD" },
  { debitAmount: "0", creditAmount: "30", currency: "USD" },
];

describe("useAccountBalance", () => {
  it("uses the sidebar balance and fetches nothing when the account is listed", async () => {
    const calls = respond({});
    const { result } = run({
      paymentAccountType: "ledger",
      paymentAccountId: 5,
      sidebarAccounts: [{ id: 5, type: "ledger", balance: 812.5 } as any],
    });
    expect(result.current.accountBalance).toBe(812.5);
    expect(result.current.sidebarAccount).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it("reads a bank balance from the loaded bank list", async () => {
    respond({});
    const { result } = run({
      paymentAccountType: "bank",
      paymentAccountId: 2,
      bankAccounts: [{ id: 2, balance: "44.5" } as any],
    });
    await waitFor(() => expect(result.current.accountBalance).toBe(44.5));
  });

  it("derives a ledger balance debit-positive from a Cr opening balance", async () => {
    respond({
      "/api/ledger-accounts/1": { openingBalance: "50", openingBalanceSide: "Cr" },
      "/api/accounts/ledger/1/transactions": tx,
    });
    const { result } = run({ paymentAccountType: "ledger", paymentAccountId: 1 });
    await waitFor(() => expect(result.current.accountBalance).toBe(20));
  });

  it("derives a supplier balance credit-positive and splits it by currency", async () => {
    respond({
      "/api/suppliers/3": { openingBalance: "10" },
      "/api/accounts/supplier/3/transactions": [
        { debitAmount: "20", creditAmount: "0", currency: "USD" },
        { debitAmount: "0", creditAmount: "70", currency: "USD" },
        { debitAmount: "0", creditAmount: "500", currency: "CFA" },
      ],
    });
    const { result } = run({ paymentAccountType: "supplier", paymentAccountId: 3 });
    await waitFor(() => expect(result.current.accountBalance).toBe(560));
    await waitFor(() =>
      expect(result.current.accountCurrencyBalances).toEqual([
        { currency: "USD", balance: 60 },
        { currency: "CFA", balance: 500 },
      ])
    );
  });

  it("reports no currency split for a USD-only supplier", async () => {
    respond({
      "/api/suppliers/3": { openingBalance: "0" },
      "/api/accounts/supplier/3/transactions": tx,
    });
    const { result } = run({ paymentAccountType: "supplier", paymentAccountId: 3 });
    await waitFor(() => expect(result.current.accountBalance).toBe(-70));
    await waitFor(() => expect(result.current.accountCurrencyBalances).toBeNull());
  });

  it("derives employee (credit-positive) and fixed-asset (debit-positive) balances from the opening balance", async () => {
    respond({
      "/api/accounts/employee/4/transactions": tx,
      "/api/accounts/fixed-asset/6/transactions": tx,
    });
    const employee = run({ paymentAccountType: "employee", paymentAccountId: 4, selectedAccountOpeningBalance: "5" });
    const asset = run({ paymentAccountType: "fixedAsset", paymentAccountId: 6, selectedAccountOpeningBalance: "5" });
    await waitFor(() => expect(employee.result.current.accountBalance).toBe(-65));
    await waitFor(() => expect(asset.result.current.accountBalance).toBe(75));
  });

  it("derives a customer balance debit-positive", async () => {
    respond({
      "/api/customers/7": { openingBalance: "1" },
      "/api/accounts/customer/7/transactions": tx,
    });
    const { result } = run({ paymentAccountType: "customer", paymentAccountId: 7 });
    await waitFor(() => expect(result.current.accountBalance).toBe(71));
  });

  it("uses the factory supplier's outstanding balance and multi-currency ledgers", async () => {
    respond({
      "/api/factory/suppliers/8/balance": { outstandingUsd: "123.45" },
      "/api/factory/suppliers/8/broker-statement": {
        currencyLedgers: [
          { currencyCode: "USD", netBalance: "100" },
          { currencyCode: "EUR", netBalance: "0.001" },
          { currencyCode: "CFA", netBalance: "9000" },
        ],
      },
    });
    const { result } = run({ paymentAccountType: "factorySupplier", paymentAccountId: 8 });
    await waitFor(() => expect(result.current.accountBalance).toBe(123.45));
    await waitFor(() =>
      expect(result.current.accountCurrencyBalances).toEqual([
        { currency: "USD", balance: 100 },
        { currency: "CFA", balance: 9000 },
      ])
    );
  });

  it("does not query without an account selected", async () => {
    const calls = respond({});
    const { result } = run({ paymentAccountType: "supplier", paymentAccountId: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
    expect(result.current.accountBalance).toBe(0);
  });
});
