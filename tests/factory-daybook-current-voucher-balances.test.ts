import { afterEach, describe, expect, it, vi } from "vitest";
import {
  factoryVoucherBalanceEntries,
  factoryVoucherBalanceUrl,
  fetchFactoryVoucherCurrentBalances,
} from "../client/src/pages/factory/daybook/entry-views/voucherBalances";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Factory Daybook voucher current ledger balances", () => {
  it("fetches the book balance of every Journal account and preserves signed values", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const balance = url.includes("/101/") ? -582900 : -234519;
      return { ok: true, json: async () => ({ balance }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const balances = await fetchFactoryVoucherCurrentBalances("JOURNAL", [
      { id: 1, ledgerAccountId: 101, debitAmount: "30000", creditAmount: "0" },
      { id: 2, ledgerAccountId: 102, debitAmount: "0", creditAmount: "30000" },
    ]);

    expect(balances).toEqual({
      sourceBalance: null,
      entryBalances: { 1: "-582900", 2: "-234519" },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/accounts/ledger/101/balance?balanceBasis=book",
      "/api/accounts/ledger/102/balance?balanceBasis=book",
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ credentials: "include", cache: "no-store" });
    }
  });

  it("shows payment source and destination balances using current values, without a voucher-date cutoff", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ balance: url.includes("/9/") ? 9000 : 0 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const entries = [
      { id: 1, ledgerAccountId: 9, debitAmount: "0", creditAmount: "36000" },
      { id: 2, ledgerAccountId: 10, debitAmount: "36000", creditAmount: "0" },
    ];
    expect(factoryVoucherBalanceEntries("PAYMENT", entries).displayEntries.map((e) => e.id)).toEqual([2]);
    const balances = await fetchFactoryVoucherCurrentBalances("PAYMENT", entries);
    expect(balances).toEqual({ sourceBalance: "9000", entryBalances: { 2: "0" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("asOf="))).toBe(true);
  });

  it("deduplicates account requests and returns unavailable, not fake zeros, on failures", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const balances = await fetchFactoryVoucherCurrentBalances("JOURNAL", [
      { id: 1, bankAccountId: 99 },
      { id: 2, bankAccountId: 99 },
    ]);
    expect(balances.entryBalances).toEqual({ 1: null, 2: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles customer/factory supplier accounts and does not fetch missing IDs", async () => {
    expect(factoryVoucherBalanceUrl({ id: 1, ledgerAccountId: 0 })).toBeNull();
    expect(factoryVoucherBalanceUrl({ id: 2, customerId: 8 })).toBe("/api/customers/8/balance");
    expect(factoryVoucherBalanceUrl({ id: 3, factorySupplierId: 4 })).toBe("/api/factory/suppliers/4/balance");

    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ balance: url.includes("customers") ? "125" : "65" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const balances = await fetchFactoryVoucherCurrentBalances("JOURNAL", [
      { id: 1, ledgerAccountId: 0 },
      { id: 2, customerId: 8 },
      { id: 3, factorySupplierId: 4 },
    ]);
    expect(balances.entryBalances).toEqual({ 1: null, 2: "125", 3: "65" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
