import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  GoldenCoastPhase7TransferError,
  buildGoldenCoastPhase7TransferPostings,
  goldenCoastPhase7IdempotencyKey,
  goldenCoastPhase7SourceId,
  goldenCoastPhase7TransferDigest,
  parseGoldenCoastPhase7TransferInput,
  planGoldenCoastPhase7Transfer,
  type GoldenCoastPhase7RoleAccounts,
  type GoldenCoastPhase7TransferInput,
} from "./goldenCoastHadiTransfer";

const accounts: GoldenCoastPhase7RoleAccounts = {
  gcSalesCashAccountId: 101,
  goldenCoastHadiIntercompanyAccountId: 102,
  hadiGoldenCoastIntercompanyAccountId: 201,
};

function parsedCollect(overrides: Record<string, unknown> = {}): GoldenCoastPhase7TransferInput {
  return parseGoldenCoastPhase7TransferInput({
    companyId: 14,
    parentCompanyId: 1,
    body: {
      operation: "collect_via_hadi",
      transferDate: "2026-09-10",
      amountUsd: "600.00",
      clientRequestId: "collect-001",
      reference: "September sales cash",
      hadiCashAccount: { kind: "bank", id: 301 },
      ...overrides,
    },
  });
}

function parsedRemit(overrides: Record<string, unknown> = {}): GoldenCoastPhase7TransferInput {
  return parseGoldenCoastPhase7TransferInput({
    companyId: 14,
    parentCompanyId: 1,
    body: {
      operation: "remit_from_hadi",
      transferDate: "2026-09-11",
      amountUsd: "250.00",
      clientRequestId: "remit-001",
      reference: "Partial HADI remittance",
      hadiCashAccount: { kind: "bank", id: 301 },
      goldenCoastCashAccount: { kind: "ledger", id: 401 },
      ...overrides,
    },
  });
}

function expectTransferError(fn: () => unknown, code?: GoldenCoastPhase7TransferError["code"]): void {
  try {
    fn();
    throw new Error("Expected GoldenCoastPhase7TransferError");
  } catch (error) {
    expect(error).toBeInstanceOf(GoldenCoastPhase7TransferError);
    if (code) expect((error as GoldenCoastPhase7TransferError).code).toBe(code);
  }
}

describe("Golden Coast Phase 7 HADI transfer planner", () => {
  it("parses a HADI collection without inventing a Golden Coast cash destination", () => {
    const transfer = parsedCollect();
    expect(transfer).toMatchObject({
      companyId: 14,
      parentCompanyId: 1,
      operation: "collect_via_hadi",
      amountUsd: "600.00",
      clientRequestId: "collect-001",
      goldenCoastCashAccount: null,
      hadiCashAccount: { kind: "bank", id: 301 },
    });
  });

  it("requires a Golden Coast cash destination for a HADI remittance", () => {
    const transfer = parsedRemit();
    expect(transfer.goldenCoastCashAccount).toEqual({ kind: "ledger", id: 401 });

    expectTransferError(() => parsedRemit({ goldenCoastCashAccount: null }));
  });

  it("rejects a Golden Coast cash account on collection because HADI physically holds that cash", () => {
    expectTransferError(() => parsedCollect({ goldenCoastCashAccount: { kind: "ledger", id: 401 } }));
  });

  it("rejects an invalid operation", () => {
    expectTransferError(() => parsedCollect({ operation: "generic_transfer" }));
  });

  it("rejects zero, negative and over-precision amounts", () => {
    expectTransferError(() => parsedCollect({ amountUsd: "0" }));
    expectTransferError(() => parsedCollect({ amountUsd: "-1" }));
    expectTransferError(() => parsedCollect({ amountUsd: "1.001" }));
  });

  it("rejects pre-cutover transfer dates", () => {
    expectTransferError(() => parsedCollect({ transferDate: "2026-08-31" }), "GC_PHASE7_PRE_CUTOVER_DATE");
  });

  it("rejects same-company parent routing", () => {
    expectTransferError(
      () =>
        parseGoldenCoastPhase7TransferInput({
          companyId: 14,
          parentCompanyId: 14,
          body: {
            operation: "collect_via_hadi",
            transferDate: "2026-09-10",
            amountUsd: "10",
            clientRequestId: "same-company",
            hadiCashAccount: { kind: "bank", id: 1 },
          },
        }),
      "GC_PHASE7_SCOPE_INVALID"
    );
  });

  it("rejects unsupported or missing cash account targets", () => {
    expectTransferError(() => parsedCollect({ hadiCashAccount: { kind: "customer", id: 301 } }));
    expectTransferError(() => parsedCollect({ hadiCashAccount: null }));
  });

  it("raises the GC Sales Cash payable by the collected amount", () => {
    const plan = planGoldenCoastPhase7Transfer({
      transfer: parsedCollect(),
      balances: {
        // Signed Dr-minus-Cr: -1,800.00 is a payable of 1,800.00.
        gcSalesCashDebitBalanceUsd: "-1800.00",
        outstandingHadiCollectionsUsd: "100.00",
      },
    });

    expect(plan.gcSalesCashPayableBeforeUsd).toBe("1800.00");
    expect(plan.gcSalesCashPayableAfterUsd).toBe("2400.00");
    expect(plan.outstandingHadiCollectionsBeforeUsd).toBe("100.00");
    expect(plan.outstandingHadiCollectionsAfterUsd).toBe("700.00");
  });

  it("does not cap a collection against the payable it grows", () => {
    // The old receivable reading capped a collection at a positive Dr balance
    // on GC Sales Cash. A collection raises the payable, so capping it against
    // the very account it grows was the contradiction Phase 15/17 removed.
    const plan = planGoldenCoastPhase7Transfer({
      transfer: parsedCollect({ amountUsd: "1800" }),
      balances: { gcSalesCashDebitBalanceUsd: "0", outstandingHadiCollectionsUsd: "0" },
    });
    expect(plan.gcSalesCashPayableAfterUsd).toBe("1800.00");
    expect(plan.outstandingHadiCollectionsAfterUsd).toBe("1800.00");
  });

  it("collects normally even when GC Sales Cash has been overpaid", () => {
    const plan = planGoldenCoastPhase7Transfer({
      transfer: parsedCollect({ amountUsd: "1" }),
      // A positive signed balance means GC Sales Cash has been OVERPAID.
      balances: { gcSalesCashDebitBalanceUsd: "50", outstandingHadiCollectionsUsd: "0" },
    });
    expect(plan.gcSalesCashPayableBeforeUsd).toBe("-50.00");
    expect(plan.gcSalesCashPayableAfterUsd).toBe("-49.00");
  });

  it("plans a HADI remittance only against unremitted Phase 7 collections", () => {
    const plan = planGoldenCoastPhase7Transfer({
      transfer: parsedRemit(),
      balances: {
        gcSalesCashDebitBalanceUsd: "-1200.00",
        outstandingHadiCollectionsUsd: "700.00",
      },
    });

    // A remittance moves cash between the two companies; it never touches the
    // payable Golden Coast owes Fresh Start.
    expect(plan.gcSalesCashPayableAfterUsd).toBe("1200.00");
    expect(plan.outstandingHadiCollectionsBeforeUsd).toBe("700.00");
    expect(plan.outstandingHadiCollectionsAfterUsd).toBe("450.00");
  });

  it("rejects remittance of unrelated historical intercompany balances", () => {
    expectTransferError(
      () =>
        planGoldenCoastPhase7Transfer({
          transfer: parsedRemit({ amountUsd: "700.01" }),
          balances: {
            gcSalesCashDebitBalanceUsd: "-1200.00",
            outstandingHadiCollectionsUsd: "700.00",
          },
        }),
      "GC_PHASE7_REMITTANCE_EXCEEDS_COLLECTIONS"
    );
  });

  it("fails closed if Phase 7 history reports more remitted than collected", () => {
    expectTransferError(
      () =>
        planGoldenCoastPhase7Transfer({
          transfer: parsedRemit({ amountUsd: "1" }),
          balances: {
            gcSalesCashDebitBalanceUsd: "100",
            outstandingHadiCollectionsUsd: "-0.01",
          },
        }),
      "GC_PHASE7_SCOPE_INVALID"
    );
  });

  it("builds collection journals as GC Dr intercompany / Cr GC Sales Cash and HADI Dr cash / Cr intercompany", () => {
    const transfer = parsedCollect();
    const plan = planGoldenCoastPhase7Transfer({
      transfer,
      balances: { gcSalesCashDebitBalanceUsd: "1800", outstandingHadiCollectionsUsd: "0" },
    });
    const transferDigest = goldenCoastPhase7TransferDigest({ transfer, accounts });
    const batch = buildGoldenCoastPhase7TransferPostings({
      plan,
      accounts,
      transferDigest,
      goldenCoastExchangeRate: null,
      hadiExchangeRate: null,
    });

    const gc = batch.postings.find((posting) => posting.role === "golden_coast")?.request;
    const hadi = batch.postings.find((posting) => posting.role === "hadi")?.request;
    expect(gc?.voucher.companyId).toBe(14);
    expect(hadi?.voucher.companyId).toBe(1);
    expect(gc?.voucher.totalAmount).toBe("600.00");
    expect(hadi?.voucher.totalAmount).toBe("600.00");
    expect(gc?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ledgerAccountId: 102, debitAmount: "600", creditAmount: "0" }),
        expect.objectContaining({ ledgerAccountId: 101, debitAmount: "0", creditAmount: "600" }),
      ])
    );
    expect(hadi?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bankAccountId: 301, debitAmount: "600", creditAmount: "0" }),
        expect.objectContaining({ ledgerAccountId: 201, debitAmount: "0", creditAmount: "600" }),
      ])
    );
  });

  it("builds remittance journals as GC Dr cash / Cr intercompany and HADI Dr intercompany / Cr cash", () => {
    const transfer = parsedRemit();
    const plan = planGoldenCoastPhase7Transfer({
      transfer,
      balances: { gcSalesCashDebitBalanceUsd: "1200", outstandingHadiCollectionsUsd: "700" },
    });
    const transferDigest = goldenCoastPhase7TransferDigest({ transfer, accounts });
    const batch = buildGoldenCoastPhase7TransferPostings({
      plan,
      accounts,
      transferDigest,
      goldenCoastExchangeRate: null,
      hadiExchangeRate: null,
    });

    const gc = batch.postings.find((posting) => posting.role === "golden_coast")?.request;
    const hadi = batch.postings.find((posting) => posting.role === "hadi")?.request;
    expect(gc?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ledgerAccountId: 401, debitAmount: "250", creditAmount: "0" }),
        expect.objectContaining({ ledgerAccountId: 102, debitAmount: "0", creditAmount: "250" }),
      ])
    );
    expect(hadi?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ledgerAccountId: 201, debitAmount: "250", creditAmount: "0" }),
        expect.objectContaining({ bankAccountId: 301, debitAmount: "0", creditAmount: "250" }),
      ])
    );
    expect(gc?.entries.some((entry) => entry.ledgerAccountId === 101)).toBe(false);
  });

  it("keeps Fresh Start equity, Hassan equity, Hassan Savings, Sales, COGS and inventory out of Phase 7 postings", () => {
    const transfer = parsedCollect();
    const plan = planGoldenCoastPhase7Transfer({
      transfer,
      balances: { gcSalesCashDebitBalanceUsd: "1800", outstandingHadiCollectionsUsd: "0" },
    });
    const transferDigest = goldenCoastPhase7TransferDigest({ transfer, accounts });
    const batch = buildGoldenCoastPhase7TransferPostings({
      plan,
      accounts,
      transferDigest,
      goldenCoastExchangeRate: null,
      hadiExchangeRate: null,
    });
    const ledgerIds = batch.postings.flatMap((posting) =>
      posting.request.entries.map((entry) => entry.ledgerAccountId).filter((id): id is number => id != null)
    );
    expect(new Set(ledgerIds)).toEqual(new Set([101, 102, 201]));
  });

  it("uses payload-bound deterministic digests", () => {
    const original = parsedCollect();
    const same = parsedCollect();
    const changedAmount = parsedCollect({ amountUsd: "601" });
    const changedHadiAccount = parsedCollect({ hadiCashAccount: { kind: "bank", id: 302 } });

    expect(goldenCoastPhase7TransferDigest({ transfer: original, accounts })).toBe(
      goldenCoastPhase7TransferDigest({ transfer: same, accounts })
    );
    expect(goldenCoastPhase7TransferDigest({ transfer: original, accounts })).not.toBe(
      goldenCoastPhase7TransferDigest({ transfer: changedAmount, accounts })
    );
    expect(goldenCoastPhase7TransferDigest({ transfer: original, accounts })).not.toBe(
      goldenCoastPhase7TransferDigest({ transfer: changedHadiAccount, accounts })
    );
  });

  it("keeps one company/request identity across operations so changed economic data conflicts on replay", () => {
    expect(goldenCoastPhase7IdempotencyKey(14, "request-1", "golden_coast")).toBe(
      `${GOLDEN_COAST_PHASE7_SOURCE_TYPE}:14:request-1:golden_coast`
    );
    expect(goldenCoastPhase7IdempotencyKey(14, "request-1", "hadi")).toBe(
      `${GOLDEN_COAST_PHASE7_SOURCE_TYPE}:14:request-1:hadi`
    );
  });

  it("tags source IDs with operation, digest and posting role", () => {
    expect(goldenCoastPhase7SourceId("collect_via_hadi", "abc123", "golden_coast")).toBe(
      "collect_via_hadi:abc123:golden_coast"
    );
    expect(goldenCoastPhase7SourceId("remit_from_hadi", "abc123", "hadi")).toBe("remit_from_hadi:abc123:hadi");
  });

  it("refuses a collapsed GC Sales Cash/intercompany account mapping", () => {
    const transfer = parsedCollect();
    const badAccounts = {
      ...accounts,
      goldenCoastHadiIntercompanyAccountId: accounts.gcSalesCashAccountId,
    };
    const plan = planGoldenCoastPhase7Transfer({
      transfer,
      balances: { gcSalesCashDebitBalanceUsd: "1800", outstandingHadiCollectionsUsd: "0" },
    });
    expectTransferError(
      () =>
        buildGoldenCoastPhase7TransferPostings({
          plan,
          accounts: badAccounts,
          transferDigest: goldenCoastPhase7TransferDigest({ transfer, accounts: badAccounts }),
          goldenCoastExchangeRate: null,
          hadiExchangeRate: null,
        }),
      "GC_PHASE7_SCOPE_INVALID"
    );
  });
});
