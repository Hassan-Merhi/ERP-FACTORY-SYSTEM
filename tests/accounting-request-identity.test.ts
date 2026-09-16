import { describe, expect, it } from "vitest";
import {
  attachAccountingRequestIdentity,
  isProtectedAccountingRequest,
  releaseAccountingRequestIdentity,
  shouldReleaseAccountingRequestIdentity,
} from "../client/src/lib/accountingRequestIdentity";

const JOURNAL_URL = "/api/vouchers/journal";
const GENERIC_URL = "/api/vouchers/with-entries";
const PAYMENT_RECEIPT_URL = "/api/vouchers/payment-receipt";
const SIMPLE_TRANSFER_URL = "/api/simple-company-transfer";
const INTER_COMPANY_TRANSFER_URL = "/api/inter-company-transfers";

function journalPayload() {
  return {
    voucherDate: "2026-07-25",
    notes: "Retry-safe journal",
    optional: false,
    entries: [
      { type: "DR", accountType: "ledger", accountId: 10, amount: "50" },
      { type: "CR", accountType: "bank", accountId: 20, amount: "50" },
    ],
  };
}

function genericPayload() {
  return {
    voucher: {
      voucherNumber: "INS-CHARGE-1",
      voucherType: "Journal",
      voucherDate: "2026-07-25",
      optional: false,
    },
    entries: [
      { ledgerAccountId: 10, debitAmount: "25.00", creditAmount: "0" },
      { ledgerAccountId: 20, debitAmount: "0", creditAmount: "25.00" },
    ],
  };
}

function paymentReceiptPayload() {
  return {
    voucherType: "Payment",
    voucherDate: "2026-07-25",
    paymentAccountType: "bank",
    paymentAccountId: 10,
    optional: false,
    entries: [{ accountType: "ledger", accountId: 20, amount: "75" }],
  };
}

function transferPayload() {
  return {
    transferType: "Cash",
    fromCompanyId: 1,
    toCompanyId: 2,
    transferDate: "2026-07-25",
    amount: "125.00",
    fromLedgerAccountId: 10,
    toLedgerAccountId: 20,
  };
}

describe("accounting request identity", () => {
  it("reuses the same identity for the same uncertain journal retry", () => {
    const first = attachAccountingRequestIdentity("POST", JOURNAL_URL, journalPayload()) as Record<string, unknown>;
    const retry = attachAccountingRequestIdentity("POST", JOURNAL_URL, journalPayload()) as Record<string, unknown>;

    expect(typeof first.clientRequestId).toBe("string");
    expect(retry.clientRequestId).toBe(first.clientRequestId);

    releaseAccountingRequestIdentity("POST", JOURNAL_URL, first);
  });

  it("protects active generic vouchers and reuses their uncertain retry identity", () => {
    const first = attachAccountingRequestIdentity("POST", GENERIC_URL, genericPayload()) as Record<string, unknown>;
    const retry = attachAccountingRequestIdentity("POST", GENERIC_URL, genericPayload()) as Record<string, unknown>;

    expect(isProtectedAccountingRequest("POST", GENERIC_URL, first)).toBe(true);
    expect(typeof first.clientRequestId).toBe("string");
    expect(retry.clientRequestId).toBe(first.clientRequestId);

    releaseAccountingRequestIdentity("POST", GENERIC_URL, first);
  });

  it("protects active Payment/Receipt creation and reuses its uncertain retry identity", () => {
    const first = attachAccountingRequestIdentity("POST", PAYMENT_RECEIPT_URL, paymentReceiptPayload()) as Record<
      string,
      unknown
    >;
    const retry = attachAccountingRequestIdentity("POST", PAYMENT_RECEIPT_URL, paymentReceiptPayload()) as Record<
      string,
      unknown
    >;

    expect(isProtectedAccountingRequest("POST", PAYMENT_RECEIPT_URL, first)).toBe(true);
    expect(typeof first.clientRequestId).toBe("string");
    expect(retry.clientRequestId).toBe(first.clientRequestId);

    releaseAccountingRequestIdentity("POST", PAYMENT_RECEIPT_URL, first);
  });

  it("protects both company-transfer posting routes", () => {
    for (const url of [SIMPLE_TRANSFER_URL, INTER_COMPANY_TRANSFER_URL]) {
      const first = attachAccountingRequestIdentity("POST", url, transferPayload()) as Record<string, unknown>;
      const retry = attachAccountingRequestIdentity("POST", url, transferPayload()) as Record<string, unknown>;

      expect(isProtectedAccountingRequest("POST", url, first)).toBe(true);
      expect(typeof first.clientRequestId).toBe("string");
      expect(retry.clientRequestId).toBe(first.clientRequestId);
      releaseAccountingRequestIdentity("POST", url, first);
    }
  });

  it("releases an acknowledged identity so a later intentional journal is new", () => {
    const first = attachAccountingRequestIdentity("POST", JOURNAL_URL, journalPayload()) as Record<string, unknown>;
    releaseAccountingRequestIdentity("POST", JOURNAL_URL, first);
    const later = attachAccountingRequestIdentity("POST", JOURNAL_URL, journalPayload()) as Record<string, unknown>;

    expect(later.clientRequestId).not.toBe(first.clientRequestId);
    releaseAccountingRequestIdentity("POST", JOURNAL_URL, later);
  });

  it("preserves an identity already stored in an offline replay body", () => {
    const queued = { ...genericPayload(), clientRequestId: "queued-request-1" };
    expect(attachAccountingRequestIdentity("POST", GENERIC_URL, queued)).toBe(queued);
  });

  it("does not add an identity to optional protected writes or unrelated requests", () => {
    const optionalJournal = { ...journalPayload(), optional: true };
    expect(attachAccountingRequestIdentity("POST", JOURNAL_URL, optionalJournal)).toBe(optionalJournal);

    const optionalVoucher = {
      ...genericPayload(),
      voucher: { ...genericPayload().voucher, optional: true },
    };
    expect(attachAccountingRequestIdentity("POST", GENERIC_URL, optionalVoucher)).toBe(optionalVoucher);

    const optionalPayment = { ...paymentReceiptPayload(), optional: true };
    expect(attachAccountingRequestIdentity("POST", PAYMENT_RECEIPT_URL, optionalPayment)).toBe(optionalPayment);

    const unrelated = journalPayload();
    expect(attachAccountingRequestIdentity("POST", "/api/vouchers/payment", unrelated)).toBe(unrelated);
  });

  it("releases only successful or definite client-error outcomes", () => {
    expect(shouldReleaseAccountingRequestIdentity(200)).toBe(true);
    expect(shouldReleaseAccountingRequestIdentity(422, "VALIDATION_ERROR")).toBe(true);
    expect(shouldReleaseAccountingRequestIdentity(409, "POSTING_IDEMPOTENCY_CONFLICT")).toBe(true);
    expect(shouldReleaseAccountingRequestIdentity(409)).toBe(false);
    expect(shouldReleaseAccountingRequestIdentity(409, "ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN")).toBe(false);
    expect(shouldReleaseAccountingRequestIdentity(500)).toBe(false);
    expect(shouldReleaseAccountingRequestIdentity(503)).toBe(false);
  });
});
