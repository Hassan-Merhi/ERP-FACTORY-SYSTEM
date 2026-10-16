import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_PHASE11_SPLIT_PCT,
  buildGoldenCoastPhase11MonthlyClosePosting,
  goldenCoastPhase11CloseDigest,
  parseGoldenCoastPhase11CloseInput,
  planGoldenCoastPhase11MonthlyClose,
} from "./goldenCoastPhase11MonthlyClose";

const accounts = {
  salesAccountId: 11,
  cogsAccountId: 12,
  sharedChargesAccountId: 13,
  profitPendingDistributionAccountId: 14,
  freshStartEquityAccountId: 15,
  hassanEquityAccountId: 16,
};

function close(periodMonth = "2026-09") {
  return parseGoldenCoastPhase11CloseInput({
    companyId: 7,
    body: { periodMonth, clientRequestId: "close-2026-09", reference: "September close" },
  });
}

function entries(request: ReturnType<typeof buildGoldenCoastPhase11MonthlyClosePosting>) {
  return request.entries.map((entry) => ({
    ledgerAccountId: entry.ledgerAccountId,
    debitAmount: Number(entry.debitAmount),
    creditAmount: Number(entry.creditAmount),
  }));
}

describe("Golden Coast Phase 11 monthly close", () => {
  it("locks the split at 50/50", () => {
    expect(GOLDEN_COAST_PHASE11_SPLIT_PCT).toBe("50.00");
    const plan = planGoldenCoastPhase11MonthlyClose({
      close: close(),
      totalRevenueUsd: "1800.00",
      totalCogsUsd: "660.00",
      totalSharedChargesUsd: "0.00",
    });
    expect(plan.netProfitLossUsd).toBe("1140.00");
    expect(plan.freshStartShareUsd).toBe("570.00");
    expect(plan.hassanShareUsd).toBe("570.00");
  });

  it("splits a monthly loss equally", () => {
    const plan = planGoldenCoastPhase11MonthlyClose({
      close: close(),
      totalRevenueUsd: "500.00",
      totalCogsUsd: "700.00",
      totalSharedChargesUsd: "100.00",
    });
    expect(plan.netProfitLossUsd).toBe("-300.00");
    expect(plan.freshStartShareUsd).toBe("-150.00");
    expect(plan.hassanShareUsd).toBe("-150.00");
  });

  it("keeps Profit Pending Distribution net zero for a profit close", () => {
    const plan = planGoldenCoastPhase11MonthlyClose({
      close: close(),
      totalRevenueUsd: "1800.00",
      totalCogsUsd: "660.00",
      totalSharedChargesUsd: "40.00",
    });
    const digest = goldenCoastPhase11CloseDigest({ plan, accounts });
    const posting = buildGoldenCoastPhase11MonthlyClosePosting({ plan, accounts, digest });
    const ppd = entries(posting).filter(
      (entry) => entry.ledgerAccountId === accounts.profitPendingDistributionAccountId
    );
    const debit = ppd.reduce((sum, entry) => sum + Number(entry.debitAmount), 0);
    const credit = ppd.reduce((sum, entry) => sum + Number(entry.creditAmount), 0);
    expect(debit).toBe(credit);
    expect(entries(posting)).toContainEqual({ ledgerAccountId: 15, debitAmount: 0, creditAmount: 550 });
    expect(entries(posting)).toContainEqual({ ledgerAccountId: 16, debitAmount: 0, creditAmount: 550 });
  });

  it("keeps Profit Pending Distribution net zero for a loss close", () => {
    const plan = planGoldenCoastPhase11MonthlyClose({
      close: close(),
      totalRevenueUsd: "500.00",
      totalCogsUsd: "700.00",
      totalSharedChargesUsd: "100.00",
    });
    const digest = goldenCoastPhase11CloseDigest({ plan, accounts });
    const posting = buildGoldenCoastPhase11MonthlyClosePosting({ plan, accounts, digest });
    const ppd = entries(posting).filter(
      (entry) => entry.ledgerAccountId === accounts.profitPendingDistributionAccountId
    );
    expect(ppd.reduce((sum, entry) => sum + Number(entry.debitAmount) - Number(entry.creditAmount), 0)).toBe(0);
    expect(entries(posting)).toContainEqual({ ledgerAccountId: 15, debitAmount: 150, creditAmount: 0 });
    expect(entries(posting)).toContainEqual({ ledgerAccountId: 16, debitAmount: 150, creditAmount: 0 });
  });

  it("never touches Hassan Savings, GC Sales Cash, stock, reserve, or HADI roles", () => {
    const plan = planGoldenCoastPhase11MonthlyClose({
      close: close(),
      totalRevenueUsd: "100.00",
      totalCogsUsd: "40.00",
      totalSharedChargesUsd: "0.00",
    });
    const posting = buildGoldenCoastPhase11MonthlyClosePosting({
      plan,
      accounts,
      digest: goldenCoastPhase11CloseDigest({ plan, accounts }),
    });
    expect(
      entries(posting)
        .map((entry) => entry.ledgerAccountId)
        .sort((a, b) => Number(a) - Number(b))
    ).toEqual([11, 12, 14, 14, 14, 15, 16]);
  });


  it("keeps developer correction balanced in the same closing Journal", () => {
    for (const manualAdjustmentUsd of ["200.00", "-200.00"]) {
      const plan = planGoldenCoastPhase11MonthlyClose({
        close: close(),
        totalRevenueUsd: "1000.00",
        totalCogsUsd: "500.00",
        totalSharedChargesUsd: "100.00",
        manualAdjustmentUsd,
      });
      const post = buildGoldenCoastPhase11MonthlyClosePosting({
        plan,
        accounts: { ...accounts, correctionSuspenseAccountId: 17 },
        digest: goldenCoastPhase11CloseDigest({
          plan, accounts: { ...accounts, correctionSuspenseAccountId: 17 },
        }),
      });
      const lines = entries(post);
      expect(lines.filter(line => line.ledgerAccountId === 17)).toHaveLength(1);
      const totalDr = lines.reduce((s, line) => s + line.debitAmount, 0);
      const totalCr = lines.reduce((s, line) => s + line.creditAmount, 0);
      expect(totalDr).toBe(totalCr);
      expect(lines.filter(line => line.ledgerAccountId === 14)
        .reduce((s, line) => s + line.debitAmount - line.creditAmount, 0)).toBe(0);
      expect(plan.netProfitLossUsd).toBe(manualAdjustmentUsd === "200.00" ? "600.00" : "200.00");
      expect(plan.freshStartShareUsd).toBe(manualAdjustmentUsd === "200.00" ? "300.00" : "100.00");
      expect(plan.hassanShareUsd).toBe(plan.freshStartShareUsd);
    }
  });

  it("refuses a correction without its reconciliable suspense account", () => {
    const plan = planGoldenCoastPhase11MonthlyClose({
      close: close(),
      totalRevenueUsd: "1000", totalCogsUsd: "500", totalSharedChargesUsd: "100",
      manualAdjustmentUsd: "25.00",
    });
    expect(() => buildGoldenCoastPhase11MonthlyClosePosting({
      plan, accounts, digest: goldenCoastPhase11CloseDigest({ plan, accounts }),
    })).toThrow(/suspense ledger/i);
  });

  it("allows pre-cutover reporting months and still rejects months without activity", () => {
    expect(close("2026-08").periodMonth).toBe("2026-08");
    expect(() =>
      planGoldenCoastPhase11MonthlyClose({
        close: close(),
        totalRevenueUsd: "0",
        totalCogsUsd: "0",
        totalSharedChargesUsd: "0",
      })
    ).toThrowError(/no closeable Golden Coast activity/i);
  });

  it("uses a deterministic per-period posting identity", () => {
    const plan = planGoldenCoastPhase11MonthlyClose({
      close: close(),
      totalRevenueUsd: "100.00",
      totalCogsUsd: "40.00",
      totalSharedChargesUsd: "0.00",
    });
    const digest = goldenCoastPhase11CloseDigest({ plan, accounts });
    const posting = buildGoldenCoastPhase11MonthlyClosePosting({ plan, accounts, digest });
    expect(posting.source.idempotencyKey).toBe("golden-coast-phase11-monthly-close:7:2026-09");
    expect(posting.source.sourceId).toContain(`month:2026-09:${digest}`);
    expect(posting.voucher.voucherDate).toBe("2026-09-30");
  });
});
