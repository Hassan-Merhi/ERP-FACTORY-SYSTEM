/**
 * Pure rules for replacing a voucher's lines (2026-10 accounting audit, wave 2).
 */
import { describe, expect, it } from "vitest";

import {
  assertValidReplacementEntries,
  resolveReplacementEntryTargets,
} from "../server/services/accounting/voucherEntryReplacement";

describe("resolveReplacementEntryTargets", () => {
  it("reads the Daybook { accountType, accountId } shape", () => {
    expect(resolveReplacementEntryTargets({ accountType: "supplier", accountId: 7 })).toMatchObject({
      supplierId: 7,
      ledgerAccountId: null,
    });
    expect(resolveReplacementEntryTargets({ accountType: "factorySupplier", accountId: "9" })).toMatchObject({
      factorySupplierId: 9,
    });
  });

  it("prefers explicit column ids over the form shape", () => {
    expect(
      resolveReplacementEntryTargets({ ledgerAccountId: 3, accountType: "ledger", accountId: 4 }).ledgerAccountId
    ).toBe(3);
  });
});

describe("assertValidReplacementEntries", () => {
  const line = (debit: string, credit: string, extra: Record<string, unknown> = { ledgerAccountId: 1 }) => ({
    ...extra,
    debitAmount: debit,
    creditAmount: credit,
  });

  it("requires every line to post to exactly one account", () => {
    expect(() => assertValidReplacementEntries("Journal", false, [line("1", "0", {}), line("0", "1")])).toThrow(
      /must post to an account/
    );
    expect(() =>
      assertValidReplacementEntries("Journal", false, [
        line("1", "0", { ledgerAccountId: 1, supplierId: 2 }),
        line("0", "1"),
      ])
    ).toThrow(/exactly one account/);
  });

  it("allows a customer line on its own ledger account", () => {
    expect(() =>
      assertValidReplacementEntries("Journal", false, [
        line("1", "0", { ledgerAccountId: 1, customerId: 2 }),
        line("0", "1"),
      ])
    ).not.toThrow();
  });

  it("requires active balanced vouchers to balance exactly", () => {
    expect(() => assertValidReplacementEntries("Payment", false, [line("10.00", "0"), line("0", "9.99")])).toThrow(
      /debits must equal total credits/
    );
    expect(() => assertValidReplacementEntries("Payment", true, [line("10.00", "0"), line("0", "9.99")])).not.toThrow();
  });

  it("requires Contra and unclassified active vouchers to balance", () => {
    for (const voucherType of ["Contra", "Some New Voucher", ""]) {
      expect(() => assertValidReplacementEntries(voucherType, false, [line("10.00", "0"), line("0", "9.99")])).toThrow(
        /debits must equal total credits/
      );
    }
  });

  it("keeps the per-line rules only for one-sided stock vouchers", () => {
    expect(() => assertValidReplacementEntries("Consumption", false, [line("12.50", "0")])).not.toThrow();
    expect(() => assertValidReplacementEntries("Consumption", false, [line("-1", "0")])).toThrow();
  });

  it("validates the submitted debit/credit even when the line names its transaction currency", () => {
    expect(() =>
      assertValidReplacementEntries("Journal", false, [
        { ledgerAccountId: 1, transactionCurrency: "CFA", debitAmount: "6000", creditAmount: "0" },
        { ledgerAccountId: 2, transactionCurrency: "CFA", debitAmount: "0", creditAmount: "6000" },
      ])
    ).not.toThrow();
  });
});
