import { describe, expect, it } from "vitest";

import {
  buildGoldenCoastPhase1PostingRequest,
  getGoldenCoastPhase1CashRoleRequirements,
} from "./goldenCoastPosting";

const ledger = (id: number) => ({ kind: "ledger" as const, id });
const bank = (id: number) => ({ kind: "bank" as const, id });

describe("Golden Coast Phase 1 posting adapter", () => {
  it("marks contribution, payment and transfer counterparts as cash/bank roles", () => {
    expect(
      getGoldenCoastPhase1CashRoleRequirements({
        type: "partner_cash_contribution",
        amountUsd: 100_000,
        cashAccount: bank(1),
        partnerCapitalAccount: ledger(301),
        partnerName: "Fresh Start",
      })
    ).toEqual([{ account: bank(1), label: "event.cashAccount" }]);

    expect(
      getGoldenCoastPhase1CashRoleRequirements({
        type: "savings_transfer",
        amountUsd: 33_700,
        operatingCashAccount: ledger(101),
        savingsAccount: bank(2),
      })
    ).toEqual([
      { account: ledger(101), label: "event.operatingCashAccount" },
      { account: bank(2), label: "event.savingsAccount" },
    ]);
  });

  it("keeps a non-sale idempotency key stable when the retry payload changes", () => {
    const build = (amountUsd: number) =>
      buildGoldenCoastPhase1PostingRequest({
        companyId: 7,
        clientRequestId: "gc-contribution-001",
        voucherNumber: "GC-CAP-001",
        voucherDate: "2026-08-26",
        exchangeRate: null,
        event: {
          type: "partner_cash_contribution",
          amountUsd,
          cashAccount: bank(1),
          partnerCapitalAccount: ledger(301),
          partnerName: "Fresh Start",
        },
      });

    expect(build(100_000).request.source.idempotencyKey).toBe("golden-coast-phase1:gc-contribution-001");
    expect(build(110_000).request.source.idempotencyKey).toBe("golden-coast-phase1:gc-contribution-001");
  });
});
