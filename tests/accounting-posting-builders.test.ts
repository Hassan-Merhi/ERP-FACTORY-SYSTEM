import { describe, expect, it } from "vitest";
import {
  buildCompanyTransferPostingRequest,
  buildContainerSalePostingRequest,
  PostingValidationError,
  validateCentralPostingRequest,
} from "../server/services/accounting";

describe("Phase 3 accounting posting builders", () => {
  it("builds balanced and separately identified transfer legs", () => {
    const from = buildCompanyTransferPostingRequest({
      companyId: 1,
      voucherNumber: "TR-OUT-1",
      voucherType: "Payment",
      voucherDate: "2026-07-29",
      description: "Move cash",
      amount: "125.50",
      debitLedgerAccountId: 11,
      creditLedgerAccountId: 12,
      clientRequestId: "transfer-request-1",
      sourceType: "simple-company-transfer",
      sourceSide: "from",
    });
    const to = buildCompanyTransferPostingRequest({
      companyId: 2,
      voucherNumber: "TR-IN-1",
      voucherType: "Receipt",
      voucherDate: "2026-07-29",
      description: "Receive cash",
      amount: "125.50",
      debitLedgerAccountId: 21,
      creditLedgerAccountId: 22,
      clientRequestId: from.clientRequestId,
      sourceType: "simple-company-transfer",
      sourceSide: "to",
    });

    expect(validateCentralPostingRequest(from.request)).toEqual({
      debitTotal: "125.5",
      creditTotal: "125.5",
    });
    expect(validateCentralPostingRequest(to.request)).toEqual({
      debitTotal: "125.5",
      creditTotal: "125.5",
    });
    expect(from.request.source.idempotencyKey).not.toBe(to.request.source.idempotencyKey);
    expect(from.request.source.sourceId).toBe("transfer-request-1:from");
    expect(to.request.source.sourceId).toBe("transfer-request-1:to");
  });

  it("rejects a transfer leg that debits and credits the same account", () => {
    expect(() =>
      buildCompanyTransferPostingRequest({
        companyId: 1,
        voucherNumber: "TR-OUT-2",
        voucherType: "Payment",
        voucherDate: "2026-07-29",
        amount: "10",
        debitLedgerAccountId: 11,
        creditLedgerAccountId: 11,
        clientRequestId: "transfer-request-2",
        sourceType: "simple-company-transfer",
        sourceSide: "from",
      }),
    ).toThrow(PostingValidationError);
  });

  it("builds a deterministic balanced container-sale posting", () => {
    const first = buildContainerSalePostingRequest({
      companyId: 1,
      containerId: 99,
      voucherNumber: "CS-1",
      voucherDate: "2026-07-29",
      description: "Container sale",
      totalAmount: "5000.00",
      customerLedgerAccountId: 31,
      commissionAccountId: 32,
    });
    const retry = buildContainerSalePostingRequest({
      companyId: 1,
      containerId: 99,
      voucherNumber: "CS-2",
      voucherDate: "2026-07-29",
      description: "Container sale",
      totalAmount: "5000.00",
      customerLedgerAccountId: 31,
      commissionAccountId: 32,
    });

    expect(validateCentralPostingRequest(first.request)).toEqual({
      debitTotal: "5000",
      creditTotal: "5000",
    });
    expect(first.request.source.idempotencyKey).toBe(retry.request.source.idempotencyKey);
    expect(first.request.source.sourceId).toBe("1:99");
  });
});
