/**
 * The central posting engine tolerates up to half a cent of base-currency
 * translation noise only for the audited Zambia USD<->ZMW cash transfer: one
 * USD leg, one native Kwacha leg, both carrying full dual-currency fields with
 * the right conventions, in a USD-denominated journal. Every other shape keeps
 * the ordinary per-line conversion allowance (or none), so a Kwacha amount can
 * never slip through as an unbalanced USD posting.
 */
import { describe, expect, it } from "vitest";

import {
  PostingValidationError,
  validateCentralPostingRequest,
  type CentralPostingRequest,
} from "../server/services/accounting/centralPostingEngine";
import type { VoucherEntryInsertFields } from "../server/services/accounting/accountingTypes";

/** USD leg: 10 USD out of the USD cash account (IDENTITY). */
function usdLeg(overrides: Partial<VoucherEntryInsertFields> = {}): VoucherEntryInsertFields {
  return {
    ledgerAccountId: 10,
    debitAmount: "10.000000",
    creditAmount: "0",
    transactionCurrency: "USD",
    transactionDebitAmount: "10.000000",
    transactionCreditAmount: "0.000000",
    baseDebitAmount: "10.000000",
    baseCreditAmount: "0.000000",
    historicalExchangeRate: "1.0000000000",
    rateConvention: "IDENTITY",
    ...overrides,
  };
}

/**
 * Kwacha leg: K249.90 at 25 per USD is 9.996 USD, four tenths of a cent short
 * of the USD leg once the original Kwacha amount was rounded to ngwee.
 */
function zmwLeg(overrides: Partial<VoucherEntryInsertFields> = {}): VoucherEntryInsertFields {
  return {
    ledgerAccountId: 11,
    debitAmount: "0",
    creditAmount: "9.996000",
    transactionCurrency: "ZMW",
    transactionDebitAmount: "0.000000",
    transactionCreditAmount: "249.900000",
    baseDebitAmount: "0.000000",
    baseCreditAmount: "9.996000",
    historicalExchangeRate: "25.0000000000",
    rateConvention: "TRANSACTION_PER_BASE",
    ...overrides,
  };
}

function transfer(overrides: Partial<CentralPostingRequest> = {}): CentralPostingRequest {
  return {
    voucher: {
      companyId: 19,
      voucherType: "Journal",
      voucherDate: "2026-10-23",
      totalAmount: "10.000000",
      currency: "USD",
    },
    entries: [usdLeg(), zmwLeg()],
    source: {
      sourceType: "zambia-cash-currency-transfer",
      sourceId: "req-1",
      idempotencyKey: "zambia-cash-currency-transfer:req-1",
    },
    actor: { userId: "1", username: "tester" },
    ...overrides,
  };
}

const unbalanced = expect.objectContaining<PostingValidationError>({ code: "POSTING_UNBALANCED" });

describe("Zambia USD/ZMW cash transfer tolerance in validateCentralPostingRequest", () => {
  it("accepts the audited mixed-currency transfer with sub-cent translation noise", () => {
    expect(validateCentralPostingRequest(transfer())).toEqual({ debitTotal: "10", creditTotal: "9.996" });
  });

  it("still rejects noise above half a cent on the audited transfer", () => {
    const wide = transfer({
      entries: [usdLeg(), zmwLeg({ creditAmount: "9.994000", baseCreditAmount: "9.994000" })],
    });
    expect(() => validateCentralPostingRequest(wide)).toThrowError(unbalanced);
  });

  it("gives no such allowance to another source posting the same legs", () => {
    const other = transfer({
      source: { sourceType: "manual-journal", sourceId: "j-1", idempotencyKey: "manual-journal:j-1" },
    });
    expect(() => validateCentralPostingRequest(other)).toThrowError(unbalanced);
  });

  it("requires a USD-denominated journal with exactly two legs", () => {
    const kwachaJournal = transfer({ voucher: { ...transfer().voucher, currency: "ZMW" } });
    expect(() => validateCentralPostingRequest(kwachaJournal)).toThrowError(unbalanced);

    const threeLegs = transfer({
      voucher: { ...transfer().voucher, totalAmount: "11.000000" },
      entries: [
        usdLeg(),
        usdLeg({
          ledgerAccountId: 12,
          debitAmount: "1.000000",
          transactionDebitAmount: "1.000000",
          baseDebitAmount: "1.000000",
        }),
        zmwLeg({
          creditAmount: "10.996000",
          transactionCreditAmount: "274.900000",
          baseCreditAmount: "10.996000",
        }),
      ],
    });
    expect(() => validateCentralPostingRequest(threeLegs)).toThrowError(unbalanced);
  });

  it("requires one USD leg and one ZMW leg", () => {
    const twoKwachaLegs = transfer({
      entries: [
        zmwLeg({
          ledgerAccountId: 10,
          debitAmount: "10.000000",
          creditAmount: "0",
          transactionDebitAmount: "249.900000",
          transactionCreditAmount: "0.000000",
          baseDebitAmount: "10.000000",
          baseCreditAmount: "0.000000",
        }),
        zmwLeg(),
      ],
    });
    expect(() => validateCentralPostingRequest(twoKwachaLegs)).toThrowError(unbalanced);

    const usdAndCfa = transfer({ entries: [usdLeg(), zmwLeg({ transactionCurrency: "CFA" })] });
    expect(() => validateCentralPostingRequest(usdAndCfa)).toThrowError(unbalanced);
  });

  it("requires full dual-currency fields and the right convention on each leg", () => {
    const missingBase = transfer({ entries: [usdLeg(), zmwLeg({ baseCreditAmount: null })] });
    expect(() => validateCentralPostingRequest(missingBase)).toThrowError(unbalanced);

    const missingTransaction = transfer({ entries: [usdLeg({ transactionDebitAmount: null }), zmwLeg()] });
    expect(() => validateCentralPostingRequest(missingTransaction)).toThrowError(unbalanced);

    const usdConverted = transfer({ entries: [usdLeg({ rateConvention: "TRANSACTION_PER_BASE" }), zmwLeg()] });
    expect(() => validateCentralPostingRequest(usdConverted)).toThrowError(unbalanced);

    const kwachaIdentity = transfer({ entries: [usdLeg(), zmwLeg({ rateConvention: "IDENTITY" })] });
    expect(() => validateCentralPostingRequest(kwachaIdentity)).toThrowError(unbalanced);
  });
});
