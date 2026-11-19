import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_PHASE10_SOURCE_TYPE,
  GoldenCoastPhase10SettlementError,
  buildGoldenCoastPhase10SettlementPosting,
  goldenCoastPhase10IdempotencyKey,
  goldenCoastPhase10SettlementDigest,
  parseGoldenCoastPhase10SettlementInput,
  planGoldenCoastPhase10Settlement,
} from "./goldenCoastSalesCashSettlement";

function settlement(overrides: Record<string, unknown> = {}) {
  return parseGoldenCoastPhase10SettlementInput({
    companyId: 7,
    body: {
      settlementDate: "2026-09-01",
      amountUsd: "600.00",
      clientRequestId: "phase10-test-1",
      paymentAccount: { kind: "bank", id: 91 },
      reference: "Direct Fresh Start payment",
      ...overrides,
    },
  });
}

describe("Golden Coast Phase 10 direct Fresh Start payment", () => {
  it("parses a post-cutover partial payment payload", () => {
    expect(settlement()).toEqual({
      companyId: 7,
      settlementDate: "2026-09-01",
      amountUsd: "600.00",
      transferFeeUsd: "0.00",
      clientRequestId: "phase10-test-1",
      paymentAccount: { kind: "bank", id: 91 },
      reference: "Direct Fresh Start payment",
    });
  });

  it("accepts receiptAccount as a legacy alias but normalizes it to paymentAccount", () => {
    const parsed = settlement({
      paymentAccount: undefined,
      receiptAccount: { kind: "ledger", id: 55 },
    });
    expect(parsed.paymentAccount).toEqual({ kind: "ledger", id: 55 });
  });

  it("rejects pre-cutover dates, invalid request ids and sub-cent amounts", () => {
    expect(() => settlement({ settlementDate: "2026-08-31" })).toThrow(/cutover date/);
    expect(() => settlement({ clientRequestId: "bad request" })).toThrow(GoldenCoastPhase10SettlementError);
    expect(() => settlement({ amountUsd: "1.001" })).toThrow(/at most 2 decimal places/);
  });

  it("allows a partial payment against a credit GC Sales Cash payable", () => {
    const parsed = settlement({ amountUsd: "600.00" });
    expect(
      planGoldenCoastPhase10Settlement({
        settlement: parsed,
        gcSalesCashDebitBalanceUsd: "-1800.00",
      })
    ).toMatchObject({
      gcSalesCashDebitBalanceBeforeUsd: "-1800.00",
      gcSalesCashDebitBalanceAfterUsd: "-1200.00",
      gcSalesCashPayableBeforeUsd: "1800.00",
      gcSalesCashPayableAfterUsd: "1200.00",
    });
  });

  it("allows an exact full payment but never overpays", () => {
    const parsed = settlement({ amountUsd: "1800.00" });
    expect(
      planGoldenCoastPhase10Settlement({
        settlement: parsed,
        gcSalesCashDebitBalanceUsd: "-1800.00",
      })
    ).toMatchObject({
      gcSalesCashDebitBalanceAfterUsd: "0.00",
      gcSalesCashPayableAfterUsd: "0.00",
    });
    expect(() =>
      planGoldenCoastPhase10Settlement({
        settlement: parsed,
        gcSalesCashDebitBalanceUsd: "-1799.99",
      })
    ).toThrow(/exceeds the current GC Sales Cash payable/);
  });

  it("treats a zero or debit GC Sales Cash balance as having nothing payable", () => {
    expect(() =>
      planGoldenCoastPhase10Settlement({
        settlement: settlement({ amountUsd: "1.00" }),
        gcSalesCashDebitBalanceUsd: "0",
      })
    ).toThrow(/payable 0.00/);
    expect(() =>
      planGoldenCoastPhase10Settlement({
        settlement: settlement({ amountUsd: "1.00" }),
        gcSalesCashDebitBalanceUsd: "50",
      })
    ).toThrow(/payable 0.00/);
  });

  it("posts Dr GC Sales Cash / Cr selected bank through the central posting request", () => {
    const parsed = settlement({ amountUsd: "250.00" });
    const plan = planGoldenCoastPhase10Settlement({
      settlement: parsed,
      gcSalesCashDebitBalanceUsd: "-1000.00",
    });
    const digest = goldenCoastPhase10SettlementDigest({
      settlement: parsed,
      gcSalesCashAccountId: 44,
    });
    const posting = buildGoldenCoastPhase10SettlementPosting({
      plan,
      gcSalesCashAccountId: 44,
      settlementDigest: digest,
    });

    expect(posting.source).toEqual({
      sourceType: GOLDEN_COAST_PHASE10_SOURCE_TYPE,
      sourceId: `settlement:${digest}`,
      idempotencyKey: goldenCoastPhase10IdempotencyKey(7, "phase10-test-1"),
    });
    expect(posting.voucher.voucherType).toBe("Payment");
    expect(posting.entries).toHaveLength(2);
    expect(posting.entries[0]).toMatchObject({
      ledgerAccountId: 44,
      debitAmount: "250",
      creditAmount: "0",
    });
    expect(posting.entries[1]).toMatchObject({
      bankAccountId: 91,
      debitAmount: "0",
      creditAmount: "250",
    });
  });

  it("credits a selected Cash/Bank ledger account when the payment source is a ledger", () => {
    const parsed = settlement({
      amountUsd: "125.00",
      paymentAccount: { kind: "ledger", id: 55 },
    });
    const plan = planGoldenCoastPhase10Settlement({
      settlement: parsed,
      gcSalesCashDebitBalanceUsd: "-1000.00",
    });
    const digest = goldenCoastPhase10SettlementDigest({
      settlement: parsed,
      gcSalesCashAccountId: 44,
    });
    const posting = buildGoldenCoastPhase10SettlementPosting({
      plan,
      gcSalesCashAccountId: 44,
      settlementDigest: digest,
    });

    expect(posting.entries[1]).toMatchObject({
      ledgerAccountId: 55,
      debitAmount: "0",
      creditAmount: "125",
    });
    expect(posting.entries[1].bankAccountId).toBeUndefined();
  });

  it("binds idempotency to the material payload, payment routing and canonical account", () => {
    const base = settlement();
    const digest = goldenCoastPhase10SettlementDigest({
      settlement: base,
      gcSalesCashAccountId: 44,
    });
    const differentBank = settlement({
      paymentAccount: { kind: "bank", id: 92 },
    });
    const differentReference = settlement({ reference: "Different payment" });

    expect(
      goldenCoastPhase10SettlementDigest({
        settlement: differentBank,
        gcSalesCashAccountId: 44,
      })
    ).not.toBe(digest);
    expect(
      goldenCoastPhase10SettlementDigest({
        settlement: differentReference,
        gcSalesCashAccountId: 44,
      })
    ).not.toBe(digest);
    expect(
      goldenCoastPhase10SettlementDigest({
        settlement: base,
        gcSalesCashAccountId: 45,
      })
    ).not.toBe(digest);
    expect(goldenCoastPhase10IdempotencyKey(7, base.clientRequestId)).toContain(base.clientRequestId);
  });
});

/**
 * A payment can carry a bank or transfer fee. The fee is an expense, not a
 * discount on the debt, so the payable falls by the settlement alone while the
 * fee is booked to Shared Charges and the paying account funds both.
 */
describe("transfer fees on a Fresh Start payment", () => {
  it("defaults the fee to zero and rejects a negative or sub-cent fee", () => {
    expect(settlement().transferFeeUsd).toBe("0.00");
    expect(() => settlement({ transferFeeUsd: "-0.01" })).toThrow(/transferFeeUsd cannot be negative/);
    expect(() => settlement({ transferFeeUsd: "1.001" })).toThrow(/at most 2 decimal places/);
  });

  it("relieves the payable by the settlement and adds the fee to the cash outflow", () => {
    const plan = planGoldenCoastPhase10Settlement({
      settlement: settlement({ amountUsd: "600.00", transferFeeUsd: "12.50" }),
      gcSalesCashDebitBalanceUsd: "-1800.00",
    });

    expect(plan.gcSalesCashPayableBeforeUsd).toBe("1800.00");
    expect(plan.gcSalesCashPayableAfterUsd).toBe("1200.00");
    expect(plan.cashOutflowUsd).toBe("612.50");
  });

  it("never lets a fee widen the payable cap", () => {
    expect(() =>
      planGoldenCoastPhase10Settlement({
        settlement: settlement({ amountUsd: "120.00", transferFeeUsd: "40.00" }),
        gcSalesCashDebitBalanceUsd: "-100.00",
      })
    ).toThrow(/exceeds the current GC Sales Cash payable 100.00/);
  });

  it("posts the fee to Shared Charges and the combined outflow to the paying account", () => {
    const parsed = settlement({ amountUsd: "600.00", transferFeeUsd: "12.50" });
    const plan = planGoldenCoastPhase10Settlement({ settlement: parsed, gcSalesCashDebitBalanceUsd: "-1800.00" });
    const posting = buildGoldenCoastPhase10SettlementPosting({
      plan,
      gcSalesCashAccountId: 44,
      sharedChargesAccountId: 66,
      settlementDigest: goldenCoastPhase10SettlementDigest({
        settlement: parsed,
        gcSalesCashAccountId: 44,
        sharedChargesAccountId: 66,
      }),
    });

    expect(posting.entries).toHaveLength(3);
    expect(posting.entries[0]).toMatchObject({ ledgerAccountId: 44, debitAmount: "600", creditAmount: "0" });
    expect(posting.entries[1]).toMatchObject({ ledgerAccountId: 66, debitAmount: "12.5", creditAmount: "0" });
    expect(posting.entries[2]).toMatchObject({ bankAccountId: 91, debitAmount: "0", creditAmount: "612.5" });
  });

  it("requires a distinct Shared Charges account whenever a fee is charged", () => {
    const parsed = settlement({ amountUsd: "600.00", transferFeeUsd: "12.50" });
    const plan = planGoldenCoastPhase10Settlement({ settlement: parsed, gcSalesCashDebitBalanceUsd: "-1800.00" });
    const digest = goldenCoastPhase10SettlementDigest({ settlement: parsed, gcSalesCashAccountId: 44 });

    expect(() =>
      buildGoldenCoastPhase10SettlementPosting({ plan, gcSalesCashAccountId: 44, settlementDigest: digest })
    ).toThrow(/sharedChargesAccountId/);
    expect(() =>
      buildGoldenCoastPhase10SettlementPosting({
        plan,
        gcSalesCashAccountId: 44,
        sharedChargesAccountId: 44,
        settlementDigest: digest,
      })
    ).toThrow(/distinct accounts/);
  });

  it("omits the fee leg entirely when no fee is charged", () => {
    const parsed = settlement({ amountUsd: "600.00" });
    const plan = planGoldenCoastPhase10Settlement({ settlement: parsed, gcSalesCashDebitBalanceUsd: "-1800.00" });
    const posting = buildGoldenCoastPhase10SettlementPosting({
      plan,
      gcSalesCashAccountId: 44,
      settlementDigest: goldenCoastPhase10SettlementDigest({ settlement: parsed, gcSalesCashAccountId: 44 }),
    });

    expect(posting.entries).toHaveLength(2);
    expect(plan.cashOutflowUsd).toBe("600.00");
  });

  it("binds replay identity to the fee as well as the amount", () => {
    expect(
      goldenCoastPhase10SettlementDigest({ settlement: settlement({ transferFeeUsd: "0" }), gcSalesCashAccountId: 44 })
    ).not.toBe(
      goldenCoastPhase10SettlementDigest({
        settlement: settlement({ transferFeeUsd: "12.50" }),
        gcSalesCashAccountId: 44,
      })
    );
  });
});
