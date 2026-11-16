import { describe, expect, it } from "vitest";

import { buildGoldenCoastPhase3CutoverPlan, type GoldenCoastPhase3CutoverInput } from "./goldenCoastCutover";
import {
  buildGoldenCoastPhase5SalePostings,
  goldenCoastPhase5SaleDigest,
  parseGoldenCoastPhase5SaleInput,
  planGoldenCoastPhase5Sale,
  type GoldenCoastFifoLot,
} from "./goldenCoastPosSale";
import {
  buildGoldenCoastPhase6SpecialLocationDeductionPosting,
  planGoldenCoastPhase6SpecialLocationDeduction,
} from "./goldenCoastSpecialLocationDeduction";
import {
  buildGoldenCoastPhase7TransferPostings,
  goldenCoastPhase7TransferDigest,
  parseGoldenCoastPhase7TransferInput,
  planGoldenCoastPhase7Transfer,
} from "./goldenCoastHadiTransfer";
import {
  buildGoldenCoastPhase8FundingPosting,
  buildGoldenCoastPhase8OffloadPosting,
  parseGoldenCoastPhase8ContainerInput,
  parseGoldenCoastPhase8OffloadInput,
  planGoldenCoastPhase8Funding,
  planGoldenCoastPhase8Offload,
  type GoldenCoastPhase8FundedContainerState,
} from "./goldenCoastContainerOffload";
import {
  GOLDEN_COAST_PHASE9_CONFIRMATION,
  buildGoldenCoastPhase9WithdrawalPosting,
  goldenCoastPhase9WithdrawalDigest,
  parseGoldenCoastPhase9WithdrawalInput,
  planGoldenCoastPhase9Withdrawal,
} from "./goldenCoastHassanSavingsWithdrawal";
import {
  buildGoldenCoastPhase10SettlementPosting,
  goldenCoastPhase10SettlementDigest,
  parseGoldenCoastPhase10SettlementInput,
  planGoldenCoastPhase10Settlement,
} from "./goldenCoastSalesCashSettlement";
import {
  buildGoldenCoastPhase11MonthlyClosePosting,
  goldenCoastPhase11CloseDigest,
  parseGoldenCoastPhase11CloseInput,
  planGoldenCoastPhase11MonthlyClose,
} from "./goldenCoastMonthlyClose";

interface PostingEntryLike {
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
  debitAmount: string;
  creditAmount: string;
}

const COMPANY_ID = 7;
const HADI_COMPANY_ID = 8;
const LOCATION_ID = 5;
const STOCK_ITEM_ID = 501;

const account = {
  freshStartEquity: 101,
  hassanEquity: 102,
  hassanSavings: 103,
  gcSalesCash: 104,
  stockOtw: 105,
  stockInHand: 106,
  containerReserve: 107,
  sales: 108,
  cogs: 109,
  gcHadiIntercompany: 110,
  profitPendingDistribution: 111,
  sharedCharges: 112,
  gcOperatingCash: 113,
  hadiGcIntercompany: 201,
} as const;

const bank = {
  openingCash: 901,
  hadiCash: 902,
  directCollection: 903,
  hassanPayout: 904,
} as const;

function ledgerNetDebit(entries: PostingEntryLike[], ledgerAccountId: number): number {
  return entries
    .filter((entry) => entry.ledgerAccountId === ledgerAccountId)
    .reduce((sum, entry) => sum + Number(entry.debitAmount) - Number(entry.creditAmount), 0);
}

function bankNetDebit(entries: PostingEntryLike[], bankAccountId: number): number {
  return entries
    .filter((entry) => entry.bankAccountId === bankAccountId)
    .reduce((sum, entry) => sum + Number(entry.debitAmount) - Number(entry.creditAmount), 0);
}

function expectBalanced(entries: PostingEntryLike[]): void {
  const debits = entries.reduce((sum, entry) => sum + Number(entry.debitAmount), 0);
  const credits = entries.reduce((sum, entry) => sum + Number(entry.creditAmount), 0);
  expect(debits).toBeCloseTo(credits, 8);
}

function cutoverInput(): GoldenCoastPhase3CutoverInput {
  return {
    companyId: COMPANY_ID,
    stockOtwUsd: "44000.00",
    stockInHandUsd: "0.00",
    containerReserveUsd: "22300.00",
    freshStartContributedStockOtwUsd: "44000.00",
    gcSalesCashUsd: "0.00",
    cashAccount: {
      kind: "bank",
      id: bank.openingCash,
      name: "Golden Coast opening bank",
    },
    accounts: {
      freshStartEquityAccountId: account.freshStartEquity,
      hassanEquityAccountId: account.hassanEquity,
      hassanSavingsAccountId: account.hassanSavings,
      gcSalesCashAccountId: account.gcSalesCash,
      stockOtwAccountId: account.stockOtw,
      stockInHandAccountId: account.stockInHand,
      containerReserveAccountId: account.containerReserve,
    },
  };
}

function postCutoverContainer() {
  return parseGoldenCoastPhase8ContainerInput({
    companyId: COMPANY_ID,
    body: {
      clientRequestId: "phase14-container",
      supplierName: "Fresh Start",
      containerNumber: "GC-P14-1",
      invoiceNumber: "GC-P14-1",
      invoiceDate: "2026-09-05",
      reserveUsd: "22300.00",
      fundingAccount: { kind: "ledger", id: account.gcOperatingCash },
      lines: [
        {
          stockItemId: STOCK_ITEM_ID,
          articleCode: "GC-BAG",
          description: "Golden Coast bag",
          qty: "2000",
          unitRateUsd: "22",
        },
      ],
    },
  });
}

function fundedContainer(): GoldenCoastPhase8FundedContainerState {
  const container = postCutoverContainer();
  return {
    containerId: 700,
    companyId: COMPANY_ID,
    origin: "phase8",
    fundingVoucherId: 701,
    goodsCostUsd: "44000.00",
    reserveUsd: "22300.00",
    fundingAccount: container.fundingAccount,
    lines: container.lines,
  };
}

function phase8Offload() {
  const offload = parseGoldenCoastPhase8OffloadInput({
    companyId: COMPANY_ID,
    body: {
      clientRequestId: "phase14-offload",
      containerId: 700,
      locationId: LOCATION_ID,
      offloadDate: "2026-09-06",
      charges: [
        { chargeType: "duty", amountUsd: "8500" },
        { chargeType: "transport", amountUsd: "12200" },
      ],
    },
  });
  const funded = fundedContainer();
  const plan = planGoldenCoastPhase8Offload({ offload, funded });
  const posting = buildGoldenCoastPhase8OffloadPosting({
    offload,
    funded,
    plan,
    accounts: {
      stockOtwAccountId: account.stockOtw,
      stockInHandAccountId: account.stockInHand,
      containerReserveAccountId: account.containerReserve,
      hassanEquityAccountId: account.hassanEquity,
      hassanSavingsAccountId: account.hassanSavings,
    },
  });
  return { plan, posting };
}

function salePlan() {
  const sale = parseGoldenCoastPhase5SaleInput({
    companyId: COMPANY_ID,
    body: {
      locationId: LOCATION_ID,
      saleDate: "2026-09-10",
      customerName: "Golden Coast Customer",
      clientRequestId: "phase14-sale",
      lines: [{ stockItemId: STOCK_ITEM_ID, qty: "30", unitPriceUsd: "60" }],
    },
  });
  const offload = phase8Offload();
  const lot: GoldenCoastFifoLot = {
    id: 800,
    companyId: COMPANY_ID,
    locationId: LOCATION_ID,
    stockItemId: STOCK_ITEM_ID,
    articleCode: "GC-BAG",
    description: "Golden Coast bag",
    sourceType: "golden_coast_phase8_offload",
    qtyRemaining: "2000",
    finalUnitCostUsd: offload.plan.lines[0].finalUnitCostUsd,
    createdAt: "2026-09-06T00:00:00.000Z",
  };
  return { sale, plan: planGoldenCoastPhase5Sale({ sale, lots: [lot] }) };
}

describe("Golden Coast Phase 14 final lifecycle certification", () => {
  it("keeps contributed opening inventory separate from every post-cutover cash-funded container", () => {
    const cutover = buildGoldenCoastPhase3CutoverPlan(cutoverInput());

    expect(cutover.freshStartContributedInventoryUsd).toBe("44000.00");
    expect(cutover.cashFundedInventoryUsd).toBe("0.00");
    expect(cutover.hassanFundingUsesUsd).toBe("22300.00");
    expect(cutover.hassanOpeningEquityUsd).toBe("22300.00");
    expect(cutover.hassanSavingsUsd).toBe("77700.00");
    expect(cutover.freshStartResidualFundingUsd).toBe("56000.00");
    expectBalanced(cutover.entries);

    const container = postCutoverContainer();
    const fundingPlan = planGoldenCoastPhase8Funding(container);
    const funding = buildGoldenCoastPhase8FundingPosting({
      container,
      plan: fundingPlan,
      accounts: {
        stockOtwAccountId: account.stockOtw,
        stockInHandAccountId: account.stockInHand,
        containerReserveAccountId: account.containerReserve,
        hassanEquityAccountId: account.hassanEquity,
        hassanSavingsAccountId: account.hassanSavings,
      },
    });

    expect(fundingPlan.totalFundingUsd).toBe("66300.00");
    expect(ledgerNetDebit(funding.entries, account.stockOtw)).toBe(44000);
    expect(ledgerNetDebit(funding.entries, account.containerReserve)).toBe(22300);
    expect(ledgerNetDebit(funding.entries, account.gcOperatingCash)).toBe(-66300);
    expect(ledgerNetDebit(funding.entries, account.freshStartEquity)).toBe(0);
    expect(ledgerNetDebit(funding.entries, account.hassanEquity)).toBe(0);
    expect(ledgerNetDebit(funding.entries, account.hassanSavings)).toBe(0);
    expectBalanced(funding.entries);
  });

  it("carries an unused reserve into Hassan Savings and produces landed FIFO cost", () => {
    const { plan, posting } = phase8Offload();

    expect(plan.actualChargesUsd).toBe("20700.00");
    expect(plan.unusedReserveUsd).toBe("1600.00");
    expect(plan.totalFinalCostUsd).toBe("64700.00");
    expect(plan.lines[0].baseUnitCostUsd).toBe("22.000000");
    expect(plan.lines[0].landedUnitCostUsd).toBe("10.350000");
    expect(plan.lines[0].finalUnitCostUsd).toBe("32.350000");
    expect(ledgerNetDebit(posting.entries, account.stockInHand)).toBe(64700);
    expect(ledgerNetDebit(posting.entries, account.stockOtw)).toBe(-44000);
    expect(ledgerNetDebit(posting.entries, account.containerReserve)).toBe(-22300);
    expect(ledgerNetDebit(posting.entries, account.gcOperatingCash)).toBe(1600);
    expect(ledgerNetDebit(posting.entries, account.hassanEquity)).toBe(1600);
    expect(ledgerNetDebit(posting.entries, account.hassanSavings)).toBe(-1600);
    expect(ledgerNetDebit(posting.entries, account.sales)).toBe(0);
    expect(ledgerNetDebit(posting.entries, account.cogs)).toBe(0);
    expectBalanced(posting.entries);
  });

  it("runs landed-cost sale value through deduction, collection, remittance and savings withdrawal", () => {
    const { sale, plan } = salePlan();
    expect(plan.revenueUsd).toBe("1800.00");
    expect(plan.cogsUsd).toBe("970.50");
    expect(plan.grossProfitUsd).toBe("829.50");

    const saleSideAccount = {
      kind: "ledger",
      id: account.gcSalesCash,
    } as const;
    const saleDigest = goldenCoastPhase5SaleDigest({ sale, saleSideAccount });
    const saleBatch = buildGoldenCoastPhase5SalePostings({
      plan,
      accounts: {
        saleSideAccountId: account.gcSalesCash,
        salesRevenueAccountId: account.sales,
        cogsAccountId: account.cogs,
        stockInHandAccountId: account.stockInHand,
      },
      saleSideAccount,
      saleDigest,
      exchangeRate: null,
    });
    const saleEntries = saleBatch.postings.flatMap((posting) => posting.request.entries);
    expect(ledgerNetDebit(saleEntries, account.gcSalesCash)).toBe(1800);
    expect(ledgerNetDebit(saleEntries, account.sales)).toBe(-1800);
    expect(ledgerNetDebit(saleEntries, account.cogs)).toBe(970.5);
    expect(ledgerNetDebit(saleEntries, account.stockInHand)).toBe(-970.5);
    for (const posting of saleBatch.postings) expectBalanced(posting.request.entries);

    const deductionPlan = planGoldenCoastPhase6SpecialLocationDeduction({
      salePlan: plan,
      deductionPerQtyUsd: "2.5000",
    });
    expect(deductionPlan?.deductionUsd).toBe("75.00");
    const deduction = buildGoldenCoastPhase6SpecialLocationDeductionPosting({
      plan: deductionPlan!,
      gcSalesCashAccountId: account.gcSalesCash,
      hassanSavingsAccountId: account.hassanSavings,
      saleDigest,
      exchangeRate: "1",
    });
    expect(ledgerNetDebit(deduction.entries, account.gcSalesCash)).toBe(75);
    expect(ledgerNetDebit(deduction.entries, account.hassanSavings)).toBe(-75);
    expectBalanced(deduction.entries);

    const collection = parseGoldenCoastPhase7TransferInput({
      companyId: COMPANY_ID,
      parentCompanyId: HADI_COMPANY_ID,
      body: {
        operation: "collect_via_hadi",
        transferDate: "2026-09-12",
        amountUsd: "600.00",
        clientRequestId: "phase14-hadi-collect",
        reference: "Partial HADI collection",
        hadiCashAccount: { kind: "bank", id: bank.hadiCash },
      },
    });
    const collectionPlan = planGoldenCoastPhase7Transfer({
      transfer: collection,
      balances: {
        gcSalesCashDebitBalanceUsd: "1875.00",
        outstandingHadiCollectionsUsd: "0.00",
      },
    });
    expect(collectionPlan.gcSalesCashDebitBalanceAfterUsd).toBe("1275.00");
    expect(collectionPlan.outstandingHadiCollectionsAfterUsd).toBe("600.00");
    const phase7Accounts = {
      gcSalesCashAccountId: account.gcSalesCash,
      goldenCoastHadiIntercompanyAccountId: account.gcHadiIntercompany,
      hadiGoldenCoastIntercompanyAccountId: account.hadiGcIntercompany,
    };
    const collectionDigest = goldenCoastPhase7TransferDigest({
      transfer: collection,
      accounts: phase7Accounts,
    });
    const collectionBatch = buildGoldenCoastPhase7TransferPostings({
      plan: collectionPlan,
      accounts: phase7Accounts,
      transferDigest: collectionDigest,
      goldenCoastExchangeRate: null,
      hadiExchangeRate: null,
    });
    const gcCollection = collectionBatch.postings.find((posting) => posting.role === "golden_coast")?.request;
    const hadiCollection = collectionBatch.postings.find((posting) => posting.role === "hadi")?.request;
    expect(gcCollection).toBeDefined();
    expect(hadiCollection).toBeDefined();
    expect(ledgerNetDebit(gcCollection!.entries, account.gcSalesCash)).toBe(-600);
    expect(ledgerNetDebit(gcCollection!.entries, account.gcHadiIntercompany)).toBe(600);
    expect(bankNetDebit(hadiCollection!.entries, bank.hadiCash)).toBe(600);
    expect(ledgerNetDebit(hadiCollection!.entries, account.hadiGcIntercompany)).toBe(-600);
    expectBalanced(gcCollection!.entries);
    expectBalanced(hadiCollection!.entries);

    const settlement = parseGoldenCoastPhase10SettlementInput({
      companyId: COMPANY_ID,
      body: {
        settlementDate: "2026-09-13",
        amountUsd: "1275.00",
        clientRequestId: "phase14-direct-settlement",
        paymentAccount: { kind: "bank", id: bank.directCollection },
        reference: "Pay remaining GC Sales Cash payable",
      },
    });
    const settlementPlan = planGoldenCoastPhase10Settlement({
      settlement,
      gcSalesCashDebitBalanceUsd: "-1275.00",
    });
    expect(settlementPlan.gcSalesCashDebitBalanceAfterUsd).toBe("0.00");
    const settlementDigest = goldenCoastPhase10SettlementDigest({
      settlement,
      gcSalesCashAccountId: account.gcSalesCash,
    });
    const settlementPosting = buildGoldenCoastPhase10SettlementPosting({
      plan: settlementPlan,
      gcSalesCashAccountId: account.gcSalesCash,
      settlementDigest,
    });
    expect(bankNetDebit(settlementPosting.entries, bank.directCollection)).toBe(-1275);
    expect(ledgerNetDebit(settlementPosting.entries, account.gcSalesCash)).toBe(1275);
    expectBalanced(settlementPosting.entries);

    const remittance = parseGoldenCoastPhase7TransferInput({
      companyId: COMPANY_ID,
      parentCompanyId: HADI_COMPANY_ID,
      body: {
        operation: "remit_from_hadi",
        transferDate: "2026-09-14",
        amountUsd: "600.00",
        clientRequestId: "phase14-hadi-remit",
        reference: "Remit HADI collection",
        hadiCashAccount: { kind: "bank", id: bank.hadiCash },
        goldenCoastCashAccount: { kind: "ledger", id: account.gcOperatingCash },
      },
    });
    const remittancePlan = planGoldenCoastPhase7Transfer({
      transfer: remittance,
      balances: {
        gcSalesCashDebitBalanceUsd: settlementPlan.gcSalesCashDebitBalanceAfterUsd,
        outstandingHadiCollectionsUsd: collectionPlan.outstandingHadiCollectionsAfterUsd,
      },
    });
    expect(remittancePlan.gcSalesCashDebitBalanceAfterUsd).toBe("0.00");
    expect(remittancePlan.outstandingHadiCollectionsAfterUsd).toBe("0.00");
    const remittanceDigest = goldenCoastPhase7TransferDigest({
      transfer: remittance,
      accounts: phase7Accounts,
    });
    const remittanceBatch = buildGoldenCoastPhase7TransferPostings({
      plan: remittancePlan,
      accounts: phase7Accounts,
      transferDigest: remittanceDigest,
      goldenCoastExchangeRate: null,
      hadiExchangeRate: null,
    });
    const gcRemittance = remittanceBatch.postings.find((posting) => posting.role === "golden_coast")?.request;
    const hadiRemittance = remittanceBatch.postings.find((posting) => posting.role === "hadi")?.request;
    expect(ledgerNetDebit(gcRemittance!.entries, account.gcOperatingCash)).toBe(600);
    expect(ledgerNetDebit(gcRemittance!.entries, account.gcHadiIntercompany)).toBe(-600);
    expect(ledgerNetDebit(hadiRemittance!.entries, account.hadiGcIntercompany)).toBe(600);
    expect(bankNetDebit(hadiRemittance!.entries, bank.hadiCash)).toBe(-600);
    expectBalanced(gcRemittance!.entries);
    expectBalanced(hadiRemittance!.entries);

    const withdrawal = parseGoldenCoastPhase9WithdrawalInput({
      companyId: COMPANY_ID,
      body: {
        withdrawalDate: "2026-09-15",
        amountUsd: "1675.00",
        clientRequestId: "phase14-savings-withdrawal",
        paymentAccount: { kind: "bank", id: bank.hassanPayout },
        reference: "Withdraw post-cutover savings additions",
        reason: "Hassan requested payout",
        confirmation: GOLDEN_COAST_PHASE9_CONFIRMATION,
      },
    });
    const withdrawalPlan = planGoldenCoastPhase9Withdrawal({
      withdrawal,
      savingsBalanceUsd: "79375.00",
    });
    expect(withdrawalPlan.savingsBalanceAfterUsd).toBe("77700.00");
    const withdrawalDigest = goldenCoastPhase9WithdrawalDigest({
      withdrawal,
      hassanSavingsAccountId: account.hassanSavings,
    });
    const withdrawalPosting = buildGoldenCoastPhase9WithdrawalPosting({
      plan: withdrawalPlan,
      hassanSavingsAccountId: account.hassanSavings,
      withdrawalDigest,
    });
    expect(ledgerNetDebit(withdrawalPosting.entries, account.hassanSavings)).toBe(1675);
    expect(bankNetDebit(withdrawalPosting.entries, bank.hassanPayout)).toBe(-1675);
    expectBalanced(withdrawalPosting.entries);
  });

  it("closes landed-cost profit 50/50 without reusing settlement, savings, inventory or HADI balances", () => {
    const close = parseGoldenCoastPhase11CloseInput({
      companyId: COMPANY_ID,
      body: {
        periodMonth: "2026-09",
        clientRequestId: "phase14-month-close",
        reference: "Phase 14 lifecycle close",
      },
    });
    const closePlan = planGoldenCoastPhase11MonthlyClose({
      close,
      totalRevenueUsd: "1800.00",
      totalCogsUsd: "970.50",
      totalSharedChargesUsd: "0.00",
    });
    expect(closePlan.netProfitLossUsd).toBe("829.50");
    expect(closePlan.freshStartShareUsd).toBe("414.75");
    expect(closePlan.hassanShareUsd).toBe("414.75");

    const closeAccounts = {
      salesAccountId: account.sales,
      cogsAccountId: account.cogs,
      sharedChargesAccountId: account.sharedCharges,
      profitPendingDistributionAccountId: account.profitPendingDistribution,
      freshStartEquityAccountId: account.freshStartEquity,
      hassanEquityAccountId: account.hassanEquity,
    };
    const digest = goldenCoastPhase11CloseDigest({
      plan: closePlan,
      accounts: closeAccounts,
    });
    const posting = buildGoldenCoastPhase11MonthlyClosePosting({
      plan: closePlan,
      accounts: closeAccounts,
      digest,
    });

    expect(ledgerNetDebit(posting.entries, account.freshStartEquity)).toBe(-414.75);
    expect(ledgerNetDebit(posting.entries, account.hassanEquity)).toBe(-414.75);
    expect(ledgerNetDebit(posting.entries, account.profitPendingDistribution)).toBe(0);
    for (const untouchedAccountId of [
      account.hassanSavings,
      account.gcSalesCash,
      account.stockOtw,
      account.stockInHand,
      account.containerReserve,
      account.gcHadiIntercompany,
      account.hadiGcIntercompany,
      account.gcOperatingCash,
    ]) {
      expect(ledgerNetDebit(posting.entries, untouchedAccountId)).toBe(0);
    }
    expectBalanced(posting.entries);
  });
});
