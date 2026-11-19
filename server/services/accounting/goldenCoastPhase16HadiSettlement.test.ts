import { describe, expect, it } from "vitest";
import {
  buildGoldenCoastPhase15SalesPayablePosting,
  goldenCoastPhase15SalesPayableDigest,
  type GoldenCoastPhase15SalesPayableInput,
} from "./goldenCoastSalesPayable";
import {
  buildGoldenCoastFreshStartHadiPaymentPostings,
  goldenCoastFreshStartHadiPaymentDigest,
  parseGoldenCoastFreshStartHadiPayment,
  planGoldenCoastFreshStartHadiPayment,
  type GoldenCoastFreshStartHadiPaymentAccounts,
} from "./goldenCoastFreshStartHadiPayment";

function netDebit(
  entries: ReadonlyArray<{ ledgerAccountId?: number | null; debitAmount: string; creditAmount: string }>,
  accountId: number
): number {
  return entries
    .filter((entry) => entry.ledgerAccountId === accountId)
    .reduce((sum, entry) => sum + Number(entry.debitAmount) - Number(entry.creditAmount), 0);
}

const freshStartEquityAccountId = 101;
const gcSalesCashAccountId = 102;
const gcHadiIntercompanyAccountId = 103;
const hadiGcIntercompanyAccountId = 201;

const paymentAccounts: GoldenCoastFreshStartHadiPaymentAccounts = {
  gcSalesCashAccountId,
  goldenCoastHadiIntercompanyAccountId: gcHadiIntercompanyAccountId,
  hadiGoldenCoastIntercompanyAccountId: hadiGcIntercompanyAccountId,
};

describe("Golden Coast Phase 16 HADI credit-payable settlement", () => {
  it("clears a Phase 15 payable from HADI without a second Fresh Start equity posting", () => {
    const sale: GoldenCoastPhase15SalesPayableInput = {
      companyId: 14,
      saleDate: "2026-09-15",
      amountUsd: "1000.00",
      clientRequestId: "phase16-sale-1",
      saleDigest: "phase16-sale-digest",
      freshStartEquityAccountId,
      gcSalesCashAccountId,
    };
    const saleDigest = goldenCoastPhase15SalesPayableDigest(sale);
    const saleBridge = buildGoldenCoastPhase15SalesPayablePosting({ sale, digest: saleDigest, exchangeRate: null });

    expect(netDebit(saleBridge.entries, freshStartEquityAccountId)).toBe(1000);
    expect(netDebit(saleBridge.entries, gcSalesCashAccountId)).toBe(-1000);

    const payment = parseGoldenCoastFreshStartHadiPayment({
      companyId: 14,
      hadiCompanyId: 1,
      body: {
        paymentDate: "2026-09-16",
        amountUsd: "1000.00",
        clientRequestId: "phase16-payment-1",
        reference: "Full Fresh Start settlement",
        hadiCashAccount: { kind: "ledger", id: 301 },
      },
    });
    const plan = planGoldenCoastFreshStartHadiPayment({
      payment,
      gcSalesCashPayableUsd: "1000.00",
      outstandingHadiSalesCashUsd: "1000.00",
      hadiIntercompanyAssetUsd: "1000.00",
    });
    const paymentDigest = goldenCoastFreshStartHadiPaymentDigest({ payment, accounts: paymentAccounts });
    const postings = buildGoldenCoastFreshStartHadiPaymentPostings({
      plan,
      accounts: paymentAccounts,
      digest: paymentDigest,
      goldenCoastExchangeRate: null,
      hadiExchangeRate: null,
    });
    const gcPayment = postings.find((posting) => posting.role === "golden_coast")!.request;

    expect(netDebit(gcPayment.entries, gcSalesCashAccountId)).toBe(1000);
    expect(netDebit(gcPayment.entries, gcHadiIntercompanyAccountId)).toBe(-1000);
    expect(gcPayment.entries.some((entry) => entry.ledgerAccountId === freshStartEquityAccountId)).toBe(false);
    expect(netDebit([...saleBridge.entries, ...gcPayment.entries], gcSalesCashAccountId)).toBe(0);
    expect(netDebit([...saleBridge.entries, ...gcPayment.entries], freshStartEquityAccountId)).toBe(1000);
    expect(plan.gcSalesCashPayableAfterUsd).toBe("0.00");
    expect(plan.outstandingHadiSalesCashAfterUsd).toBe("0.00");
    expect(plan.hadiIntercompanyAssetAfterUsd).toBe("0.00");
  });

  it("supports partial HADI settlement and leaves the remaining credit payable intact", () => {
    const payment = parseGoldenCoastFreshStartHadiPayment({
      companyId: 14,
      hadiCompanyId: 1,
      body: {
        paymentDate: "2026-09-16",
        amountUsd: "400.00",
        clientRequestId: "phase16-payment-partial",
        hadiCashAccount: { kind: "bank", id: 302 },
      },
    });
    const plan = planGoldenCoastFreshStartHadiPayment({
      payment,
      gcSalesCashPayableUsd: "1000.00",
      outstandingHadiSalesCashUsd: "1000.00",
      hadiIntercompanyAssetUsd: "1000.00",
    });

    expect(plan.gcSalesCashPayableAfterUsd).toBe("600.00");
    expect(plan.outstandingHadiSalesCashAfterUsd).toBe("600.00");
    expect(plan.hadiIntercompanyAssetAfterUsd).toBe("600.00");
  });
});
