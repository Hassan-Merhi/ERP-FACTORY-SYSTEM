import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_PHASE9_CONFIRMATION,
  GOLDEN_COAST_PHASE9_SOURCE_TYPE,
  GoldenCoastPhase9WithdrawalError,
  buildGoldenCoastPhase9WithdrawalPosting,
  goldenCoastPhase9IdempotencyKey,
  goldenCoastPhase9WithdrawalDigest,
  parseGoldenCoastPhase9WithdrawalInput,
  planGoldenCoastPhase9Withdrawal,
} from "./goldenCoastHassanSavingsWithdrawal";

function withdrawal(overrides: Record<string, unknown> = {}) {
  return parseGoldenCoastPhase9WithdrawalInput({
    companyId: 7,
    body: {
      withdrawalDate: "2026-09-01",
      amountUsd: "1600.00",
      clientRequestId: "phase9-test-1",
      paymentAccount: { kind: "bank", id: 91 },
      reference: "Owner payout",
      reason: "Hassan requested withdrawal",
      confirmation: GOLDEN_COAST_PHASE9_CONFIRMATION,
      ...overrides,
    },
  });
}

describe("Golden Coast Phase 9 Hassan Savings withdrawal", () => {
  it("parses a protected post-cutover withdrawal payload", () => {
    expect(withdrawal()).toEqual({
      companyId: 7,
      withdrawalDate: "2026-09-01",
      amountUsd: "1600.00",
      clientRequestId: "phase9-test-1",
      paymentAccount: { kind: "bank", id: 91 },
      reference: "Owner payout",
      reason: "Hassan requested withdrawal",
      confirmation: GOLDEN_COAST_PHASE9_CONFIRMATION,
    });
  });

  it("requires the exact withdrawal confirmation and a meaningful reason", () => {
    expect(() => withdrawal({ confirmation: "WITHDRAW" })).toThrow(GoldenCoastPhase9WithdrawalError);
    expect(() => withdrawal({ reason: "no" })).toThrow(/at least 5 characters/);
  });

  it("rejects pre-cutover dates and sub-cent amounts", () => {
    expect(() => withdrawal({ withdrawalDate: "2026-08-31" })).toThrow(/cutover date/);
    expect(() => withdrawal({ amountUsd: "1.001" })).toThrow(/at most 2 decimal places/);
  });

  it("caps withdrawals to the actual credit balance on Hassan Savings", () => {
    const parsed = withdrawal({ amountUsd: "600.00" });
    expect(planGoldenCoastPhase9Withdrawal({ withdrawal: parsed, savingsBalanceUsd: "1600.00" })).toMatchObject({
      savingsBalanceBeforeUsd: "1600.00",
      savingsBalanceAfterUsd: "1000.00",
    });
    expect(() => planGoldenCoastPhase9Withdrawal({ withdrawal: parsed, savingsBalanceUsd: "599.99" })).toThrow(
      /exceeds the available Hassan Savings balance/
    );
  });

  it("fails closed when the Hassan Savings credit balance is negative", () => {
    expect(() => planGoldenCoastPhase9Withdrawal({ withdrawal: withdrawal(), savingsBalanceUsd: "-1.00" })).toThrow(
      /negative credit balance/
    );
  });

  it("posts Dr Hassan Savings / Cr selected bank through the central posting request", () => {
    const parsed = withdrawal({ amountUsd: "250.00" });
    const plan = planGoldenCoastPhase9Withdrawal({ withdrawal: parsed, savingsBalanceUsd: "1000.00" });
    const digest = goldenCoastPhase9WithdrawalDigest({ withdrawal: parsed, hassanSavingsAccountId: 44 });
    const posting = buildGoldenCoastPhase9WithdrawalPosting({
      plan,
      hassanSavingsAccountId: 44,
      withdrawalDigest: digest,
    });

    expect(posting.source).toEqual({
      sourceType: GOLDEN_COAST_PHASE9_SOURCE_TYPE,
      sourceId: `withdrawal:${digest}`,
      idempotencyKey: goldenCoastPhase9IdempotencyKey(7, "phase9-test-1"),
    });
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

  it("credits a selected Cash/Bank ledger target when the payment account is a ledger", () => {
    const parsed = withdrawal({
      amountUsd: "125.00",
      paymentAccount: { kind: "ledger", id: 55 },
    });
    const plan = planGoldenCoastPhase9Withdrawal({ withdrawal: parsed, savingsBalanceUsd: "1000.00" });
    const digest = goldenCoastPhase9WithdrawalDigest({ withdrawal: parsed, hassanSavingsAccountId: 44 });
    const posting = buildGoldenCoastPhase9WithdrawalPosting({
      plan,
      hassanSavingsAccountId: 44,
      withdrawalDigest: digest,
    });

    expect(posting.entries[1]).toMatchObject({
      ledgerAccountId: 55,
      debitAmount: "0",
      creditAmount: "125",
    });
    expect(posting.entries[1].bankAccountId).toBeUndefined();
  });

  it("binds the digest to payment routing and material payload fields", () => {
    const base = withdrawal();
    const baseDigest = goldenCoastPhase9WithdrawalDigest({ withdrawal: base, hassanSavingsAccountId: 44 });
    const differentBank = withdrawal({ paymentAccount: { kind: "bank", id: 92 } });
    const differentReference = withdrawal({ reference: "Different payout" });

    expect(goldenCoastPhase9WithdrawalDigest({ withdrawal: differentBank, hassanSavingsAccountId: 44 })).not.toBe(
      baseDigest
    );
    expect(goldenCoastPhase9WithdrawalDigest({ withdrawal: differentReference, hassanSavingsAccountId: 44 })).not.toBe(
      baseDigest
    );
    expect(goldenCoastPhase9IdempotencyKey(7, base.clientRequestId)).toContain(base.clientRequestId);
  });
});
