/**
 * Per-type ledger expectations for convergence reconciliation.
 */
import { describe, expect, it } from "vitest";
import {
  classifiedVoucherTypes,
  classifyVoucherLedgerExpectation,
} from "../server/services/accounting/voucherLedgerExpectation";
import {
  reconcileConvergenceTx,
  type AccountingConvergenceSnapshot,
} from "../server/services/accounting/convergenceReconciliation";

const tx = { execute: async () => ({ rows: [] }) } as never;

function adapterFor(accounting: AccountingConvergenceSnapshot[]) {
  return {
    loadAccountingSnapshots: async () => accounting,
    loadStockSnapshots: async () => [],
  };
}

function snapshot(overrides: Partial<AccountingConvergenceSnapshot>): AccountingConvergenceSnapshot {
  return {
    voucherId: 1,
    companyId: 7,
    voucherBaseDebit: "50",
    voucherBaseCredit: "50",
    ledgerBaseDebit: "50",
    ledgerBaseCredit: "50",
    daybookBaseAmount: null,
    expectsDaybook: false,
    ...overrides,
  };
}

describe("voucher ledger expectations", () => {
  it("classifies true document-total double entries", () => {
    for (const type of ["Journal", "Payment", "Receipt", "Sales", "Purchase"]) {
      expect(classifyVoucherLedgerExpectation(type)).toBe("balanced");
    }
  });

  it("classifies notes as balanced-only because refund and inventory cost can differ", () => {
    expect(classifyVoucherLedgerExpectation("Credit Note")).toBe("balanced-only");
    expect(classifyVoucherLedgerExpectation("Debit Note")).toBe("balanced-only");
  });

  it("classifies inventory-sided stock documents without forcing false GL balance", () => {
    expect(classifyVoucherLedgerExpectation("Stock Adjustment")).toBe("single-sided");
    expect(classifyVoucherLedgerExpectation("Production")).toBe("single-sided");
    expect(classifyVoucherLedgerExpectation("Consumption")).toBe("single-sided");
    expect(classifyVoucherLedgerExpectation("Mixed")).toBe("inventory-sided");
    for (const type of ["Stock Transfer", "StockTransfer", "Transfer"]) {
      expect(classifyVoucherLedgerExpectation(type)).toBe("none");
    }
  });

  it("treats an unknown or empty type as unclassified rather than harmless", () => {
    expect(classifyVoucherLedgerExpectation("Some New Voucher")).toBe("unclassified");
    expect(classifyVoucherLedgerExpectation("")).toBe("unclassified");
    expect(classifyVoucherLedgerExpectation(null)).toBe("unclassified");
    expect(classifiedVoucherTypes()).not.toContain("Some New Voucher");
  });
});

describe("reconciliation by ledger expectation", () => {
  it("still checks both sides and document totals of a balanced voucher", async () => {
    const result = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([snapshot({ voucherId: 11, ledgerExpectation: "balanced", ledgerBaseCredit: "40" })])
    );

    expect(result.clean).toBe(false);
    expect(result.discrepancies.map((entry) => entry.code)).toContain("VOUCHER_LEDGER_CREDIT_MISMATCH");
  });

  it("accepts a balanced-only note whose balanced ledger value differs from its header", async () => {
    const result = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([
        snapshot({
          voucherId: 21,
          voucherBaseDebit: "80",
          voucherBaseCredit: "80",
          ledgerBaseDebit: "112.09",
          ledgerBaseCredit: "112.09",
          ledgerExpectation: "balanced-only",
        }),
      ])
    );

    expect(result.clean).toBe(true);
    expect(result.discrepancies).toEqual([]);
  });

  it("does not demand ledger evidence from a document that posts none", async () => {
    const result = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([
        snapshot({
          voucherId: 12,
          ledgerExpectation: "none",
          ledgerBaseDebit: "0",
          ledgerBaseCredit: "0",
        }),
      ])
    );

    expect(result.discrepancies).toEqual([]);
    expect(result.clean).toBe(true);
  });

  it("accepts a single-sided posting on either side", async () => {
    const credited = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([
        snapshot({ voucherId: 13, ledgerExpectation: "single-sided", ledgerBaseDebit: "0", ledgerBaseCredit: "50" }),
      ])
    );
    const debited = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([
        snapshot({ voucherId: 14, ledgerExpectation: "single-sided", ledgerBaseDebit: "50", ledgerBaseCredit: "0" }),
      ])
    );

    expect(credited.discrepancies).toEqual([]);
    expect(debited.discrepancies).toEqual([]);
  });

  it("reports a single-sided type that posted both sides or neither", async () => {
    const both = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([
        snapshot({ voucherId: 15, ledgerExpectation: "single-sided", ledgerBaseDebit: "50", ledgerBaseCredit: "50" }),
      ])
    );
    const neither = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([
        snapshot({ voucherId: 16, ledgerExpectation: "single-sided", ledgerBaseDebit: "0", ledgerBaseCredit: "0" }),
      ])
    );

    expect(both.discrepancies.map((entry) => entry.code)).toContain("SINGLE_SIDED_LEDGER_INVALID");
    expect(neither.discrepancies.map((entry) => entry.code)).toContain("SINGLE_SIDED_LEDGER_INVALID");
  });

  it("allows Mixed documents to carry inventory as the net contra side", async () => {
    const result = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([
        snapshot({
          voucherId: 22,
          ledgerExpectation: "inventory-sided",
          ledgerBaseDebit: "1031.28",
          ledgerBaseCredit: "786.64",
        }),
      ])
    );

    expect(result.clean).toBe(true);
  });

  it("reports an unclassified voucher type instead of skipping it", async () => {
    const result = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([snapshot({ voucherId: 17, ledgerExpectation: "unclassified" })])
    );

    expect(result.clean).toBe(false);
    expect(result.discrepancies.map((entry) => entry.code)).toContain("VOUCHER_TYPE_UNCLASSIFIED");
  });

  it("reports a cancelled voucher whose Daybook mirror outlived it", async () => {
    const result = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([
        snapshot({ voucherId: 19, voucherCancelled: true, expectsDaybook: true, daybookBaseAmount: "50" }),
      ])
    );

    expect(result.clean).toBe(false);
    expect(result.discrepancies.map((entry) => entry.code)).toContain("CANCELLED_VOUCHER_DAYBOOK_MIRROR");
  });

  it("does not judge the ledger entries a cancelled voucher keeps as history", async () => {
    const result = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([
        snapshot({
          voucherId: 20,
          voucherCancelled: true,
          expectsDaybook: true,
          ledgerBaseDebit: "0",
          ledgerBaseCredit: "0",
        }),
      ])
    );

    expect(result.discrepancies).toEqual([]);
  });

  it("defaults an adapter that states no expectation to the balanced rule", async () => {
    const result = await reconcileConvergenceTx(
      tx,
      7,
      adapterFor([snapshot({ voucherId: 18, ledgerBaseDebit: "10" })])
    );

    expect(result.discrepancies.map((entry) => entry.code)).toContain("VOUCHER_LEDGER_DEBIT_MISMATCH");
  });
});
