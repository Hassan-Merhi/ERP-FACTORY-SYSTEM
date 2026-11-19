import { describe, expect, it } from "vitest";

import {
  buildGoldenCoastPhase8FundingPosting,
  parseGoldenCoastPhase8ContainerInput,
  planGoldenCoastPhase8Funding,
} from "./goldenCoastContainerOffload";

const phase8Accounts = {
  stockOtwAccountId: 10,
  stockInHandAccountId: 11,
  containerReserveAccountId: 12,
  hassanEquityAccountId: 13,
  hassanSavingsAccountId: 14,
};

describe("Golden Coast Phase 13 accounting boundary regressions", () => {
  it("keeps every post-cutover Phase 8 container cash-funded even when the supplier is Fresh Start", () => {
    const container = parseGoldenCoastPhase8ContainerInput({
      companyId: 7,
      body: {
        clientRequestId: "phase13-phase8-boundary",
        supplierName: "Fresh Start",
        containerNumber: "FS-POST-CUTOVER",
        invoiceNumber: "FS-POST-CUTOVER",
        invoiceDate: "2026-09-05",
        reserveUsd: "22300",
        fundingAccount: { kind: "ledger", id: 99 },
        lines: [{ stockItemId: 1, articleCode: "BAG", qty: "2000", unitRateUsd: "22" }],
      },
    });
    const plan = planGoldenCoastPhase8Funding(container);
    const posting = buildGoldenCoastPhase8FundingPosting({ container, plan, accounts: phase8Accounts });

    expect(plan.goodsCostUsd).toBe("44000.00");
    expect(plan.reserveUsd).toBe("22300.00");
    expect(posting.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ledgerAccountId: phase8Accounts.stockOtwAccountId, debitAmount: "44000" }),
        expect.objectContaining({ ledgerAccountId: phase8Accounts.containerReserveAccountId, debitAmount: "22300" }),
        expect.objectContaining({ ledgerAccountId: 99, creditAmount: "66300" }),
      ])
    );
    expect(posting.entries.some((entry) => entry.ledgerAccountId === phase8Accounts.hassanEquityAccountId)).toBe(false);
    expect(posting.entries.some((entry) => entry.ledgerAccountId === phase8Accounts.hassanSavingsAccountId)).toBe(
      false
    );
  });

  it("does not expose a post-cutover contributed-container switch through the Phase 8 parser", () => {
    const container = parseGoldenCoastPhase8ContainerInput({
      companyId: 7,
      body: {
        clientRequestId: "phase13-no-runtime-contribution-mode",
        supplierName: "Fresh Start",
        invoiceNumber: "NO-CONTRIBUTION-MODE",
        invoiceDate: "2026-09-05",
        reserveUsd: "0",
        fundingAccount: { kind: "bank", id: 77 },
        fundingMode: "fresh_start_contribution",
        lines: [{ stockItemId: 1, articleCode: "BAG", qty: "1", unitRateUsd: "22" }],
      },
    });

    expect(container.fundingAccount).toEqual({ kind: "bank", id: 77 });
    expect(Object.prototype.hasOwnProperty.call(container, "fundingMode")).toBe(false);
  });
});
