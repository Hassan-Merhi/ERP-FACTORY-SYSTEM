import { describe, expect, it } from "vitest";

import {
  GOLDEN_COAST_PHASE3_CUTOVER_DATE,
  GOLDEN_COAST_PHASE3_PARTNER_EQUITY_USD,
  GOLDEN_COAST_PHASE3_VOUCHER_NUMBER,
  GoldenCoastPhase3CutoverError,
  buildGoldenCoastPhase3CutoverPlan,
  goldenCoastPhase3VoucherNumber,
  type GoldenCoastPhase3CutoverInput,
} from "./goldenCoastCutover";

const accounts = {
  freshStartEquityAccountId: 101,
  hassanEquityAccountId: 102,
  hassanSavingsAccountId: 103,
  gcSalesCashAccountId: 104,
  stockOtwAccountId: 105,
  stockInHandAccountId: 106,
  containerReserveAccountId: 107,
};

function input(overrides: Partial<GoldenCoastPhase3CutoverInput> = {}): GoldenCoastPhase3CutoverInput {
  return {
    companyId: 7,
    stockOtwUsd: "44000.00",
    stockInHandUsd: "0.00",
    containerReserveUsd: "22300.00",
    gcSalesCashUsd: "0.00",
    cashAccount: { kind: "bank", id: 22, name: "Operating Bank" },
    accounts,
    ...overrides,
  };
}

function total(
  entries: ReturnType<typeof buildGoldenCoastPhase3CutoverPlan>["entries"],
  field: "debitAmount" | "creditAmount"
) {
  return entries.reduce((sum, entry) => sum + Number(entry[field]), 0);
}

describe("Golden Coast Phase 3 opening-balance cutover hardened by Phase 13", () => {
  it("locks the cutover to September 1, 2026 and keeps the two $100,000 opening contribution targets", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(input());

    expect(plan.cutoverDate).toBe(GOLDEN_COAST_PHASE3_CUTOVER_DATE);
    expect(plan.cutoverDate).toBe("2026-09-01");
    expect(plan.voucherNumber).toBe(`${GOLDEN_COAST_PHASE3_VOUCHER_NUMBER}-C7`);
    expect(plan.voucherNumber).toBe(goldenCoastPhase3VoucherNumber(7));
    expect(plan.partnerEquityPerPartnerUsd).toBe(GOLDEN_COAST_PHASE3_PARTNER_EQUITY_USD);
    expect(plan.totalPartnerEquityUsd).toBe("200000.00");
    expect(plan.profitPendingDistributionUsd).toBe("0.00");
  });

  it("namespaces the globally unique voucher number by company", () => {
    expect(goldenCoastPhase3VoucherNumber(7)).toBe("GC-CUTOVER-20260901-C7");
    expect(goldenCoastPhase3VoucherNumber(8)).toBe("GC-CUTOVER-20260901-C8");
    expect(goldenCoastPhase3VoucherNumber(7)).not.toBe(goldenCoastPhase3VoucherNumber(8));
  });

  it("automatically moves the classic $33,700 residual into Hassan Savings", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(input());

    // Legacy cash-funded example: $100,000 - $44,000 goods - $22,300 reserve.
    expect(plan.cashFundedInventoryUsd).toBe("44000.00");
    expect(plan.hassanFundingUsesUsd).toBe("66300.00");
    expect(plan.hassanOpeningEquityUsd).toBe("66300.00");
    expect(plan.hassanSavingsUsd).toBe("33700.00");
    expect(plan.entries.find((entry) => entry.ledgerAccountId === accounts.hassanSavingsAccountId)?.creditAmount).toBe(
      "33700.00"
    );
    expect(plan.entries.find((entry) => entry.ledgerAccountId === accounts.hassanEquityAccountId)?.creditAmount).toBe(
      "66300.00"
    );
  });

  it("does not charge Hassan for a Fresh Start-contributed container", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(input({ freshStartContributedStockOtwUsd: "44000.00" }));

    expect(plan.freshStartContributedStockOtwUsd).toBe("44000.00");
    expect(plan.freshStartContributedInventoryUsd).toBe("44000.00");
    expect(plan.cashFundedInventoryUsd).toBe("0.00");
    expect(plan.hassanFundingUsesUsd).toBe("22300.00");
    expect(plan.hassanOpeningEquityUsd).toBe("22300.00");
    expect(plan.hassanSavingsUsd).toBe("77700.00");
    expect(plan.freshStartResidualFundingUsd).toBe("56000.00");
  });

  it("supports a mixed Fresh Start-contributed and cash-funded Stock OTW balance", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(
      input({ stockOtwUsd: "70000.00", freshStartContributedStockOtwUsd: "44000.00" })
    );

    expect(plan.cashFundedInventoryUsd).toBe("26000.00");
    expect(plan.hassanFundingUsesUsd).toBe("48300.00");
    expect(plan.hassanSavingsUsd).toBe("51700.00");
  });

  it("classifies Fresh Start-contributed stock already in hand without consuming Hassan funding", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(
      input({
        stockOtwUsd: "0.00",
        stockInHandUsd: "44000.00",
        freshStartContributedStockInHandUsd: "44000.00",
      })
    );

    expect(plan.freshStartContributedStockInHandUsd).toBe("44000.00");
    expect(plan.cashFundedInventoryUsd).toBe("0.00");
    expect(plan.hassanSavingsUsd).toBe("77700.00");
  });

  it("keeps opening cash based on the real $200,000 source pool rather than adding Hassan Savings on top", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(input());

    expect(plan.openingCashUsd).toBe("133700.00");
    expect(plan.entries.some((entry) => entry.bankAccountId === 22 && entry.debitAmount === "133700.00")).toBe(true);
    expect(total(plan.entries, "debitAmount")).toBe(200000);
    expect(total(plan.entries, "creditAmount")).toBe(200000);
    expect(plan.totalAmount).toBe("200000.00");
  });

  it("adds a carried GC Sales Cash payable to the source pool without changing the Hassan residual formula", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(input({ gcSalesCashUsd: "12500.50" }));

    expect(plan.gcSalesCashUsd).toBe("12500.50");
    expect(plan.hassanSavingsUsd).toBe("33700.00");
    expect(plan.openingCashUsd).toBe("146200.50");
    expect(plan.entries.find((entry) => entry.ledgerAccountId === accounts.gcSalesCashAccountId)?.creditAmount).toBe(
      "12500.50"
    );
  });

  it("accepts hassanSavingsUsd only as an exact compatibility assertion", () => {
    const exact = buildGoldenCoastPhase3CutoverPlan(input({ hassanSavingsUsd: "33700.00" }));
    expect(exact.hassanSavingsUsd).toBe("33700.00");

    expect(() => buildGoldenCoastPhase3CutoverPlan(input({ hassanSavingsUsd: "0.00" }))).toThrow(
      /hassanSavingsUsd is automatic: expected 33700.00/
    );
  });

  it("supports an active Cash/Bank ledger account instead of a bank-account row", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(input({ cashAccount: { kind: "ledger", id: 55 } }));
    const cash = plan.entries.find((entry) => entry.ledgerAccountId === 55);
    expect(cash?.debitAmount).toBe("133700.00");
    expect(cash?.bankAccountId).toBeUndefined();
  });

  it("puts all unused Hassan funding into Savings when there are no Hassan-funded uses", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(
      input({ stockOtwUsd: 0, stockInHandUsd: 0, containerReserveUsd: 0 })
    );

    expect(plan.hassanOpeningEquityUsd).toBe("0.00");
    expect(plan.hassanSavingsUsd).toBe("100000.00");
    expect(plan.openingCashUsd).toBe("200000.00");
    expect(plan.entries.find((entry) => entry.ledgerAccountId === accounts.hassanEquityAccountId)).toBeUndefined();
    expect(plan.entries.find((entry) => entry.ledgerAccountId === accounts.hassanSavingsAccountId)?.creditAmount).toBe(
      "100000.00"
    );
    expect(total(plan.entries, "debitAmount")).toBe(200000);
    expect(total(plan.entries, "creditAmount")).toBe(200000);
  });

  it("rejects contribution classifications larger than the inventory they classify", () => {
    expect(() => buildGoldenCoastPhase3CutoverPlan(input({ freshStartContributedStockOtwUsd: "44000.01" }))).toThrow(
      /cannot exceed total Stock OTW/
    );
    expect(() =>
      buildGoldenCoastPhase3CutoverPlan(
        input({ stockInHandUsd: "100.00", freshStartContributedStockInHandUsd: "100.01" })
      )
    ).toThrow(/cannot exceed total Stock in Hand/);
  });

  it("rejects Fresh Start contributed inventory above its $100,000 opening target", () => {
    expect(() =>
      buildGoldenCoastPhase3CutoverPlan(
        input({
          stockOtwUsd: "70000.00",
          stockInHandUsd: "40000.00",
          freshStartContributedStockOtwUsd: "70000.00",
          freshStartContributedStockInHandUsd: "40000.00",
          containerReserveUsd: 0,
        })
      )
    ).toThrow(/Fresh Start contributed inventory .* exceeds the 100000.00 opening contribution target/);
  });

  it("rejects Hassan-funded inventory and reserve above Hassan's $100,000 balance", () => {
    expect(() =>
      buildGoldenCoastPhase3CutoverPlan(
        input({ stockOtwUsd: "80000.00", stockInHandUsd: "0.00", containerReserveUsd: "22300.00" })
      )
    ).toThrow(/Hassan cash-funded inventory plus Container Reserve exceeds the 100000.00 funding balance/);
  });

  it("is balanced to the cent with mixed contribution origin and carried settlement liability", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan(
      input({
        stockOtwUsd: "44000.25",
        stockInHandUsd: "32000.10",
        containerReserveUsd: "12300.15",
        freshStartContributedStockOtwUsd: "44000.25",
        freshStartContributedStockInHandUsd: "10000.10",
        gcSalesCashUsd: "8500.50",
      })
    );

    expect(total(plan.entries, "debitAmount")).toBeCloseTo(total(plan.entries, "creditAmount"), 8);
    expect(plan.totalAmount).toBe("208500.50");
    expect(plan.hassanSavingsUsd).toBe("65699.85");
  });

  it("rejects omitted required asset balances instead of silently treating them as zero", () => {
    const missingStockOtw = input() as GoldenCoastPhase3CutoverInput & { stockOtwUsd?: string };
    delete missingStockOtw.stockOtwUsd;
    expect(() => buildGoldenCoastPhase3CutoverPlan(missingStockOtw as GoldenCoastPhase3CutoverInput)).toThrow(
      /stockOtwUsd is required/
    );

    const missingStockInHand = input() as GoldenCoastPhase3CutoverInput & { stockInHandUsd?: string };
    delete missingStockInHand.stockInHandUsd;
    expect(() => buildGoldenCoastPhase3CutoverPlan(missingStockInHand as GoldenCoastPhase3CutoverInput)).toThrow(
      /stockInHandUsd is required/
    );

    const missingReserve = input() as GoldenCoastPhase3CutoverInput & { containerReserveUsd?: string };
    delete missingReserve.containerReserveUsd;
    expect(() => buildGoldenCoastPhase3CutoverPlan(missingReserve as GoldenCoastPhase3CutoverInput)).toThrow(
      /containerReserveUsd is required/
    );
  });

  it("rejects negative and sub-cent opening balances", () => {
    expect(() => buildGoldenCoastPhase3CutoverPlan(input({ stockOtwUsd: "-0.01" }))).toThrow(
      GoldenCoastPhase3CutoverError
    );
    expect(() => buildGoldenCoastPhase3CutoverPlan(input({ freshStartContributedStockOtwUsd: -1 }))).toThrow(
      /freshStartContributedStockOtwUsd cannot be negative/
    );
    expect(() => buildGoldenCoastPhase3CutoverPlan(input({ containerReserveUsd: "1.001" }))).toThrow(
      /two decimal places/
    );
  });

  it("rejects over-allocation before a negative residual cash line can be manufactured", () => {
    expect(() =>
      buildGoldenCoastPhase3CutoverPlan(
        input({
          stockOtwUsd: "150000",
          stockInHandUsd: "60000",
          containerReserveUsd: 0,
          freshStartContributedStockOtwUsd: "100000",
        })
      )
    ).toThrow(/Hassan cash-funded inventory plus Container Reserve exceeds the 100000.00 funding balance/);
  });

  it("rejects duplicate canonical role ids", () => {
    expect(() =>
      buildGoldenCoastPhase3CutoverPlan(
        input({ accounts: { ...accounts, hassanEquityAccountId: accounts.freshStartEquityAccountId } })
      )
    ).toThrow(/distinct ledger account/);
  });

  it("rejects invalid company and cash targets", () => {
    expect(() => buildGoldenCoastPhase3CutoverPlan(input({ companyId: 0 }))).toThrow(
      /companyId must be a positive integer/
    );
    expect(() => buildGoldenCoastPhase3CutoverPlan(input({ cashAccount: { kind: "bank", id: 0 } }))).toThrow(
      /cashAccount.id must be a positive integer/
    );
    expect(() =>
      buildGoldenCoastPhase3CutoverPlan(input({ cashAccount: { kind: "wallet" as "bank", id: 4 } }))
    ).toThrow(/cashAccount.kind/);
  });
});
