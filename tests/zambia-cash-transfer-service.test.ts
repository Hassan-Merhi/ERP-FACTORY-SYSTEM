/**
 * Same-company USD <-> ZMW cash/bank transfers: request validation, the
 * approved-rate conversion and cent balancing, account ownership checks,
 * the verified-funds preflight (skipped on a retry) and the balanced voucher
 * handed to the posting engine. The database, rate policy, balances and
 * posting engine are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  executes: [] as unknown[],
  rate: vi.fn(),
  balances: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../server/db", () => {
  const select = () => {
    const rows = h.selects.shift() ?? [];
    const chain = { from: () => chain, where: () => chain, limit: async () => rows };
    return chain;
  };
  const tx = { select, execute: async (q: unknown) => void h.executes.push(q) };
  return { db: { transaction: async (work: (t: unknown) => unknown) => work(tx) } };
});
vi.mock("../server/services/accounting/zambiaVoucherRatePolicy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/accounting/zambiaVoucherRatePolicy")>()),
  assertApprovedZmwVoucherRate: (...a: unknown[]) => h.rate(...a),
}));
vi.mock("../server/services/accounting/cashBankRevaluationService", () => ({
  getCashBankRevaluation: (...a: unknown[]) => h.balances(...a),
}));
vi.mock("../server/services/accounting/erpVoucherPosting", () => ({
  postErpVoucherTx: (...a: unknown[]) => h.post(...a),
}));

import { postZambiaCashTransfer } from "../server/services/accounting/zambiaCashTransferService";
import { ZambiaVoucherRateError } from "../server/services/accounting/zambiaVoucherRatePolicy";

const actor = { userId: "u1", username: "teller" };
const cash = { id: 11, name: "Cash ZMW", accountType: "Cash", active: true };
const bank = { id: 21, name: "Bank USD", active: true, linkedLedgerId: 31 };
const request = (over: Record<string, unknown> = {}) => ({
  from: { kind: "ledger", id: 11 },
  to: { kind: "bank", id: 21 },
  fromCurrency: "ZMW",
  toCurrency: "USD",
  amount: "2650.00",
  rate: "26.5",
  transferDate: "2026-10-20",
  clientRequestId: "req-12345678",
  ...over,
});
const summary = (over: Record<string, unknown> = {}) => ({
  accountKind: "ledger",
  id: 11,
  totalsProvisional: false,
  openingBalanceCurrencyUnresolved: false,
  unresolvedLegacyEntryCount: 0,
  nativeBalancesByCurrency: { ZMW: "5000.00" },
  ...over,
});

beforeEach(() => {
  h.selects = [];
  h.executes = [];
  h.rate.mockReset().mockResolvedValue("26.5");
  h.balances.mockReset().mockResolvedValue({ accounts: [summary()] });
  h.post.mockReset().mockResolvedValue({ voucher: { id: 900, voucherNumber: "JV-900" }, replayed: false });
});

async function transferError(input: unknown) {
  const error = await postZambiaCashTransfer(input, 3, actor).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ZambiaVoucherRateError);
  return (error as Error).message;
}

describe("postZambiaCashTransfer", () => {
  it("posts a balanced ZMW-to-USD voucher at the approved rate", async () => {
    h.selects = [[cash], [bank], []];
    const result = await postZambiaCashTransfer(request({ description: "  Float top-up " }), 3, actor);
    expect(result).toEqual({
      voucherId: 900,
      voucherNumber: "JV-900",
      replayed: false,
      fromAmount: "2650.00",
      toAmount: "100.00",
      fromCurrency: "ZMW",
      toCurrency: "USD",
      rate: "26.5",
    });
    expect(h.rate).toHaveBeenCalledWith(3, "2026-10-20", "ZMW", "26.5");
    expect(h.executes).toHaveLength(1);
    expect(h.balances).toHaveBeenCalledWith(3, { attribution: "engine" });
    expect(h.post.mock.calls[0][1]).toEqual({
      companyId: 3,
      voucherType: "Journal",
      voucherDate: "2026-10-20",
      description: "Float top-up",
      currency: "USD",
      source: { type: "zambia-cash-currency-transfer", id: "req-12345678" },
      actor,
      lines: [
        {
          ledgerAccountId: 11,
          credit: "100.00",
          narration: "ZMW currency exchange - funds out",
          transaction: { currency: "ZMW", amount: "2650.00", rate: "26.5" },
        },
        { bankAccountId: 21, debit: "100.00", narration: "ZMW currency exchange - funds in" },
      ],
    });
  });

  it("posts USD-to-ZMW with the native amount on the destination", async () => {
    h.selects = [[{ ...bank, linkedLedgerId: null }], [cash], []];
    h.balances.mockResolvedValue({
      accounts: [summary({ accountKind: "bank", id: 21, nativeBalancesByCurrency: { USD: "100" } })],
    });
    const result = await postZambiaCashTransfer(
      request({
        from: { kind: "bank", id: 21 },
        to: { kind: "ledger", id: 11 },
        fromCurrency: "USD",
        toCurrency: "ZMW",
        amount: "100",
      }),
      3,
      actor
    );
    expect(result).toMatchObject({ fromAmount: "100.00", toAmount: "2650.00" });
    const lines = h.post.mock.calls[0][1].lines;
    expect(lines[0]).toEqual({ bankAccountId: 21, credit: "100.00", narration: "ZMW currency exchange - funds out" });
    expect(lines[1]).toMatchObject({
      ledgerAccountId: 11,
      debit: "100.00",
      transaction: { currency: "ZMW", amount: "2650.00" },
    });
    expect(h.post.mock.calls[0][1].description).toBe("Currency transfer USD to ZMW");
  });

  it("treats a ledger and a bank with the same id as different accounts", async () => {
    h.selects = [[cash], [{ ...bank, id: 11, linkedLedgerId: null }], []];
    await expect(postZambiaCashTransfer(request({ to: { kind: "bank", id: 11 } }), 3, actor)).resolves.toMatchObject({
      voucherId: 900,
    });
  });

  it("skips the funds preflight when the request was already posted", async () => {
    h.selects = [[cash], [bank], [{ id: 5 }]];
    h.post.mockResolvedValue({ voucher: { id: 900, voucherNumber: "JV-900" }, replayed: true });
    await expect(postZambiaCashTransfer(request(), 3, actor)).resolves.toMatchObject({ replayed: true });
    expect(h.balances).not.toHaveBeenCalled();
  });

  it("validates the request before touching the database", async () => {
    expect(await transferError({ ...request(), extra: 1 })).toContain("Unrecognized key");
    expect(await transferError(request({ amount: "1.234" }))).toBe("Use a positive 2-decimal currency amount.");
    expect(await transferError(request({ to: { kind: "ledger", id: 11 } }))).toBe(
      "Choose different source and destination accounts."
    );
    expect(await transferError(request({ toCurrency: "ZMW" }))).toBe(
      "This workflow converts USD and ZMW. Same-currency transfers use the standard journal."
    );
    expect(await transferError(request({ amount: "0.00" }))).toBe("Source amount must be greater than zero.");
    expect(await transferError(request({ amount: "0.01" }))).toBe(
      "Converted destination amount is below the minimum currency unit."
    );
    h.rate.mockResolvedValueOnce(null);
    expect(await transferError(request())).toBe("Approved USD/ZMW rate is required.");
    expect(h.post).not.toHaveBeenCalled();
    expect(h.executes).toHaveLength(0);
  });

  it("requires active cash or bank accounts of this company that are not the same account", async () => {
    const accountError = "Source/destination must be an active Cash or Bank ledger in this company.";
    for (const ledger of [[], [{ ...cash, accountType: "Expense" }], [{ ...cash, active: false }]]) {
      h.selects = [ledger, [bank], []];
      expect(await transferError(request())).toBe(accountError);
    }
    h.selects = [[{ ...cash, accountType: "Bank" }], [], []];
    expect(await transferError(request())).toBe(
      "Source/destination bank account is missing, inactive, or belongs to another company."
    );
    h.selects = [[cash], [{ ...bank, active: false }], []];
    expect(await transferError(request())).toContain("bank account is missing, inactive");
    h.selects = [[cash], [{ ...bank, linkedLedgerId: 11 }], []];
    expect(await transferError(request())).toBe("Source and destination resolve to the same linked bank/cash account.");
  });

  it("refuses unresolved or insufficient source balances", async () => {
    const unresolved = "Source cash/bank currency balance is unavailable or unresolved; reconcile before transferring.";
    for (const accounts of [
      [],
      [summary({ id: 12 })],
      [summary({ accountKind: "bank" })],
      [summary({ totalsProvisional: true })],
      [summary({ openingBalanceCurrencyUnresolved: true })],
      [summary({ unresolvedLegacyEntryCount: 1 })],
    ]) {
      h.selects = [[cash], [bank], []];
      h.balances.mockResolvedValueOnce({ accounts });
      expect(await transferError(request())).toBe(unresolved);
    }
    for (const nativeBalancesByCurrency of [{ ZMW: "2649.99" }, {}]) {
      h.selects = [[cash], [bank], []];
      h.balances.mockResolvedValueOnce({ accounts: [summary({ nativeBalancesByCurrency })] });
      expect(await transferError(request())).toBe("Insufficient verified funds in the source currency.");
    }
    expect(h.post).not.toHaveBeenCalled();
  });
});
