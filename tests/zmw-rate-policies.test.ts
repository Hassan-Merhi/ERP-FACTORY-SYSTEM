/**
 * Zambia Kwacha rate protection for POS sales and ERP vouchers: the dated
 * rate lock, future-date and configuration refusals, import price checks,
 * locked edits and the native-amount check. Storage and the company business
 * date are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  company: null as Record<string, unknown> | null,
  rate: null as { rate: unknown } | null,
  today: "2026-10-20",
}));
vi.mock("../server/storage", () => ({
  storage: {
    getCompanyById: async () => h.company,
    getExchangeRateForDate: async () => h.rate,
  },
}));
vi.mock("../server/services/accounting/companyBusinessDate", () => ({ companyBusinessDate: async () => h.today }));

import {
  assertZmwImportPrices,
  PosZmwRateError,
  resolveLockedZmwPosCurrency,
} from "../server/services/pos/posZmwRatePolicy";
import {
  assertApprovedZmwVoucherRate,
  assertLockedZmwVoucherEdit,
  assertResolvedZmwVoucherEntriesTx,
  ZambiaVoucherRateError,
} from "../server/services/accounting/zambiaVoucherRatePolicy";
import { ENGINE_ROUNDING_NARRATION } from "../server/services/accounting/engineRounding";

const ZAMBIA = { baseCurrency: "USD", displayCurrency: "ZMW" };

beforeEach(() => {
  h.company = { ...ZAMBIA };
  h.rate = { rate: "26.5" };
  h.today = "2026-10-20";
});

async function posError(...args: Parameters<typeof resolveLockedZmwPosCurrency>) {
  const error = await resolveLockedZmwPosCurrency(...args).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PosZmwRateError);
  expect(error).toMatchObject({ statusCode: 409, code: "POS_ZMW_RATE_REQUIRED", name: "PosZmwRateError" });
  return (error as Error).message;
}

describe("resolveLockedZmwPosCurrency", () => {
  it("passes other currencies through and limits Zambia to USD and ZMW", async () => {
    await expect(resolveLockedZmwPosCurrency(1, "2026-10-20", undefined, null)).resolves.toEqual({
      currency: "USD",
      exchangeRate: null,
    });
    await expect(resolveLockedZmwPosCurrency(1, "2026-10-20", "usd", 1)).resolves.toEqual({
      currency: "USD",
      exchangeRate: "1",
    });
    h.company = { baseCurrency: "USD", displayCurrency: "XOF" };
    await expect(resolveLockedZmwPosCurrency(1, "2026-10-20", "xof", "600")).resolves.toEqual({
      currency: "XOF",
      exchangeRate: "600",
    });
    h.company = { ...ZAMBIA };
    expect(await posError(1, "2026-10-20", "XOF", "600")).toBe("Zambia POS accepts only USD and ZMW.");
  });

  it("locks the dated rate when the submitted one matches", async () => {
    await expect(resolveLockedZmwPosCurrency(1, "2026-10-19", "zmw", "26.500")).resolves.toEqual({
      currency: "ZMW",
      exchangeRate: "26.5",
    });
    await expect(resolveLockedZmwPosCurrency(1, "2026-10-20", "ZMW", 26.5)).resolves.toMatchObject({
      exchangeRate: "26.5",
    });
  });

  it("refuses an invalid or future date, an unconfigured company and a missing or different rate", async () => {
    expect(await posError(1, "2026-02-30", "ZMW", "26.5")).toBe(
      "Enter a valid sale date before posting a Kwacha sale."
    );
    expect(await posError(1, "2026-10-21", "ZMW", "26.5")).toBe(
      "Future-dated Kwacha sales/refunds are not allowed. Select a business date on or before today."
    );
    for (const company of [null, { baseCurrency: "EUR", displayCurrency: "ZMW" }]) {
      h.company = company;
      expect(await posError(1, "2026-10-20", "ZMW", "26.5")).toBe(
        "USD/ZMW must be configured for the active company before posting Kwacha sales."
      );
    }
    h.company = { ...ZAMBIA };
    for (const rate of [null, { rate: "0" }, { rate: "abc" }]) {
      h.rate = rate;
      expect(await posError(1, "2026-10-20", "ZMW", "26.5")).toBe(
        "No approved USD/ZMW exchange rate exists on or before the sale date."
      );
    }
    h.rate = { rate: "26.5" };
    for (const supplied of [undefined, null, "", "26.51", "-1", "26.5000001"]) {
      expect(await posError(1, "2026-10-20", "ZMW", supplied)).toBe(
        "The USD/ZMW rate for this sale date differs from the selected rate. Reload the date-specific rate and recalculate the prices."
      );
    }
  });
});

describe("assertZmwImportPrices", () => {
  const locked = { currency: "ZMW", exchangeRate: "26.5" };
  it("ignores non-ZMW sales and needs a locked rate", () => {
    expect(() => assertZmwImportPrices([{ rate: "x" }], { currency: "USD", exchangeRate: null })).not.toThrow();
    expect(() => assertZmwImportPrices([], { currency: "ZMW", exchangeRate: null })).toThrow(
      "ZMW rate was not locked."
    );
  });

  it("accepts USD prices that round-trip to the Kwacha price within six decimals", () => {
    expect(() =>
      assertZmwImportPrices(
        [
          { rate: "10", originalCurrencyRate: "265" },
          { rate: "0.037736", originalCurrencyRate: "1" },
        ],
        locked
      )
    ).not.toThrow();
  });

  it("names the line with a malformed, non-positive or mismatched price", () => {
    const check = (row: { rate: unknown; originalCurrencyRate?: unknown }) => () =>
      assertZmwImportPrices([{ rate: "10", originalCurrencyRate: "265" }, row], locked);
    for (const row of [
      { rate: "1.1234567", originalCurrencyRate: "1" },
      { rate: "10" },
      { rate: null, originalCurrencyRate: "1" },
      { rate: "-1", originalCurrencyRate: "1" },
    ]) {
      expect(check(row)).toThrow("Excel line 2: include a valid converted USD rate and original ZMW rate.");
    }
    for (const row of [
      { rate: "0", originalCurrencyRate: "1" },
      { rate: "1", originalCurrencyRate: "0" },
      { rate: "10", originalCurrencyRate: "266" },
      { rate: "0.03774", originalCurrencyRate: "1" },
    ]) {
      expect(check(row)).toThrow(
        "Excel line 2: USD amount does not match the original Kwacha price at the locked rate."
      );
    }
  });
});

async function voucherError(...args: Parameters<typeof assertApprovedZmwVoucherRate>) {
  const error = await assertApprovedZmwVoucherRate(...args).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ZambiaVoucherRateError);
  expect(error).toMatchObject({ statusCode: 409, code: "ZMW_VOUCHER_RATE_INVALID", name: "ZambiaVoucherRateError" });
  return (error as Error).message;
}

describe("assertApprovedZmwVoucherRate", () => {
  it("passes non-ZMW rates through", async () => {
    await expect(assertApprovedZmwVoucherRate(1, "2026-10-20", null, null)).resolves.toBeNull();
    await expect(assertApprovedZmwVoucherRate(1, "2026-10-20", " xof ", "")).resolves.toBeNull();
    await expect(assertApprovedZmwVoucherRate(1, "2026-10-20", "XOF", 600)).resolves.toBe("600");
  });

  it("returns the approved rate when the supplied one matches", async () => {
    h.company = { baseCurrency: "usd", displayCurrency: "zmw" };
    await expect(assertApprovedZmwVoucherRate(1, "2026-10-20", " zmw ", " 26.50 ")).resolves.toBe("26.5");
  });

  it("refuses each invalid input or configuration", async () => {
    const target = "A valid company and voucher date are required for ZMW accounting.";
    expect(await voucherError(0, "2026-10-20", "ZMW", "26.5")).toBe(target);
    expect(await voucherError(1.5, "2026-10-20", "ZMW", "26.5")).toBe(target);
    expect(await voucherError(1, "20-10-2026", "ZMW", "26.5")).toBe(target);
    for (const company of [
      null,
      { baseCurrency: "EUR", displayCurrency: "ZMW" },
      { baseCurrency: "USD", displayCurrency: "USD" },
    ]) {
      h.company = company;
      expect(await voucherError(1, "2026-10-20", "ZMW", "26.5")).toBe(
        "The active company must be configured USD base / ZMW display."
      );
    }
    h.company = { ...ZAMBIA };
    expect(await voucherError(1, "2026-10-21", "ZMW", "26.5")).toBe("Cannot post a future-dated ZMW voucher.");
    h.rate = null;
    expect(await voucherError(1, "2026-10-20", "ZMW", "26.5")).toBe(
      "An approved USD/ZMW rate is required on or before the voucher date."
    );
    h.rate = { rate: "26.5" };
    for (const supplied of [null, "", "26.4", "x"]) {
      expect(await voucherError(1, "2026-10-20", "ZMW", supplied)).toBe(
        "The supplied USD/ZMW rate differs from the approved historical rate. Reload the date-specific rate."
      );
    }
  });
});

describe("assertLockedZmwVoucherEdit", () => {
  const original = { currency: "ZMW", voucherDate: "2026-10-01T00:00:00Z", exchangeRate: "26.5000000000" };
  it("only refuses moving a non-ZMW voucher into ZMW", () => {
    expect(() =>
      assertLockedZmwVoucherEdit({ voucherDate: "2026-10-01" }, { currency: "usd", voucherDate: "2026-10-05" })
    ).not.toThrow();
    expect(() => assertLockedZmwVoucherEdit({ currency: "USD", voucherDate: "2026-10-01" }, {})).not.toThrow();
    expect(() =>
      assertLockedZmwVoucherEdit({ currency: null, voucherDate: "2026-10-01" }, { currency: "zmw" })
    ).toThrow("Changing an existing voucher currency to ZMW requires reversal and rebooking.");
  });

  it("locks a ZMW voucher's currency, date and rate", () => {
    expect(() =>
      assertLockedZmwVoucherEdit(original, { currency: "zmw", voucherDate: "2026-10-01", exchangeRate: "26.5" })
    ).not.toThrow();
    expect(() => assertLockedZmwVoucherEdit(original, {})).not.toThrow();
    expect(() => assertLockedZmwVoucherEdit(original, { currency: "USD" })).toThrow(
      "Posted ZMW voucher currency is locked."
    );
    expect(() => assertLockedZmwVoucherEdit(original, { voucherDate: "2026-10-02" })).toThrow(
      "Changing the date of a ZMW voucher requires reversal and rebooking."
    );
    for (const exchangeRate of ["26.6", "abc", "Infinity"]) {
      expect(() => assertLockedZmwVoucherEdit(original, { exchangeRate })).toThrow(
        "Posted ZMW voucher exchange rate cannot be changed."
      );
    }
    for (const exchangeRate of [null, "", "nope", "0", "-2", "Infinity"]) {
      expect(() => assertLockedZmwVoucherEdit({ ...original, exchangeRate }, {})).toThrow(
        "Original ZMW voucher has no valid locked rate."
      );
    }
  });
});

describe("assertResolvedZmwVoucherEntriesTx", () => {
  const tx = (rounding: { id: number } | undefined) =>
    ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (rounding ? [rounding] : []) }) }) }),
    }) as never;
  const native = {
    ledgerAccountId: 4,
    narration: "Sale",
    transactionCurrency: "ZMW",
    transactionDebitAmount: "265",
    transactionCreditAmount: "0",
    historicalExchangeRate: "26.5",
  };
  const roundingLine = {
    ...native,
    ledgerAccountId: 9,
    narration: ENGINE_ROUNDING_NARRATION,
    transactionCurrency: "USD",
  };

  it("accepts native lines plus the engine's rounding line", async () => {
    await expect(assertResolvedZmwVoucherEntriesTx(tx({ id: 9 }), 1, [native, roundingLine])).resolves.toBeUndefined();
  });

  it("refuses unresolved native amounts and USD lines that are not the engine's rounding", async () => {
    const message = "Original ZMW amounts/rate are unresolved. Reconcile the voucher before editing it.";
    for (const entry of [
      { ...native, transactionCurrency: "USD" },
      { ...native, transactionDebitAmount: null },
      { ...native, transactionCreditAmount: null },
      { ...native, historicalExchangeRate: null },
      { ...roundingLine, narration: "Manual rounding" },
      { ...roundingLine, ledgerAccountId: 8 },
      { ...roundingLine, transactionCurrency: "ZMW", historicalExchangeRate: null },
    ]) {
      await expect(assertResolvedZmwVoucherEntriesTx(tx({ id: 9 }), 1, [native, entry])).rejects.toThrow(message);
    }
    await expect(assertResolvedZmwVoucherEntriesTx(tx(undefined), 1, [native, roundingLine])).rejects.toThrow(message);
    await expect(assertResolvedZmwVoucherEntriesTx(tx({ id: 9 }), 1, [roundingLine])).rejects.toThrow(
      "No native ZMW entries remain to edit."
    );
    await expect(assertResolvedZmwVoucherEntriesTx(tx({ id: 9 }), 1, [])).rejects.toThrow(
      "No native ZMW entries remain to edit."
    );
  });
});
