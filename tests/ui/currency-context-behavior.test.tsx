/**
 * CurrencyContext formats every amount in the app. These cases run the real
 * provider against seeded company, exchange-rate and preference queries and pin
 * the rules its doc comments promise:
 *
 *  - formatAmount converts USD to CFA at the current rate, and falls back to
 *    USD (never a CFA figure computed with no rate) when the rate is missing
 *  - formatHistoricalBaseAmount never re-translates, whatever the display mode
 *  - formatCashAmount follows the company base currency (USD vs CFA ledgers)
 *  - the user's saved preference wins over local storage, and toggling saves it
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiRequest = vi.hoisted(() => vi.fn(async () => new Response("{}")));
vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest };
});
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 1, name: "Co" } }),
}));

import { CurrencyProvider, useCurrencyContext } from "@/contexts/CurrencyContext";

const n = (v: number, dp: number) =>
  v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

function setup({
  base = "USD",
  display = "CFA" as string | null,
  rate = "600" as string | null,
  preferred,
}: { base?: string; display?: string | null; rate?: string | null; preferred?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: () => new Promise(() => {}) } },
  });
  client.setQueryData(["/api/companies/1"], { id: 1, baseCurrency: base, displayCurrency: display ?? "none" });
  client.setQueryData(["/api/user-preferences"], { dateFormat: "MM/DD/YYYY", preferredCurrency: preferred });
  if (display) client.setQueryData(["/api/exchange-rates/latest", 1, base, display], rate ? { rate } : null);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <CurrencyProvider>{children}</CurrencyProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useCurrencyContext(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
  apiRequest.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("CurrencyContext", () => {
  it("exposes company currencies and the current rate", () => {
    const { result } = setup();
    expect(result.current.baseCurrency).toBe("USD");
    expect(result.current.displayCurrency).toBe("CFA");
    expect(result.current.isMultiCurrency).toBe(true);
    expect(result.current.exchangeRate).toBe(600);
    expect(result.current.isLoadingCompany).toBe(false);
  });

  it("formats USD with cents only when there are cents", () => {
    const { result } = setup();
    expect(result.current.formatAmount(1200)).toBe(`$ ${n(1200, 0)}`);
    expect(result.current.formatAmount("10.5")).toBe(`$ ${n(10.5, 2)}`);
    expect(result.current.formatAmount(null)).toBe("");
    expect(result.current.formatAmount("abc")).toBe("");
  });

  it("converts to CFA at the current rate and rounds to whole francs", () => {
    const { result } = setup();
    expect(result.current.formatAmount(10.5, "CFA")).toBe(`CFA ${n(6300, 0)}`);
    expect(result.current.convertToUSD(600)).toBe(1);
  });

  it("falls back to USD rather than inventing a CFA amount when no rate exists", () => {
    const { result } = setup({ rate: null });
    expect(result.current.exchangeRate).toBeNull();
    expect(result.current.formatAmount(10, "CFA")).toBe(`$ ${n(10, 0)}`);
    expect(result.current.convertToDisplay(10)).toBe(10);
  });

  it("never re-translates historical base amounts, even in CFA mode", async () => {
    const { result } = setup({ preferred: "CFA" });
    await waitFor(() => expect(result.current.selectedCurrency).toBe("CFA"));
    expect(result.current.formatHistoricalBaseAmount(25)).toBe(`$ ${n(25, 0)}`);
    expect(result.current.convertToDisplay(2)).toBe(1200);
  });

  it("formats cash on a USD ledger in the selected mode", async () => {
    const { result } = setup();
    expect(result.current.formatCashAmount(2)).toBe(`$ ${n(2, 0)}`);
    act(() => result.current.setCurrency("CFA"));
    expect(result.current.formatCashAmount(2)).toBe(`CFA ${n(1200, 0)}`);
  });

  it("formats cash on a CFA ledger by dividing for USD", () => {
    const { result } = setup({ base: "CFA", display: "USD", rate: "500" });
    expect(result.current.formatCashAmount(1000)).toBe(`$ ${n(2, 0)}`);
    act(() => result.current.setCurrency("CFA"));
    expect(result.current.formatCashAmount(1000)).toBe(`CFA ${n(1000, 0)}`);
  });

  it("formats raw and transaction-currency amounts without conversion", () => {
    const { result } = setup();
    expect(result.current.formatAmountRaw(5000)).toBe(`$ ${n(5000, 0)}`);
    act(() => result.current.setCurrency("CFA"));
    expect(result.current.formatAmountRaw(5000.4)).toBe(`CFA ${n(5000, 0)}`);
    expect(result.current.formatTransactionAmount(7.25, "usd")).toBe(`$ ${n(7.25, 2)}`);
    expect(result.current.formatTransactionAmount(9000, "XOF")).toBe(`CFA ${n(9000, 0)}`);
    expect(result.current.formatTransactionAmount(undefined, "USD")).toBe("");
  });

  it("translates native cash balances at the current rate for display only", () => {
    const { result } = setup();
    expect(result.current.formatCurrentCashTranslation(6000, "CFA")).toBe(`$ ${n(10, 0)}`);
    expect(result.current.formatCurrentCashTranslation(3, "USD")).toBe(`$ ${n(3, 0)}`);
    act(() => result.current.setCurrency("CFA"));
    expect(result.current.formatCurrentCashTranslation(6000, "CFA")).toBe(`CFA ${n(6000, 0)}`);
  });

  it("previews a new transaction in both currencies", () => {
    const { result } = setup();
    expect(result.current.formatNewTransactionPreview(2)).toBe(`$ ${n(2, 0)} ≈ CFA ${(1200).toLocaleString()}`);
    expect(result.current.formatNewTransactionPreview(0)).toBe("");
    act(() => result.current.setCurrency("CFA"));
    expect(result.current.formatNewTransactionPreview(300)).toBe(`CFA ${n(300, 0)} ≈ $ ${n(0.5, 2)}`);
  });

  it("is single-currency when the company has no display currency", () => {
    const { result } = setup({ display: null });
    expect(result.current.isMultiCurrency).toBe(false);
    expect(result.current.displayCurrency).toBeNull();
    expect(result.current.formatNewTransactionPreview(4)).toBe(`$ ${n(4, 0)}`);
  });

  it("toggles, persists locally and saves the preference to the server", async () => {
    const { result } = setup();
    act(() => result.current.toggleCurrency());
    expect(result.current.selectedCurrency).toBe("CFA");
    expect(localStorage.getItem("selectedCurrency")).toBe("CFA");
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("PUT", "/api/user-preferences", { preferredCurrency: "CFA" })
    );
  });

  it("restores the locally stored currency before preferences load", () => {
    localStorage.setItem("selectedCurrency", "CFA");
    const { result } = setup();
    expect(result.current.selectedCurrency).toBe("CFA");
  });

  it("throws when used outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useCurrencyContext())).toThrow(/within a CurrencyProvider/);
  });
});
