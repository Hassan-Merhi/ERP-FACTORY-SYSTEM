import { describe, expect, it } from "vitest";
import {
  buildGoldenCoastPhase6SpecialLocationDeductionPosting,
  GoldenCoastPhase6DeductionError,
  goldenCoastPhase6IdempotencyKey,
  planGoldenCoastPhase6SpecialLocationDeduction,
} from "./goldenCoastSpecialLocationDeduction";
import type { GoldenCoastPhase5SalePlan } from "./goldenCoastPosSale";

function salePlan(overrides: Partial<GoldenCoastPhase5SalePlan> = {}): GoldenCoastPhase5SalePlan {
  return {
    companyId: 7,
    locationId: 11,
    saleDate: "2026-09-02",
    customerName: "Walk-in",
    clientRequestId: "sale-1",
    revenueUsd: "1800.00",
    cogsUsd: "660.00",
    grossProfitUsd: "1140.00",
    totalQty: "30.0000",
    lines: [],
    allocations: [],
    ...overrides,
  };
}

describe("Golden Coast Phase 6 special-location deduction", () => {
  it("returns null when the configured deduction is zero", () => {
    expect(planGoldenCoastPhase6SpecialLocationDeduction({ salePlan: salePlan(), deductionPerQtyUsd: "0" })).toBeNull();
  });

  it("calculates the deduction from actual total quantity sold", () => {
    const plan = planGoldenCoastPhase6SpecialLocationDeduction({
      salePlan: salePlan(),
      deductionPerQtyUsd: "2.5000",
    });
    expect(plan).toMatchObject({
      totalQty: "30.0000",
      deductionPerQtyUsd: "2.5000",
      deductionUsd: "75.00",
    });
  });

  it("supports fractional quantities without floating-point drift", () => {
    const plan = planGoldenCoastPhase6SpecialLocationDeduction({
      salePlan: salePlan({ totalQty: "1.2500", revenueUsd: "20.00" }),
      deductionPerQtyUsd: "0.3333",
    });
    expect(plan?.deductionUsd).toBe("0.42");
  });

  it("rejects negative deductions", () => {
    expect(() =>
      planGoldenCoastPhase6SpecialLocationDeduction({ salePlan: salePlan(), deductionPerQtyUsd: "-1" })
    ).toThrow(GoldenCoastPhase6DeductionError);
  });

  it("rejects deduction rates with more than four decimal places", () => {
    expect(() =>
      planGoldenCoastPhase6SpecialLocationDeduction({ salePlan: salePlan(), deductionPerQtyUsd: "0.12345" })
    ).toThrow(/at most 4 decimal places/);
  });

  it("fails closed when the deduction exceeds the sale revenue", () => {
    expect(() =>
      planGoldenCoastPhase6SpecialLocationDeduction({
        salePlan: salePlan({ revenueUsd: "10.00" }),
        deductionPerQtyUsd: "1.00",
      })
    ).toThrow(/exceeds sale revenue/);
  });

  it("builds a balanced liability reclassification from GC Sales Cash to Hassan Savings", () => {
    const plan = planGoldenCoastPhase6SpecialLocationDeduction({
      salePlan: salePlan(),
      deductionPerQtyUsd: "2.5000",
    });
    expect(plan).not.toBeNull();
    const request = buildGoldenCoastPhase6SpecialLocationDeductionPosting({
      plan: plan!,
      gcSalesCashAccountId: 101,
      hassanSavingsAccountId: 202,
      saleDigest: "abc123",
      exchangeRate: "1",
    });

    expect(request.voucher.locationId).toBe(11);
    const gcSalesCashEntry = request.entries.find((entry) => entry.ledgerAccountId === 101);
    const hassanSavingsEntry = request.entries.find((entry) => entry.ledgerAccountId === 202);
    expect(Number(gcSalesCashEntry?.debitAmount)).toBe(75);
    expect(Number(gcSalesCashEntry?.creditAmount)).toBe(0);
    expect(Number(hassanSavingsEntry?.debitAmount)).toBe(0);
    expect(Number(hassanSavingsEntry?.creditAmount)).toBe(75);
    expect(request.source.idempotencyKey).toBe(goldenCoastPhase6IdempotencyKey(7, "sale-1"));
    expect(request.source.sourceId).toContain("2.5000:75.00");
  });
});
