/**
 * Golden Coast Phase 15 — full GC Sales Cash reconciliation.
 *
 * Drives one continuous lifetime of the payable through the real planners and
 * posting builders, and checks after every step that three things still agree:
 *
 *   1. the ledger movement on GC Sales Cash,
 *   2. the payable each planner reports it is leaving behind, and
 *   3. what `goldenCoastSalesCashPayable` derives from the ledger.
 *
 * Any future change that moves one of those without the others fails here.
 */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  buildGoldenCoastPhase6SpecialLocationDeductionPosting,
  planGoldenCoastPhase6SpecialLocationDeduction,
} from "./goldenCoastSpecialLocationDeduction";
import type { GoldenCoastPhase5SalePlan } from "./goldenCoastPosSale";
import {
  buildGoldenCoastPhase7TransferPostings,
  goldenCoastPhase7TransferDigest,
  parseGoldenCoastPhase7TransferInput,
  planGoldenCoastPhase7Transfer,
} from "./goldenCoastHadiTransfer";
import {
  GoldenCoastPhase10SettlementError,
  buildGoldenCoastPhase10SettlementPosting,
  goldenCoastPhase10SettlementDigest,
  parseGoldenCoastPhase10SettlementInput,
  planGoldenCoastPhase10Settlement,
} from "./goldenCoastSalesCashSettlement";
import { gcSalesCashPayableBalance, gcSalesCashSettleablePayable } from "./goldenCoastSalesCashPayable";

const COMPANY_ID = 7;
const HADI_COMPANY_ID = 8;
const GC_SALES_CASH = 104;
const SHARED_CHARGES = 66;
const HASSAN_SAVINGS = 103;

const PHASE7_ACCOUNTS = {
  gcSalesCashAccountId: GC_SALES_CASH,
  goldenCoastHadiIntercompanyAccountId: 201,
  hadiGoldenCoastIntercompanyAccountId: 202,
};

type Entry = { ledgerAccountId?: number; bankAccountId?: number; debitAmount: string; creditAmount: string };

/**
 * A minimal general ledger: accumulates signed debit-minus-credit per account
 * exactly the way the routes' SQL does, so the payable can be re-derived from
 * postings rather than asserted from the planners alone.
 */
class Ledger {
  private readonly balances = new Map<string, Decimal>();

  post(entries: readonly Entry[]): void {
    const debits = entries.reduce((sum, e) => sum.plus(e.debitAmount || 0), new Decimal(0));
    const credits = entries.reduce((sum, e) => sum.plus(e.creditAmount || 0), new Decimal(0));
    if (!debits.equals(credits)) {
      throw new Error(`Unbalanced posting: debits ${debits.toFixed(2)} vs credits ${credits.toFixed(2)}`);
    }
    for (const entry of entries) {
      const key = entry.ledgerAccountId != null ? `ledger:${entry.ledgerAccountId}` : `bank:${entry.bankAccountId}`;
      const delta = new Decimal(entry.debitAmount || 0).minus(entry.creditAmount || 0);
      this.balances.set(key, (this.balances.get(key) ?? new Decimal(0)).plus(delta));
    }
  }

  /** Signed debit-minus-credit, the shape the balance queries return. */
  signed(ledgerAccountId: number): string {
    return (this.balances.get(`ledger:${ledgerAccountId}`) ?? new Decimal(0)).toFixed(2);
  }

  signedBank(bankAccountId: number): string {
    return (this.balances.get(`bank:${bankAccountId}`) ?? new Decimal(0)).toFixed(2);
  }

  /** The whole book must always net to zero. */
  totalSigned(): string {
    return [...this.balances.values()].reduce((sum, value) => sum.plus(value), new Decimal(0)).toFixed(2);
  }

  /** GC Sales Cash read through the canonical credit-normal convention. */
  payable(): string {
    return gcSalesCashPayableBalance(this.signed(GC_SALES_CASH));
  }
}

function collectVia(ledger: Ledger, amountUsd: string, clientRequestId: string): string {
  const transfer = parseGoldenCoastPhase7TransferInput({
    companyId: COMPANY_ID,
    parentCompanyId: HADI_COMPANY_ID,
    body: {
      operation: "collect_via_hadi",
      transferDate: "2026-09-12",
      amountUsd,
      clientRequestId,
      reference: null,
      hadiCashAccount: { kind: "bank", id: 91 },
    },
  });
  const plan = planGoldenCoastPhase7Transfer({
    transfer,
    balances: { gcSalesCashDebitBalanceUsd: ledger.signed(GC_SALES_CASH), outstandingHadiCollectionsUsd: "0" },
  });
  const batch = buildGoldenCoastPhase7TransferPostings({
    plan,
    accounts: PHASE7_ACCOUNTS,
    transferDigest: goldenCoastPhase7TransferDigest({ transfer, accounts: PHASE7_ACCOUNTS }),
    goldenCoastExchangeRate: null,
    hadiExchangeRate: null,
  });
  // Only Golden Coast's own voucher belongs in this company's ledger; HADI's
  // reciprocal voucher lives in the parent company's book.
  ledger.post(batch.postings.find((p) => p.role === "golden_coast")!.request.entries as Entry[]);
  return plan.gcSalesCashPayableAfterUsd;
}

function payDown(ledger: Ledger, amountUsd: string, transferFeeUsd: string, clientRequestId: string): string {
  const settlement = parseGoldenCoastPhase10SettlementInput({
    companyId: COMPANY_ID,
    body: {
      settlementDate: "2026-09-13",
      amountUsd,
      transferFeeUsd,
      clientRequestId,
      paymentAccount: { kind: "bank", id: 92 },
      reference: null,
    },
  });
  const plan = planGoldenCoastPhase10Settlement({
    settlement,
    gcSalesCashDebitBalanceUsd: ledger.signed(GC_SALES_CASH),
  });
  const posting = buildGoldenCoastPhase10SettlementPosting({
    plan,
    gcSalesCashAccountId: GC_SALES_CASH,
    sharedChargesAccountId: SHARED_CHARGES,
    settlementDigest: goldenCoastPhase10SettlementDigest({
      settlement,
      gcSalesCashAccountId: GC_SALES_CASH,
      sharedChargesAccountId: SHARED_CHARGES,
    }),
  });
  ledger.post(posting.entries as Entry[]);
  return plan.gcSalesCashPayableAfterUsd;
}

describe("GC Sales Cash reconciliation across a full lifetime", () => {
  it("keeps planner, ledger and payable convention in agreement at every step", () => {
    const ledger = new Ledger();
    expect(ledger.payable()).toBe("0.00");

    // 1. HADI collects 1,800.00 of sale cash: the payable to Fresh Start rises.
    expect(collectVia(ledger, "1800.00", "recon-collect-1")).toBe("1800.00");
    expect(ledger.payable()).toBe("1800.00");
    expect(gcSalesCashSettleablePayable(ledger.payable())).toBe("1800.00");

    // 2. A special-location deduction of 75.00 moves off Fresh Start's payable
    //    and onto the loan owed to Hassan.
    const salePlan: GoldenCoastPhase5SalePlan = {
      companyId: COMPANY_ID,
      locationId: 3,
      saleDate: "2026-09-12",
      customerName: "Walk-in",
      clientRequestId: "recon-sale-1",
      totalQty: "30.0000",
      revenueUsd: "1800.00",
      cogsUsd: "660.00",
      grossProfitUsd: "1140.00",
      lines: [],
      allocations: [],
    };
    const deduction = planGoldenCoastPhase6SpecialLocationDeduction({ salePlan, deductionPerQtyUsd: "2.50" });
    ledger.post(
      buildGoldenCoastPhase6SpecialLocationDeductionPosting({
        plan: deduction!,
        gcSalesCashAccountId: GC_SALES_CASH,
        hassanSavingsAccountId: HASSAN_SAVINGS,
        saleDigest: "recon",
        exchangeRate: null,
      }).entries as Entry[]
    );
    expect(ledger.payable()).toBe("1725.00");
    // Hassan Savings is credit-normal too: it now carries the deducted amount.
    expect(ledger.signed(HASSAN_SAVINGS)).toBe("-75.00");

    // 3. Pay 1,200.00 with a 12.50 transfer fee. The payable drops by the
    //    settlement only; the fee is an expense funded by the same bank.
    expect(payDown(ledger, "1200.00", "12.50", "recon-pay-1")).toBe("525.00");
    expect(ledger.payable()).toBe("525.00");
    expect(ledger.signed(SHARED_CHARGES)).toBe("12.50");
    expect(ledger.signedBank(92)).toBe("-1212.50");

    // 4. Clear the remainder exactly, with no fee.
    expect(payDown(ledger, "525.00", "0", "recon-pay-2")).toBe("0.00");
    expect(ledger.payable()).toBe("0.00");
    expect(gcSalesCashSettleablePayable(ledger.payable())).toBe("0.00");

    // 5. The book balances end to end, and nothing further is payable.
    expect(ledger.totalSigned()).toBe("0.00");
    expect(() => payDown(ledger, "0.01", "0", "recon-pay-3")).toThrow(GoldenCoastPhase10SettlementError);
  });

  it("refuses to pay more than the payable even when a fee would cover the gap", () => {
    const ledger = new Ledger();
    collectVia(ledger, "100.00", "recon-collect-2");

    // 100.00 is payable; a 40.00 fee must not create room for a 120.00 payment.
    expect(() => payDown(ledger, "120.00", "40.00", "recon-pay-4")).toThrow(
      /exceeds the current GC Sales Cash payable 100.00/
    );
    expect(ledger.payable()).toBe("100.00");
  });

  it("reports nothing settleable once the payable has been cleared", () => {
    const ledger = new Ledger();
    collectVia(ledger, "500.00", "recon-collect-3");
    payDown(ledger, "500.00", "0", "recon-pay-5");

    expect(ledger.payable()).toBe("0.00");
    expect(gcSalesCashSettleablePayable(ledger.payable())).toBe("0.00");
    expect(ledger.totalSigned()).toBe("0.00");
  });
});
