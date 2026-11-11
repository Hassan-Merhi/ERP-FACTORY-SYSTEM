/**
 * Rent payment allocation, as the browser previews it.
 *
 * When a tenant hands over a lump sum, this decides which months it settles —
 * oldest outstanding first, skipping months already paid, never before the
 * contract started. The comment in the module says it mirrors the server's
 * findEarliestOutstandingMonth, and a preview that disagrees with what the
 * server then posts is the kind of difference a tenant notices on a receipt.
 */
import { describe, expect, it } from "vitest";
import { billingDayLabel, buildPaymentAllocations, currencySymbol, fmtMoney, fmtMoneyCurrency, ordinal } from "./utils";

function ledgerRow(year: number, month: number, expected: string, paid: string) {
  return { year, month, expectedAmount: expected, paidAmount: paid };
}

describe("currency display", () => {
  it("uses the symbol each currency is written with", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("CFA")).toBe("CFA ");
    expect(currencySymbol("XOF")).toBe("CFA ");
  });

  it("shows CFA without decimals and dollars with them", () => {
    // CFA has no sub-unit, so decimals there are noise rather than precision.
    expect(fmtMoneyCurrency(1234.56, "CFA")).toBe("CFA 1,235");
    expect(fmtMoneyCurrency(1234.56, "USD")).toBe("$1,234.56");
  });

  it("shows a dash for an amount that was never entered", () => {
    expect(fmtMoneyCurrency(null)).toBe("—");
    expect(fmtMoneyCurrency("")).toBe("—");
    expect(fmtMoney(undefined)).toBe("—");
    // Zero is an amount; it must not read as missing.
    expect(fmtMoney(0)).toBe("0");
  });
});

describe("billing day", () => {
  it("names the day of the month in words", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(21)).toBe("21st");
  });

  it("describes the recurring billing day from a contract date", () => {
    expect(billingDayLabel("2026-03-05T00:00:00Z")).toBe("5th of each month");
  });

  it("says nothing when there is no date to describe", () => {
    expect(billingDayLabel(null)).toBeNull();
    expect(billingDayLabel(undefined)).toBeNull();
  });
});

describe("payment allocation", () => {
  it("splits a lump sum into whole months of rent", () => {
    const allocations = buildPaymentAllocations(300, 100, "2026-03-10");

    expect(allocations).toEqual([
      { year: 2026, month: 3, chunk: 100 },
      { year: 2026, month: 4, chunk: 100 },
      { year: 2026, month: 5, chunk: 100 },
    ]);
  });

  it("leaves a part month as its own smaller allocation", () => {
    const allocations = buildPaymentAllocations(250, 100, "2026-03-10");

    expect(allocations.map((entry) => entry.chunk)).toEqual([100, 100, 50]);
  });

  it("rolls over the year end", () => {
    const allocations = buildPaymentAllocations(200, 100, "2026-12-10");

    expect(allocations).toEqual([
      { year: 2026, month: 12, chunk: 100 },
      { year: 2027, month: 1, chunk: 100 },
    ]);
  });

  it("allocates nothing when there is nothing to allocate", () => {
    expect(buildPaymentAllocations(0, 100, "2026-03-10")).toEqual([]);
    expect(buildPaymentAllocations(100, 0, "2026-03-10")).toEqual([]);
    expect(buildPaymentAllocations(100, 100, "")).toEqual([]);
  });

  it("starts from the earliest month that is still outstanding", () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const allocations = buildPaymentAllocations(100, 100, `${year}-${String(month).padStart(2, "0")}-10`, [
      ledgerRow(year - 1, 1, "100", "100"),
      ledgerRow(year - 1, 2, "100", "0"),
    ]);

    // The oldest debt is settled first; paying the current month while an older
    // one stands open would misstate what the tenant owes.
    expect(allocations[0]).toEqual({ year: year - 1, month: 2, chunk: 100 });
  });

  it("skips a month that is already settled", () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const allocations = buildPaymentAllocations(200, 100, `${year}-${String(month).padStart(2, "0")}-10`, [
      ledgerRow(year - 1, 1, "100", "0"),
      ledgerRow(year - 1, 2, "100", "100"),
      ledgerRow(year - 1, 3, "100", "0"),
    ]);

    expect(allocations.map((entry) => `${entry.year}-${entry.month}`)).toEqual([`${year - 1}-1`, `${year - 1}-3`]);
  });

  it("never allocates to a month before the contract started", () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const allocations = buildPaymentAllocations(
      100,
      100,
      `${year}-${String(month).padStart(2, "0")}-10`,
      [ledgerRow(year - 5, 1, "100", "0")],
      `${year - 1}-06-01`
    );

    // A ledger row predating the contract is not a debt under it.
    expect(allocations[0].year).toBeGreaterThanOrEqual(year - 1);
  });

  it("stops rather than looping forever on an unsatisfiable payment", () => {
    const allocations = buildPaymentAllocations(1_000_000, 1, "2026-03-10");

    expect(allocations.length).toBeLessThanOrEqual(120);
  });
});
