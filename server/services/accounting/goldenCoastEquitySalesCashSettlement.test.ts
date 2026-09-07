/**
 * Settling GC Sales Cash out of Hassan Dakik Equity.
 *
 * The property that matters is that no asset moves and the partners stay
 * whole: GC Sales Cash and Hassan Dakik Equity both fall by the amount, and
 * Fresh Start FZ Equity absorbs both sides. These tests pin the journal, both
 * ceilings, and the digest/idempotency behaviour the route depends on.
 */
import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_EQUITY_SALES_CASH_CONFIRMATION,
  GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE,
  GoldenCoastEquitySalesCashError,
  buildGoldenCoastEquitySalesCashPosting,
  conservativeCreditBalanceUsd,
  goldenCoastEquitySalesCashDigest,
  goldenCoastEquitySalesCashIdempotencyKey,
  parseGoldenCoastEquitySalesCashInput,
  planGoldenCoastEquitySalesCashSettlement,
  type GoldenCoastEquitySalesCashAccounts,
} from "./goldenCoastEquitySalesCashSettlement";

const COMPANY_ID = 7;
const ACCOUNTS: GoldenCoastEquitySalesCashAccounts = {
  gcSalesCashAccountId: 104,
  hassanEquityAccountId: 102,
  freshStartEquityAccountId: 101,
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    settlementDate: "2026-09-07",
    amountUsd: "1000.00",
    clientRequestId: "gc-esc-1",
    reference: "Hassan covers September",
    reason: "Settle the Fresh Start payable from Hassan capital",
    confirmation: GOLDEN_COAST_EQUITY_SALES_CASH_CONFIRMATION,
    ...overrides,
  };
}

function parsed(overrides: Record<string, unknown> = {}) {
  return parseGoldenCoastEquitySalesCashInput({ companyId: COMPANY_ID, body: body(overrides) });
}

function plan(overrides: Record<string, unknown> = {}, payable = "5000.00", equity = "5000.00") {
  return planGoldenCoastEquitySalesCashSettlement({
    settlement: parsed(overrides),
    gcSalesCashPayableUsd: payable,
    hassanEquityCreditBalanceUsd: equity,
  });
}

describe("input parsing", () => {
  it("requires the exact confirmation phrase", () => {
    expect(() => parsed({ confirmation: "settle sales cash from equity" })).toThrow(GoldenCoastEquitySalesCashError);
  });

  it("rejects a settlement dated before the Golden Coast cutover", () => {
    try {
      parsed({ settlementDate: "2000-01-01" });
      expect.unreachable("pre-cutover date must be rejected");
    } catch (error) {
      expect((error as GoldenCoastEquitySalesCashError).code).toBe("GC_EQUITY_SALES_CASH_PRE_CUTOVER_DATE");
    }
  });

  it("rejects a non-positive or over-precise amount", () => {
    expect(() => parsed({ amountUsd: "0" })).toThrow(GoldenCoastEquitySalesCashError);
    expect(() => parsed({ amountUsd: "-5.00" })).toThrow(GoldenCoastEquitySalesCashError);
    expect(() => parsed({ amountUsd: "1.005" })).toThrow(GoldenCoastEquitySalesCashError);
  });

  it("requires a reason of at least five characters", () => {
    expect(() => parsed({ reason: "abc" })).toThrow(GoldenCoastEquitySalesCashError);
  });
});

describe("planning both credit-normal drawdowns", () => {
  it("moves the payable and Hassan capital down by the same amount", () => {
    const result = plan({}, "5000.00", "8000.00");
    expect(result.gcSalesCashPayableBeforeUsd).toBe("5000.00");
    expect(result.gcSalesCashPayableAfterUsd).toBe("4000.00");
    expect(result.hassanEquityBeforeUsd).toBe("8000.00");
    expect(result.hassanEquityAfterUsd).toBe("7000.00");
    expect(result.freshStartEquityCreditUsd).toBe("2000.00");
  });

  it("never clears more than Fresh Start is actually owed", () => {
    try {
      plan({ amountUsd: "1000.00" }, "400.00", "9000.00");
      expect.unreachable("a settlement above the payable must be rejected");
    } catch (error) {
      expect((error as GoldenCoastEquitySalesCashError).code).toBe("GC_EQUITY_SALES_CASH_EXCEEDS_PAYABLE");
    }
  });

  it("never pushes Hassan capital negative", () => {
    try {
      plan({ amountUsd: "1000.00" }, "9000.00", "400.00");
      expect.unreachable("a settlement above available equity must be rejected");
    } catch (error) {
      expect((error as GoldenCoastEquitySalesCashError).code).toBe("GC_EQUITY_SALES_CASH_EXCEEDS_EQUITY");
    }
  });

  it("refuses to draw on an equity account that is already in debit", () => {
    try {
      plan({ amountUsd: "1000.00" }, "9000.00", "-1.00");
      expect.unreachable("a debit-balance equity account must be rejected");
    } catch (error) {
      expect((error as GoldenCoastEquitySalesCashError).code).toBe("GC_EQUITY_SALES_CASH_BALANCE_INVALID");
    }
  });

  it("allows settling the payable down to exactly zero", () => {
    const result = plan({ amountUsd: "5000.00" }, "5000.00", "5000.00");
    expect(result.gcSalesCashPayableAfterUsd).toBe("0.00");
    expect(result.hassanEquityAfterUsd).toBe("0.00");
  });
});

describe("the conservative credit-balance ceiling", () => {
  it("takes the all-posted balance when a later debit has already spent it", () => {
    // The case the ratchet exists for: $100 available at the settlement date,
    // but a later posted debit leaves nothing. Reading only the dated balance
    // would authorise a settlement that ends with the account in debit.
    expect(conservativeCreditBalanceUsd("100.00", "0.00")).toBe("0.00");
  });

  it("takes the dated balance when it is the lower of the two", () => {
    // A credit posted after the settlement date must not be spent early.
    expect(conservativeCreditBalanceUsd("40.00", "140.00")).toBe("40.00");
  });

  it("is unchanged when both readings agree", () => {
    expect(conservativeCreditBalanceUsd("250.00", "250.00")).toBe("250.00");
  });

  it("carries a negative balance through rather than flooring it", () => {
    // Planning rejects a debit-balance equity account outright; masking it as
    // zero here would turn that refusal into a silent no-op ceiling.
    expect(conservativeCreditBalanceUsd("10.00", "-5.00")).toBe("-5.00");
  });

  it("refuses a reading it cannot represent exactly", () => {
    expect(() => conservativeCreditBalanceUsd("1.0000001", "5.00")).toThrow(GoldenCoastEquitySalesCashError);
  });
});

describe("a backdated settlement cannot spend equity a later debit consumed", () => {
  it("rejects the amount once the conservative ceiling is applied", () => {
    // $100 dated balance, $0 once every posted entry is counted.
    const ceiling = conservativeCreditBalanceUsd("100.00", "0.00");
    try {
      planGoldenCoastEquitySalesCashSettlement({
        settlement: parsed({ amountUsd: "100.00" }),
        gcSalesCashPayableUsd: "9000.00",
        hassanEquityCreditBalanceUsd: ceiling,
      });
      expect.unreachable("the backdated settlement must be rejected");
    } catch (error) {
      expect((error as GoldenCoastEquitySalesCashError).code).toBe("GC_EQUITY_SALES_CASH_EXCEEDS_EQUITY");
    }
  });
});

describe("the posted journal", () => {
  const built = buildGoldenCoastEquitySalesCashPosting({
    plan: plan(),
    accounts: ACCOUNTS,
    settlementDigest: goldenCoastEquitySalesCashDigest({ settlement: parsed(), accounts: ACCOUNTS }),
  });
  const entries = built.entries as Array<Record<string, string | number>>;
  const on = (accountId: number) => entries.find((entry) => Number(entry.ledgerAccountId) === accountId);

  // The posting builder normalizes amounts, so compare numerically rather than
  // pinning a particular string scale.
  const sides = (accountId: number) => {
    const entry = on(accountId);
    return { debit: Number(entry?.debitAmount ?? 0), credit: Number(entry?.creditAmount ?? 0) };
  };

  it("debits GC Sales Cash and Hassan equity, crediting Fresh Start for both", () => {
    expect(sides(ACCOUNTS.gcSalesCashAccountId)).toEqual({ debit: 1000, credit: 0 });
    expect(sides(ACCOUNTS.hassanEquityAccountId)).toEqual({ debit: 1000, credit: 0 });
    expect(sides(ACCOUNTS.freshStartEquityAccountId)).toEqual({ debit: 0, credit: 2000 });
  });

  it("balances", () => {
    const debits = entries.reduce((sum, entry) => sum + Number(entry.debitAmount || 0), 0);
    const credits = entries.reduce((sum, entry) => sum + Number(entry.creditAmount || 0), 0);
    expect(debits).toBeCloseTo(credits, 6);
    expect(debits).toBeCloseTo(2000, 6);
  });

  it("moves no cash or bank account at all", () => {
    expect(entries.every((entry) => entry.bankAccountId == null)).toBe(true);
  });

  it("carries a Golden Coast programme voucher number and its own source type", () => {
    expect(String((built.voucher as Record<string, string>).voucherNumber)).toMatch(/^GC-ESC-C7-/);
    expect(built.source?.sourceType).toBe(GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE);
  });

  it("refuses to post when two of the three roles collide", () => {
    expect(() =>
      buildGoldenCoastEquitySalesCashPosting({
        plan: plan(),
        accounts: { ...ACCOUNTS, freshStartEquityAccountId: ACCOUNTS.hassanEquityAccountId },
        settlementDigest: "abc",
      })
    ).toThrow(GoldenCoastEquitySalesCashError);
  });
});

describe("digest and idempotency", () => {
  it("is stable for an identical payload and changes with the amount", () => {
    const base = goldenCoastEquitySalesCashDigest({ settlement: parsed(), accounts: ACCOUNTS });
    expect(goldenCoastEquitySalesCashDigest({ settlement: parsed(), accounts: ACCOUNTS })).toBe(base);
    expect(
      goldenCoastEquitySalesCashDigest({ settlement: parsed({ amountUsd: "1000.01" }), accounts: ACCOUNTS })
    ).not.toBe(base);
  });

  it("scopes the idempotency key to the company and request id", () => {
    expect(goldenCoastEquitySalesCashIdempotencyKey(COMPANY_ID, "gc-esc-1")).toBe(
      `${GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE}:7:gc-esc-1`
    );
    expect(goldenCoastEquitySalesCashIdempotencyKey(8, "gc-esc-1")).not.toBe(
      goldenCoastEquitySalesCashIdempotencyKey(7, "gc-esc-1")
    );
  });
});
