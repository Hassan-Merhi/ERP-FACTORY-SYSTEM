import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  buildManualJournalPostingRequest,
  resolveManualJournalClientRequestId,
} from "../server/services/accounting/manualJournalPosting";
import { PostingValidationError } from "../server/services/accounting/centralPostingEngine";

function baseInput() {
  return {
    companyId: 1,
    voucherNumber: "JOURNAL-TEST-1",
    voucherDate: "2026-07-25",
    notes: "Manual journal",
    currency: "USD",
    exchangeRate: null,
    effectiveDate: null,
    clientRequestId: "journal-request-1",
    actor: { userId: "user-1", username: "tester" },
    entries: [
      { type: "DR" as const, accountType: "ledger", accountId: 10, amount: "100" },
      { type: "CR" as const, accountType: "bank", accountId: 20, amount: "100" },
    ],
  };
}

describe("buildManualJournalPostingRequest", () => {
  it("builds a balanced USD central posting with one target per entry", () => {
    const built = buildManualJournalPostingRequest(baseInput());

    expect(built.request.voucher).toMatchObject({
      companyId: 1,
      voucherType: "Journal",
      totalAmount: "100.000000",
      currency: "USD",
      exchangeRate: null,
      optional: false,
    });
    expect(built.request.entries).toEqual([
      expect.objectContaining({
        ledgerAccountId: 10,
        debitAmount: "100.000000",
        creditAmount: "0.000000",
        historicalExchangeRate: "1.0000000000",
      }),
      expect.objectContaining({
        bankAccountId: 20,
        debitAmount: "0.000000",
        creditAmount: "100.000000",
        historicalExchangeRate: "1.0000000000",
      }),
    ]);
  });

  // Phase 22 A (D3): lines keep their exact base (the currency trigger refuses
  // an adjusted one); the engine posts the remainder to ROUNDING.
  it("keeps each CFA line's exact base and totals the header on the debit base", () => {
    const built = buildManualJournalPostingRequest({
      ...baseInput(),
      currency: "CFA",
      exchangeRate: "3",
      entries: [
        { type: "DR", accountType: "ledger", accountId: 10, amount: "1" },
        { type: "DR", accountType: "ledger", accountId: 11, amount: "1" },
        { type: "CR", accountType: "bank", accountId: 20, amount: "2" },
      ],
    });

    const debitTotal = built.request.entries.reduce((sum, entry) => sum.plus(entry.debitAmount ?? "0"), new Decimal(0));
    const creditTotal = built.request.entries.reduce(
      (sum, entry) => sum.plus(entry.creditAmount ?? "0"),
      new Decimal(0)
    );

    expect(debitTotal.toFixed(6)).toBe("0.666666");
    expect(creditTotal.toFixed(6)).toBe("0.666667");
    expect(built.request.entries.map((entry) => entry.baseDebitAmount)).toEqual(["0.333333", "0.333333", "0.000000"]);
    expect(built.request.voucher.totalAmount).toBe("0.666666");
    expect(built.request.voucher.exchangeRate).toBe("3");
  });

  it("keeps the idempotency key stable for the same request and changes it when payload changes", () => {
    const first = buildManualJournalPostingRequest(baseInput());
    const replay = buildManualJournalPostingRequest(baseInput());
    const changed = buildManualJournalPostingRequest({ ...baseInput(), notes: "Changed" });

    expect(replay.request.source.idempotencyKey).toBe(first.request.source.idempotencyKey);
    expect(changed.request.source.idempotencyKey).not.toBe(first.request.source.idempotencyKey);
  });

  it("rejects unsupported account types before any database write", () => {
    expect(() =>
      buildManualJournalPostingRequest({
        ...baseInput(),
        entries: [
          { type: "DR", accountType: "unknown", accountId: 10, amount: "100" },
          { type: "CR", accountType: "bank", accountId: 20, amount: "100" },
        ],
      })
    ).toThrowError(expect.objectContaining<PostingValidationError>({ code: "POSTING_TARGET_INVALID" }));
  });
});

describe("resolveManualJournalClientRequestId", () => {
  it("preserves a valid client request id and generates a safe fallback", () => {
    expect(resolveManualJournalClientRequestId("request-123")).toBe("request-123");
    expect(resolveManualJournalClientRequestId(null)).toMatch(/^server-[0-9a-f-]{36}$/);
  });

  it("rejects unsafe request ids", () => {
    expect(() => resolveManualJournalClientRequestId("bad request id")).toThrowError(
      expect.objectContaining<PostingValidationError>({ code: "POSTING_REQUEST_ID_INVALID" })
    );
  });
});
