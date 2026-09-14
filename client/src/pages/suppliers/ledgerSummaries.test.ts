/**
 * Behavior tests for the supplier-detail ledger derivations extracted from
 * Suppliers.tsx. These pin the KPI math, date-window filtering, payment
 * hiding, voucher deep-link mapping, PO total math, and the Excel export
 * row mapping so the page can be refactored without drifting.
 */

import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import type { SupplierLedgerRow, SupplierPurchaseOrder } from "./supplierDisplay";
import {
  computeLedgerKpis,
  currentLedgerBalance,
  displayedLedgerRows,
  enrichPurchaseOrderTotals,
  filterLedgerRowsByDate,
  hiddenPaymentsCount,
  purchaseOrderGrandTotal,
  supplierLedgerToExportRows,
  voucherTabForType,
} from "./ledgerSummaries";

function ledgerRow(overrides: Partial<SupplierLedgerRow>): SupplierLedgerRow {
  return {
    type: "transaction",
    date: null,
    companyId: 1,
    companyName: "HQ",
    docNumber: "DOC-1",
    voucherId: 10,
    description: "",
    voucherType: "Purchase",
    debit: 0,
    credit: 0,
    balance: 0,
    ...overrides,
  };
}

function purchaseOrder(overrides: Partial<SupplierPurchaseOrder>): SupplierPurchaseOrder {
  return {
    id: 1,
    companyId: 1,
    containerId: null,
    containerNumber: null,
    companyName: "HQ",
    importDate: null,
    createdAt: "2026-01-01T00:00:00Z",
    itemsTotal: 0,
    freight: null,
    surcharge: null,
    fumigation: null,
    documentCharges: null,
    discount: null,
    otherCharges: null,
    ...overrides,
  };
}

describe("filterLedgerRowsByDate", () => {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);
  const lastYear = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());

  it("returns every row for the 'all' window", () => {
    const rows = [ledgerRow({}), ledgerRow({ type: "opening" })];
    expect(filterLedgerRowsByDate(rows, "all")).toBe(rows);
  });

  it("keeps only same-day rows for 'today'", () => {
    const rows = [
      ledgerRow({ date: format(today, "yyyy-MM-dd") }),
      ledgerRow({ date: format(yesterday, "yyyy-MM-dd") }),
      ledgerRow({ date: null }),
    ];
    expect(filterLedgerRowsByDate(rows, "today").map((r) => r.date)).toEqual([format(today, "yyyy-MM-dd")]);
  });

  it("keeps only yesterday's rows for 'yesterday'", () => {
    const rows = [
      ledgerRow({ date: format(today, "yyyy-MM-dd") }),
      ledgerRow({ date: format(yesterday, "yyyy-MM-dd") }),
    ];
    expect(filterLedgerRowsByDate(rows, "yesterday").map((r) => r.date)).toEqual([format(yesterday, "yyyy-MM-dd")]);
  });

  it("keeps same-calendar-month rows for 'this_month'", () => {
    const rows = [
      ledgerRow({ date: format(today, "yyyy-MM-dd") }),
      ledgerRow({ date: format(lastMonth, "yyyy-MM-dd") }),
      ledgerRow({ date: format(yesterday, "yyyy-MM-dd") }),
    ];
    const kept = filterLedgerRowsByDate(rows, "this_month").map((r) => r.date);
    // yesterday may or may not share this month's calendar month around month
    // boundaries — assert the two stable cases instead of the ambiguous one.
    expect(kept).toContain(format(today, "yyyy-MM-dd"));
    expect(kept).not.toContain(format(lastMonth, "yyyy-MM-dd"));
  });

  it("keeps same-calendar-year rows for 'this_year' and drops undated rows", () => {
    const rows = [
      ledgerRow({ date: format(today, "yyyy-MM-dd") }),
      ledgerRow({ date: format(lastYear, "yyyy-MM-dd") }),
      ledgerRow({ date: null }),
    ];
    const kept = filterLedgerRowsByDate(rows, "this_year").map((r) => r.date);
    expect(kept).toContain(format(today, "yyyy-MM-dd"));
    expect(kept).not.toContain(format(lastYear, "yyyy-MM-dd"));
    expect(kept).not.toContain(null);
  });
});

describe("computeLedgerKpis", () => {
  it("sums purchases from credits and payments from debits", () => {
    const rows = [
      ledgerRow({ voucherType: "Purchase", credit: 100 }),
      ledgerRow({ voucherType: "Payment", debit: 40 }),
      ledgerRow({ voucherType: "Journal", credit: 10 }),
      ledgerRow({ voucherType: "Receipt", debit: 5 }),
    ];
    expect(computeLedgerKpis(rows)).toEqual({
      txCount: 4,
      totalPurchases: 110,
      totalPayments: 45,
      totalPurchasesQty: 2, // Purchase + credit-side Journal
    });
  });

  it("treats a debit-only Journal as a purchase, not a purchase line", () => {
    const rows = [ledgerRow({ voucherType: "Journal", debit: 10 }), ledgerRow({ voucherType: "Purchase", credit: 0 })];
    const kpis = computeLedgerKpis(rows);
    expect(kpis.totalPurchasesQty).toBe(1); // only the Purchase row counts
  });
});

describe("currentLedgerBalance", () => {
  it("uses the running balance of the last row", () => {
    expect(currentLedgerBalance([ledgerRow({ balance: 5 }), ledgerRow({ balance: -3 })])).toBe(-3);
  });

  it("is zero for an empty ledger", () => {
    expect(currentLedgerBalance([])).toBe(0);
  });
});

describe("payment hiding", () => {
  const rows = [
    ledgerRow({ voucherType: "Purchase", credit: 100 }),
    ledgerRow({ voucherType: "Payment", debit: 60 }),
    ledgerRow({ voucherType: "Receipt", debit: 10 }),
  ];

  it("shows everything when the toggle is off", () => {
    expect(displayedLedgerRows(rows, false)).toHaveLength(3);
    expect(hiddenPaymentsCount(rows, false)).toBe(0);
  });

  it("hides payment/receipt rows and reports the count when on", () => {
    expect(displayedLedgerRows(rows, true).map((r) => r.voucherType)).toEqual(["Purchase"]);
    expect(hiddenPaymentsCount(rows, true)).toBe(2);
  });

  it("hides rows that are payment-shaped purely by debit amount", () => {
    const rowsWithDebit = [ledgerRow({ voucherType: "Journal", debit: 5 })];
    expect(displayedLedgerRows(rowsWithDebit, true)).toHaveLength(0);
  });
});

describe("voucherTabForType", () => {
  it("maps voucher types to their vouchers-tab deep link", () => {
    expect(voucherTabForType("Payment")).toBe("payment");
    expect(voucherTabForType("Receipt")).toBe("receipt");
    expect(voucherTabForType("Journal")).toBe("journal");
    expect(voucherTabForType("Consumption")).toBe("adjustment");
    expect(voucherTabForType("Stock Transfer")).toBe("transfer");
    expect(voucherTabForType("Credit Note")).toBe("credit-note");
  });

  it("returns undefined for types that open the generic detail page", () => {
    expect(voucherTabForType("Sales")).toBeUndefined();
    expect(voucherTabForType("Contra")).toBeUndefined();
  });
});

describe("supplierLedgerToExportRows", () => {
  it("maps ledger rows to the export columns with fallbacks", () => {
    const [row] = supplierLedgerToExportRows([
      ledgerRow({
        date: "2026-08-31T12:00:00Z",
        companyName: "Lebanon",
        docNumber: "P-99",
        voucherType: "Purchase",
        description: "rice",
        currency: "LBP",
        transactionCurrency: "LBP",
        transactionDebitAmount: "120000",
        transactionCreditAmount: "30000",
        baseDebitAmount: "100",
        baseCreditAmount: "25",
        historicalExchangeRate: "1000",
        historicalBaseBalance: "-75",
        currencyStatus: "HISTORICAL_BASE",
      }),
    ]);
    expect(row).toEqual({
      Date: "2026-08-31",
      Company: "Lebanon",
      "Doc Number": "P-99",
      Type: "Purchase",
      Description: "rice",
      Currency: "LBP",
      "Native Debit": "120000",
      "Native Credit": "30000",
      "Historical Base Debit": "100",
      "Historical Base Credit": "25",
      "Historical Exchange Rate": "1000",
      "Balance (Historical Base)": "-75",
      "Currency Status": "HISTORICAL_BASE",
    });
  });

  it("derives currency status from base amounts and defaults currency to USD", () => {
    const [row] = supplierLedgerToExportRows([
      ledgerRow({ baseDebitAmount: 10 }), // historical base present
    ]);
    expect(row.Currency).toBe("USD");
    expect(row["Currency Status"]).toBe("HISTORICAL_BASE");
    expect(row["Native Debit"]).toBe("");
    expect(row["Balance (Historical Base)"]).toBe(0);

    const [legacy] = supplierLedgerToExportRows([ledgerRow({})]);
    expect(legacy["Currency Status"]).toBe("LEGACY_BASE");
    expect(legacy["Balance (Historical Base)"]).toBe(0);
  });
});

describe("purchase order totals", () => {
  it("computes the landed-cost total and sorts newest first", () => {
    const orders = enrichPurchaseOrderTotals([
      purchaseOrder({
        id: 2,
        importDate: "2026-03-01T00:00:00Z",
        itemsTotal: 100,
        freight: 10,
        surcharge: 2,
        fumigation: 1,
        documentCharges: 3,
        discount: 5,
        otherCharges: 4,
      }),
      purchaseOrder({ id: 1, importDate: "2026-01-15T00:00:00Z", itemsTotal: "50" }),
    ]);
    expect(orders.map((o) => o.id)).toEqual([2, 1]);
    expect(orders[0].totalAmount).toBe(115); // 100+10+2+1+3-5+4
    expect(orders[1].totalAmount).toBe(50); // string amounts are parsed
    expect(purchaseOrderGrandTotal(orders)).toBe(165);
  });

  it("does not mutate the input array", () => {
    const input = [purchaseOrder({ id: 2 }), purchaseOrder({ id: 1 })];
    const original = [...input];
    enrichPurchaseOrderTotals(input);
    expect(input).toEqual(original);
  });
});
