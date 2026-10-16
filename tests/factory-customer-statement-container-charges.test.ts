import { describe, expect, it } from "vitest";
import { MoneyDecimal } from "../server/lib/money";
import {
  consolidateContainerCharges,
} from "../server/routes/factory/customers-core/containerChargeStatementRows";
import type { FactoryStatementRow } from "../server/routes/factory/customers-core/statementRows";

const d = (n: string | number) => new MoneyDecimal(n);
const row = (
  changes: Partial<FactoryStatementRow> = {}
): FactoryStatementRow => {
  const combinedEffect = changes.combinedEffect ?? d(0);
  const ledgerEffect = changes.ledgerEffect ?? combinedEffect;
  return {
    id: "ve-1",
    customerId: 7,
    companyId: 1,
    transactionDate: "2026-10-13",
    transactionType: "JOURNAL",
    referenceType: "VOUCHER",
    referenceId: 11,
    referenceNumber: "J-1",
    description: "CLEARANCE for offloaded container - CAAU5379196",
    debitAmount: combinedEffect.greaterThan(0) ? combinedEffect.toFixed(2) : "0",
    creditAmount: combinedEffect.lessThan(0) ? combinedEffect.abs().toFixed(2) : "0",
    balance: "0",
    rowNote: null,
    currency: "USD",
    _fromVoucher: true,
    notInLedger: false,
    notInLedgerLabel: null,
    ledgerEffect,
    combinedEffect,
    ...changes,
  };
};
const sale = (changes: Partial<FactoryStatementRow> = {}) =>
  row({
    id: 90,
    transactionType: "SALE",
    referenceType: "INVOICE",
    referenceId: 90,
    referenceNumber: "INV-90",
    description: "ZAMBIA",
    combinedEffect: d(25860),
    ledgerEffect: d(25860),
    debitAmount: "25860.00",
    ...changes,
  });
const containers = new Map([[90, "CAAU5379196"]]);

describe("factory customer statement container charge consolidation", () => {
  it("includes freight and clearance in the sale's amount exactly once, retaining ledger totals", () => {
    const original = [
      row({ id: "ve-11", referenceId: 11, combinedEffect: d(710), ledgerEffect: d(710), debitAmount: "710.00" }),
      row({ id: "ve-12", referenceId: 12, description: "Freight for offloaded container - CAAU5379196",
        combinedEffect: d(5200), ledgerEffect: d(5200), debitAmount: "5200.00" }),
      sale(),
    ];
    const beforeTotal = original.reduce((sum, r) => sum.plus(r.combinedEffect), d(0));
    const beforeLedger = original.reduce((sum, r) => sum.plus(r.ledgerEffect), d(0));
    const result = consolidateContainerCharges(original, containers);
    expect(result).toHaveLength(1);
    expect(result[0].transactionType).toBe("SALE");
    expect(result[0].debitAmount).toBe("31770.00");
    expect(result[0].combinedEffect.equals(beforeTotal)).toBe(true);
    expect(result[0].ledgerEffect.equals(beforeLedger)).toBe(true);
    // The source objects remain unchanged and no voucher is ever deleted.
    expect(original[2].debitAmount).toBe("25860.00");
  });

  it("combines explicitly linked order charges, including invoice memo + posted charge splits", () => {
    const pendingSale = sale({
      notInLedger: true, ledgerEffect: d(0), combinedEffect: d(25860),
      notInLedgerLabel: "Not yet in ledger",
    });
    const linkedCharge = row({
      id: "ve-55", referenceId: 55, referenceNumber: "CHARGE-INV90-1-1",
      description: "Additional shipping charge", combinedEffect: d(300), ledgerEffect: d(300),
      debitAmount: "300.00",
    });
    const result = consolidateContainerCharges(
      [pendingSale, linkedCharge], containers, new Map([[55, 90]])
    );
    expect(result).toHaveLength(1);
    expect(result[0].combinedEffect.toFixed(2)).toBe("26160.00");
    expect(result[0].ledgerEffect.toFixed(2)).toBe("300.00");
    expect(result[0].combinedEffect.minus(result[0].ledgerEffect).toFixed(2)).toBe("25860.00");
    expect(result[0].notInLedgerLabel).toContain("posted charges");
  });

  it("folds cross-date charges for all-time statements but never changes currency", () => {
    const charges = [
      row({ combinedEffect: d(710), ledgerEffect: d(710), transactionDate: "2026-10-14",
        debitAmount: "710.00" }),
      row({ id: "ve-50", referenceId: 50, combinedEffect: d(5200), ledgerEffect: d(5200),
        debitAmount: "5200.00", currency: "EUR" }),
    ];
    const result = consolidateContainerCharges([sale(), ...charges], containers);
    expect(result).toHaveLength(2);
    expect(result[0].debitAmount).toBe("26570.00");
    expect(result[0].transactionDate).toBe("2026-10-14");
    expect(result[1].currency).toBe("EUR");
  });

  it("uses the real September legacy charge links for the late freight and keeps closing totals", () => {
    const saleRow = sale({ referenceId: 147, id: 147,
      transactionDate: "2026-08-31", combinedEffect: d(34505),
      ledgerEffect: d(34505), debitAmount: "34505.00" });
    const clearance = row({ id: "ve-12556", referenceId: 12556,
      transactionDate: "2026-08-31", combinedEffect: d(721),
      ledgerEffect: d(721), debitAmount: "721.00" });
    const lateFreight = row({ id: "ve-12845", referenceId: 12845,
      transactionDate: "2026-09-01",
      description: "Freight for offloaded container - ECMU7436734",
      combinedEffect: d(3650), ledgerEffect: d(3650), debitAmount: "3650.00" });
    const result = consolidateContainerCharges(
      [saleRow, clearance, lateFreight],
      new Map([[147, { containerNumber: "ECMU7436734", status: "FINALIZED" }]]),
      new Map([[12556, 147], [12845, 147]])
    );
    expect(result).toHaveLength(1);
    expect(result[0].debitAmount).toBe("38876.00");
    expect(result[0].transactionDate).toBe("2026-09-01");
  });

  it("shows posted freight on a VERIFIED container as a container cost, not a journal or sale", () => {
    const posted = row({ id: "ve-15969", referenceId: 15969,
      transactionDate: "2026-09-22", combinedEffect: d(2250),
      ledgerEffect: d(2250), debitAmount: "2250.00",
      description: "Freight for container - MRSU7669057" });
    const result = consolidateContainerCharges(
      [posted],
      new Map([[184, { containerNumber: "MRSU7669057", status: "VERIFIED" }]]),
      new Map([[15969, 184]])
    );
    expect(result).toHaveLength(1);
    expect(result[0].transactionType).toBe("CONTAINER_COST");
    expect(result[0].referenceType).toBe("INVOICE");
    expect(result[0].referenceId).toBe(184);
    expect(result[0].debitAmount).toBe("2250.00");
    expect(result[0].ledgerEffect.toFixed(2)).toBe("2250.00");
  });

  it("retains the actual period allocation when a charge is posted after the invoice", () => {
    const baseSale = sale({ id: 147, referenceId: 147, transactionDate: "2026-08-31" });
    const charge = row({ referenceId: 12845, transactionDate: "2026-09-01",
      description: "Freight for offloaded container - ECMU7436734",
      combinedEffect: d(3650), ledgerEffect: d(3650), debitAmount: "3650.00" });
    const result = consolidateContainerCharges(
      [baseSale, charge],
      new Map([[147, "ECMU7436734"]]),
      new Map([[12845, 147]]),
      { from: "2026-09-01", to: "2026-09-30" }
    );
    expect(result).toHaveLength(2);
    expect(result[0].debitAmount).toBe("25860.00");
    expect(result[1].transactionType).toBe("CONTAINER_COST");
    expect(result[1].debitAmount).toBe("3650.00");
    expect(result[1].transactionDate).toBe("2026-09-01");
  });

  it("does not fold a charge when two invoices share the same container and date", () => {
    const result = consolidateContainerCharges(
      [
        sale(),
        sale({ id: 91, referenceId: 91, referenceNumber: "INV-91", combinedEffect: d(100),
          ledgerEffect: d(100), debitAmount: "100.00" }),
        row({ combinedEffect: d(710), ledgerEffect: d(710) }),
      ],
      new Map([[90, "CAAU5379196"], [91, "CAAU5379196"]])
    );
    expect(result).toHaveLength(3);
  });

  it("preserves payments, reversals, unrelated journals and other customers", () => {
    const unrelated = [
      row({ id: "ve-20", description: "Cash payment - CAAU5379196",
        transactionType: "PAYMENT", combinedEffect: d(-200), ledgerEffect: d(-200), debitAmount: "0", creditAmount: "200.00" }),
      row({ id: "ve-21", description: "Adjustment for offloaded container - CAAU5379196",
        combinedEffect: d(-100), ledgerEffect: d(-100), debitAmount: "0", creditAmount: "100.00" }),
      row({ id: "ve-22", description: "Unrelated journal", combinedEffect: d(99), ledgerEffect: d(99),
        debitAmount: "99.00" }),
      row({ id: "ve-23", customerId: 8, combinedEffect: d(710), ledgerEffect: d(710), debitAmount: "710.00" }),
    ];
    const result = consolidateContainerCharges([sale(), ...unrelated], containers);
    expect(result).toHaveLength(5);
    expect(result[0].debitAmount).toBe("25860.00");
  });
});
