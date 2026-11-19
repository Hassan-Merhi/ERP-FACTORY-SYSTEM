/**
 * Phase 8 source regression contract for Claude's final verification gate.
 * Intentionally NOT executed in ChatGPT implementation phases.
 */
import { describe, expect, it } from "vitest";
import { buildCompanyTransferPostingRequest } from "../server/services/accounting/companyTransferPosting";
import { zambiaTransferVoucherNumber } from "../server/services/accounting/zambiaIntercompanyTransfer";
import {
  assertHistoricalUsdPurchaseCost,
  isUnsupportedNativeZmwPurchase,
} from "../server/services/accounting/zambiaPurchaseCurrencyGuard";

const common = {
  companyId: 19,
  voucherNumber: "ICT-TEST-8",
  voucherType: "Payment" as const,
  voucherDate: "2026-10-20",
  debitLedgerAccountId: 101,
  creditLedgerAccountId: 102,
  clientRequestId: "phase8-native-zmw",
  sourceType: "inter-company-transfer" as const,
  sourceSide: "from" as const,
};

describe("Zambia Phase 8 historical intercompany accounting", () => {
  it("preserves original Kwacha with historical six-decimal USD base and rate", () => {
    const built = buildCompanyTransferPostingRequest({
      ...common,
      transactionCurrency: "ZMW",
      historicalExchangeRate: "25",
      amount: "250.00",
    });
    expect(built.amount).toBe("10.000000");
    expect(built.request.voucher.currency).toBe("ZMW");
    expect(built.request.voucher.exchangeRate).toBe("25");
    expect(built.request.entries[0]).toMatchObject({
      debitAmount: "10.000000",
      transactionCurrency: "ZMW",
      transactionDebitAmount: "250.000000",
      baseDebitAmount: "10.000000",
      rateConvention: "TRANSACTION_PER_BASE",
    });
    expect(built.request.entries[1]).toMatchObject({
      creditAmount: "10.000000",
      transactionCurrency: "ZMW",
      transactionCreditAmount: "250.000000",
      baseCreditAmount: "10.000000",
      rateConvention: "TRANSACTION_PER_BASE",
    });
  });

  it("replays stable ZMW posting identities and refuses rate- or amount-changed retries", () => {
    const first = buildCompanyTransferPostingRequest({
      ...common,
      voucherNumber: zambiaTransferVoucherNumber("ICT-FROM", "phase8-native-zmw"),
      amount: "250.00",
      transactionCurrency: "ZMW",
      historicalExchangeRate: "25",
    });
    const repeatNumber = zambiaTransferVoucherNumber("ICT-FROM", "phase8-native-zmw");
    const modified = buildCompanyTransferPostingRequest({
      ...common,
      voucherNumber: repeatNumber,
      amount: "300.00",
      transactionCurrency: "ZMW",
      historicalExchangeRate: "25",
    });
    expect(first.request.voucher.voucherNumber).toBe(repeatNumber);
    expect(first.request.source.idempotencyKey).toBe(modified.request.source.idempotencyKey);
    expect(first.request.entries[0].transactionDebitAmount).not.toBe(
      modified.request.entries[0].transactionDebitAmount
    );
    expect(() => zambiaTransferVoucherNumber("ICT-FROM", "")).toThrow();
  });

  it("does not alter legacy USD intercompany postings", () => {
    const built = buildCompanyTransferPostingRequest({ ...common, amount: "10.00" });
    expect(built.request.voucher.currency).toBeUndefined();
    expect(built.request.voucher.exchangeRate).toBeUndefined();
    expect(built.request.entries[0].debitAmount).toBe("10");
    expect(built.request.entries[0].transactionCurrency).toBeUndefined();
    expect(built.request.entries[1].creditAmount).toBe("10");
  });

  it("rejects unapproved or absent rate for native ZMW", () => {
    expect(() =>
      buildCompanyTransferPostingRequest({
        ...common,
        amount: "250",
        transactionCurrency: "ZMW",
      })
    ).toThrow();
  });

  it("prevents a Kwacha PO label from silently being accounted as USD cost", () => {
    expect(isUnsupportedNativeZmwPurchase(" zmw ")).toBe(true);
    expect(() => assertHistoricalUsdPurchaseCost("ZMW")).toThrow();
    expect(() => assertHistoricalUsdPurchaseCost("USD")).not.toThrow();
    expect(() => assertHistoricalUsdPurchaseCost("CFA")).not.toThrow();
  });
});
