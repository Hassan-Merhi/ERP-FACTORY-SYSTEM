/**
 * Golden Coast Phase 15 — GC Sales Cash posting-path inventory.
 *
 * GC Sales Cash is the credit-normal liability Golden Coast owes Fresh Start FZ
 * (see `goldenCoastSalesCashPayable`). Every module that posts to it must agree
 * on that: a sale credits it, a payment debits it. This suite drives each real
 * posting builder and asserts which side of GC Sales Cash it lands on, so a new
 * or edited path cannot quietly post the wrong way round.
 *
 * It also pins the one path that does NOT follow the payable model — the retired
 * Phase 5/6 `pos-sale` endpoint — so its divergence stays a deliberate, visible
 * fact rather than an accident. See the note above that case for why it is left
 * alone.
 */
import { describe, expect, it } from "vitest";
import { buildGoldenCoastPhase3CutoverPlan } from "./goldenCoastPhase3Cutover";
import {
  buildGoldenCoastPhase5SalePostings,
  goldenCoastPhase5SaleDigest,
  parseGoldenCoastPhase5SaleInput,
  planGoldenCoastPhase5Sale,
  type GoldenCoastFifoLot,
  type GoldenCoastPhase5RoleAccounts,
  type GoldenCoastPhase5SalePlan,
} from "./goldenCoastPhase5PosSale";
import {
  buildGoldenCoastPhase6SpecialLocationDeductionPosting,
  planGoldenCoastPhase6SpecialLocationDeduction,
} from "./goldenCoastPhase6SpecialLocationDeduction";
import {
  buildGoldenCoastPhase7TransferPostings,
  goldenCoastPhase7TransferDigest,
  parseGoldenCoastPhase7TransferInput,
  planGoldenCoastPhase7Transfer,
} from "./goldenCoastPhase7HadiTransfer";
import {
  buildGoldenCoastEquitySalesCashPosting,
  goldenCoastEquitySalesCashDigest,
  parseGoldenCoastEquitySalesCashInput,
  planGoldenCoastEquitySalesCashSettlement,
} from "./goldenCoastEquitySalesCashSettlement";
import {
  buildGoldenCoastPhase10SettlementPosting,
  goldenCoastPhase10SettlementDigest,
  parseGoldenCoastPhase10SettlementInput,
  planGoldenCoastPhase10Settlement,
} from "./goldenCoastPhase10SalesCashSettlement";

const COMPANY_ID = 7;
const HADI_COMPANY_ID = 8;
const LOCATION_ID = 3;
const STOCK_ITEM_ID = 101;
const GC_SALES_CASH = 104;

type Entry = { ledgerAccountId?: number; bankAccountId?: number; debitAmount: string; creditAmount: string };

/**
 * Net movement on GC Sales Cash, signed as debits minus credits. Positive means
 * the payable was reduced; negative means it was raised.
 */
function netDebitOnSalesCash(entries: readonly Entry[]): number {
  return entries
    .filter((entry) => Number(entry.ledgerAccountId ?? 0) === GC_SALES_CASH)
    .reduce((sum, entry) => sum + Number(entry.debitAmount || 0) - Number(entry.creditAmount || 0), 0);
}

function expectBalanced(entries: readonly Entry[]): void {
  const debits = entries.reduce((sum, entry) => sum + Number(entry.debitAmount || 0), 0);
  const credits = entries.reduce((sum, entry) => sum + Number(entry.creditAmount || 0), 0);
  expect(debits).toBeCloseTo(credits, 6);
}

// ── Phase 3 cutover ──────────────────────────────────────────────────────────

describe("Phase 3 cutover carries GC Sales Cash as a payable", () => {
  it("credits GC Sales Cash for an opening balance", () => {
    const plan = buildGoldenCoastPhase3CutoverPlan({
      companyId: COMPANY_ID,
      stockOtwUsd: "44000.00",
      stockInHandUsd: "0.00",
      containerReserveUsd: "22300.00",
      gcSalesCashUsd: "1500.00",
      cashAccount: { kind: "bank", id: 22, name: "Operating Bank" },
      accounts: {
        freshStartEquityAccountId: 101,
        hassanEquityAccountId: 102,
        hassanSavingsAccountId: 103,
        gcSalesCashAccountId: GC_SALES_CASH,
        stockOtwAccountId: 105,
        stockInHandAccountId: 106,
        containerReserveAccountId: 107,
      },
    });

    expect(netDebitOnSalesCash(plan.entries as Entry[])).toBe(-1500);
    expectBalanced(plan.entries as Entry[]);
  });
});

// ── Phase 6 special-location deduction ───────────────────────────────────────

describe("Phase 6 special-location deduction reduces the payable", () => {
  it("debits GC Sales Cash and credits Hassan Savings", () => {
    const salePlan: GoldenCoastPhase5SalePlan = {
      companyId: COMPANY_ID,
      locationId: LOCATION_ID,
      saleDate: "2026-09-05",
      customerName: "Walk-in",
      clientRequestId: "gc-paths-deduction",
      totalQty: "30.0000",
      revenueUsd: "1800.00",
      cogsUsd: "660.00",
      grossProfitUsd: "1140.00",
      lines: [],
      allocations: [],
    };

    const plan = planGoldenCoastPhase6SpecialLocationDeduction({ salePlan, deductionPerQtyUsd: "2.50" });
    expect(plan).not.toBeNull();
    const posting = buildGoldenCoastPhase6SpecialLocationDeductionPosting({
      plan: plan!,
      gcSalesCashAccountId: GC_SALES_CASH,
      hassanSavingsAccountId: 103,
      saleDigest: "deadbeef",
      exchangeRate: null,
    });

    // The deducted amount is owed to Hassan instead of Fresh Start, so it moves
    // off the GC Sales Cash payable rather than adding to it.
    expect(netDebitOnSalesCash(posting.entries as Entry[])).toBe(75);
    expectBalanced(posting.entries as Entry[]);
  });
});

// ── Phase 7 HADI transfers ───────────────────────────────────────────────────

describe("Phase 7 HADI transfers", () => {
  const accounts = {
    gcSalesCashAccountId: GC_SALES_CASH,
    goldenCoastHadiIntercompanyAccountId: 201,
    hadiGoldenCoastIntercompanyAccountId: 202,
  };

  function transfer(body: Record<string, unknown>) {
    return parseGoldenCoastPhase7TransferInput({
      companyId: COMPANY_ID,
      parentCompanyId: HADI_COMPANY_ID,
      body,
    });
  }

  it("raises the payable when HADI collects sale cash", () => {
    const parsedTransfer = transfer({
      operation: "collect_via_hadi",
      transferDate: "2026-09-12",
      amountUsd: "600.00",
      clientRequestId: "gc-paths-collect",
      reference: null,
      hadiCashAccount: { kind: "bank", id: 91 },
    });
    const plan = planGoldenCoastPhase7Transfer({
      transfer: parsedTransfer,
      balances: { gcSalesCashDebitBalanceUsd: "0", outstandingHadiCollectionsUsd: "0" },
    });
    const batch = buildGoldenCoastPhase7TransferPostings({
      plan,
      accounts,
      transferDigest: goldenCoastPhase7TransferDigest({ transfer: parsedTransfer, accounts }),
      goldenCoastExchangeRate: null,
      hadiExchangeRate: null,
    });

    const goldenCoast = batch.postings.find((posting) => posting.role === "golden_coast")!.request;
    expect(netDebitOnSalesCash(goldenCoast.entries as Entry[])).toBe(-600);
    for (const posting of batch.postings) expectBalanced(posting.request.entries as Entry[]);
  });

  it("leaves the payable untouched when HADI remits cash back", () => {
    const parsedTransfer = transfer({
      operation: "remit_from_hadi",
      transferDate: "2026-09-14",
      amountUsd: "600.00",
      clientRequestId: "gc-paths-remit",
      reference: null,
      hadiCashAccount: { kind: "bank", id: 91 },
      goldenCoastCashAccount: { kind: "ledger", id: 92 },
    });
    const plan = planGoldenCoastPhase7Transfer({
      transfer: parsedTransfer,
      balances: { gcSalesCashDebitBalanceUsd: "-1200", outstandingHadiCollectionsUsd: "600" },
    });
    const batch = buildGoldenCoastPhase7TransferPostings({
      plan,
      accounts,
      transferDigest: goldenCoastPhase7TransferDigest({ transfer: parsedTransfer, accounts }),
      goldenCoastExchangeRate: null,
      hadiExchangeRate: null,
    });

    for (const posting of batch.postings) {
      expect(netDebitOnSalesCash(posting.request.entries as Entry[])).toBe(0);
      expectBalanced(posting.request.entries as Entry[]);
    }
  });
});

// ── Phase 10 direct payment ──────────────────────────────────────────────────

describe("Phase 10 payment reduces the payable", () => {
  it("debits GC Sales Cash by the settlement and never by the fee", () => {
    const settlement = parseGoldenCoastPhase10SettlementInput({
      companyId: COMPANY_ID,
      body: {
        settlementDate: "2026-09-13",
        amountUsd: "600.00",
        transferFeeUsd: "12.50",
        clientRequestId: "gc-paths-payment",
        paymentAccount: { kind: "bank", id: 91 },
        reference: null,
      },
    });
    // Signed Dr-minus-Cr: -1,800.00 is a payable of 1,800.00.
    const plan = planGoldenCoastPhase10Settlement({ settlement, gcSalesCashDebitBalanceUsd: "-1800.00" });
    const posting = buildGoldenCoastPhase10SettlementPosting({
      plan,
      gcSalesCashAccountId: GC_SALES_CASH,
      sharedChargesAccountId: 66,
      settlementDigest: goldenCoastPhase10SettlementDigest({
        settlement,
        gcSalesCashAccountId: GC_SALES_CASH,
        sharedChargesAccountId: 66,
      }),
    });

    expect(netDebitOnSalesCash(posting.entries as Entry[])).toBe(600);
    expectBalanced(posting.entries as Entry[]);
  });
});

// ── Equity-funded payment ────────────────────────────────────────────────────

describe("settling GC Sales Cash from Hassan equity reduces the payable", () => {
  it("debits GC Sales Cash and moves no cash account at all", () => {
    const settlement = parseGoldenCoastEquitySalesCashInput({
      companyId: COMPANY_ID,
      body: {
        settlementDate: "2026-09-13",
        amountUsd: "600.00",
        clientRequestId: "gc-paths-equity-payment",
        reference: null,
        reason: "Hassan settles the Fresh Start payable from capital",
        confirmation: "SETTLE SALES CASH FROM EQUITY",
      },
    });
    const accounts = {
      gcSalesCashAccountId: GC_SALES_CASH,
      hassanEquityAccountId: 102,
      freshStartEquityAccountId: 101,
    };
    const plan = planGoldenCoastEquitySalesCashSettlement({
      settlement,
      gcSalesCashPayableUsd: "1800.00",
      hassanEquityCreditBalanceUsd: "9000.00",
    });
    const posting = buildGoldenCoastEquitySalesCashPosting({
      plan,
      accounts,
      settlementDigest: goldenCoastEquitySalesCashDigest({ settlement, accounts }),
    });
    const entries = posting.entries as Entry[];

    // Same direction as every other payment path: a payment DEBITS the payable.
    expect(netDebitOnSalesCash(entries)).toBe(600);
    // The funding is equity, not money, so nothing lands on a bank account.
    expect(entries.every((entry) => entry.bankAccountId == null)).toBe(true);
    expectBalanced(entries);
  });
});

// ── Retired Phase 5/6 pos-sale endpoint ──────────────────────────────────────

describe("retired Phase 5/6 pos-sale endpoint", () => {
  /**
   * This is the one GC Sales Cash path that does not follow the payable model.
   * The Phase 5 revenue voucher posts Dr GC Sales Cash / Cr Sales, treating the
   * account as sale proceeds still to be collected — the receivable reading the
   * rest of the programme moved away from. Its own chain is self-consistent (the
   * Phase 7 collection that follows it clears the debit it just created), and
   * live POS sales no longer reach it: the POS client posts to /api/pos/sales,
   * which settles through goldenCoastPosAccounting and credits the payable.
   *
   * It is pinned rather than corrected because flipping it would change the
   * meaning of vouchers already posted through it. Retiring or converting it is
   * a separate, audited decision.
   */
  it("still debits GC Sales Cash on a sale, unlike every live path", () => {
    const accounts: GoldenCoastPhase5RoleAccounts = {
      saleSideAccountId: GC_SALES_CASH,
      salesRevenueAccountId: 502,
      cogsAccountId: 503,
      stockInHandAccountId: 504,
    };
    const lots: GoldenCoastFifoLot[] = [
      {
        id: 1,
        companyId: COMPANY_ID,
        locationId: LOCATION_ID,
        stockItemId: STOCK_ITEM_ID,
        articleCode: "GC-BAG",
        description: "Golden Coast bag",
        sourceType: "golden_coast_cutover",
        qtyRemaining: "30",
        finalUnitCostUsd: "22",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ];
    const sale = parseGoldenCoastPhase5SaleInput({
      companyId: COMPANY_ID,
      body: {
        locationId: LOCATION_ID,
        saleDate: "2026-09-05",
        customerName: "Golden Coast Customer",
        clientRequestId: "gc-paths-legacy-sale",
        lines: [{ stockItemId: STOCK_ITEM_ID, qty: "30", unitPriceUsd: "60" }],
      },
    });
    const saleSideAccount = { kind: "ledger" as const, id: GC_SALES_CASH };
    const batch = buildGoldenCoastPhase5SalePostings({
      plan: planGoldenCoastPhase5Sale({ sale, lots }),
      accounts,
      saleSideAccount,
      saleDigest: goldenCoastPhase5SaleDigest({ sale, saleSideAccount }),
      exchangeRate: null,
    });

    const revenue = batch.postings.find((posting) => posting.role === "revenue")!.request;
    // Positive: the legacy sale DEBITS the payable account. Every live path in
    // the suites above credits it on a sale and debits it only on a payment.
    expect(netDebitOnSalesCash(revenue.entries as Entry[])).toBe(1800);
    for (const posting of batch.postings) expectBalanced(posting.request.entries as Entry[]);
  });
});
