/**
 * Ledger derivation logic for the Suppliers detail dialog.
 *
 * Extracted from Suppliers.tsx during the P1 god-file split. These are the
 * pure calculations behind the supplier-detail KPIs, date filtering, payment
 * hiding, purchase-order totals, and the Excel export row mapping. Nothing
 * here touches React state or JSX, so the behavior is unit-testable in
 * isolation from the page.
 */

import { format } from "date-fns";
import { isPaymentRow, type SupplierLedgerRow, type SupplierPurchaseOrder } from "./supplierDisplay";

export type SupplierDateFilter = "all" | "today" | "yesterday" | "this_month" | "this_year";

export interface SupplierLedgerKpis {
  txCount: number;
  totalPurchases: number;
  totalPayments: number;
  totalPurchasesQty: number;
}

/**
 * Filters ledger rows (the "opening" row already removed by the caller) by the
 * selected date window. Matches the original page behavior: rows without a
 * date never match any concrete window.
 */
export function filterLedgerRowsByDate(rows: SupplierLedgerRow[], dateFilter: SupplierDateFilter): SupplierLedgerRow[] {
  if (dateFilter === "all") return rows;

  const todayStr = format(new Date(), "yyyy-MM-dd");
  const yesterdayStr = format(new Date(Date.now() - 86400000), "yyyy-MM-dd");
  const now = new Date();

  if (dateFilter === "today") {
    return rows.filter((t) => t.date && format(new Date(t.date), "yyyy-MM-dd") === todayStr);
  }
  if (dateFilter === "yesterday") {
    return rows.filter((t) => t.date && format(new Date(t.date), "yyyy-MM-dd") === yesterdayStr);
  }
  if (dateFilter === "this_month") {
    return rows.filter((t) => {
      if (!t.date) return false;
      const d = new Date(t.date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
  }
  // "this_year"
  return rows.filter((t) => {
    if (!t.date) return false;
    return new Date(t.date).getFullYear() === now.getFullYear();
  });
}

/** KPI cards in the supplier detail dialog header. */
export function computeLedgerKpis(rows: SupplierLedgerRow[]): SupplierLedgerKpis {
  return {
    txCount: rows.length,
    totalPurchases: rows.reduce((s: number, t) => s + (Number(t.credit) || 0), 0),
    totalPayments: rows.reduce((s: number, t) => s + (Number(t.debit) || 0), 0),
    totalPurchasesQty: rows.filter(
      (t) => t.voucherType === "Purchase" || (t.voucherType === "Journal" && (Number(t.credit) || 0) > 0)
    ).length,
  };
}

/** Running balance of the most recent ledger row (0 for an empty ledger). */
export function currentLedgerBalance(ledger: SupplierLedgerRow[]): number {
  return ledger.length > 0 ? (ledger[ledger.length - 1]?.balance ?? 0) : 0;
}

/** Rows shown in the transactions table once the "Hide Payments" toggle is on. */
export function displayedLedgerRows(rows: SupplierLedgerRow[], hidePayments: boolean): SupplierLedgerRow[] {
  return hidePayments ? rows.filter((t) => !isPaymentRow(t)) : rows;
}

/** How many payment rows the toggle is currently hiding (0 when it is off). */
export function hiddenPaymentsCount(rows: SupplierLedgerRow[], hidePayments: boolean): number {
  return hidePayments ? rows.filter((t) => isPaymentRow(t)).length : 0;
}

/** Voucher types that deep-link into a named vouchers tab instead of the generic detail page. */
const VOUCHER_TYPE_TO_TAB: Record<string, string> = {
  Payment: "payment",
  Receipt: "receipt",
  Journal: "journal",
  Consumption: "adjustment",
  Production: "adjustment",
  Mixed: "adjustment",
  StockTransfer: "transfer",
  "Stock Transfer": "transfer",
  "Credit Note": "credit-note",
  "Debit Note": "credit-note",
};

export function voucherTabForType(voucherType: string): string | undefined {
  return VOUCHER_TYPE_TO_TAB[voucherType];
}

/** Row shape for the supplier ledger Excel export (column order matters). */
export interface SupplierLedgerExportRow {
  Date: string;
  Company: string;
  "Doc Number": string;
  Type: string;
  Description: string;
  Currency: string;
  "Native Debit": string | number | null | undefined;
  "Native Credit": string | number | null | undefined;
  "Historical Base Debit": string | number | null | undefined;
  "Historical Base Credit": string | number | null | undefined;
  "Historical Exchange Rate": string | number | null | undefined;
  "Balance (Historical Base)": string | number | null | undefined;
  "Currency Status": string;
}

export function supplierLedgerToExportRows(ledger: SupplierLedgerRow[]): SupplierLedgerExportRow[] {
  return ledger.map((txn) => ({
    Date: txn.date ? format(new Date(txn.date), "yyyy-MM-dd") : "",
    Company: txn.companyName,
    "Doc Number": txn.docNumber,
    Type: txn.voucherType,
    Description: txn.description,
    Currency: txn.currency || txn.transactionCurrency || "USD",
    "Native Debit": txn.transactionDebitAmount ?? txn.debitAmount ?? "",
    "Native Credit": txn.transactionCreditAmount ?? txn.creditAmount ?? "",
    "Historical Base Debit": txn.baseDebitAmount ?? "",
    "Historical Base Credit": txn.baseCreditAmount ?? "",
    "Historical Exchange Rate": txn.historicalExchangeRate ?? "",
    "Balance (Historical Base)": txn.historicalBaseBalance ?? txn.balance,
    "Currency Status": txn.currencyStatus || (txn.baseDebitAmount != null ? "HISTORICAL_BASE" : "LEGACY_BASE"),
  }));
}

export interface SupplierPurchaseOrderWithTotal extends SupplierPurchaseOrder {
  totalAmount: number;
}

/**
 * Purchase orders for the detail dialog's second tab, newest first, with the
 * landed-cost total (items + freight + surcharge + fumigation + document
 * charges - discount + other charges) precomputed per row.
 */
export function enrichPurchaseOrderTotals(purchaseOrders: SupplierPurchaseOrder[]): SupplierPurchaseOrderWithTotal[] {
  return [...purchaseOrders]
    .sort((a, b) => new Date(b.importDate || b.createdAt).getTime() - new Date(a.importDate || a.createdAt).getTime())
    .map((po) => {
      const itemsTotal = parseFloat(String(po.itemsTotal || "0"));
      const freight = parseFloat(String(po.freight || "0"));
      const surcharge = parseFloat(String(po.surcharge || "0"));
      const fumigation = parseFloat(String(po.fumigation || "0"));
      const documentCharges = parseFloat(String(po.documentCharges || "0"));
      const discount = parseFloat(String(po.discount || "0"));
      const otherCharges = parseFloat(String(po.otherCharges || "0"));
      const totalAmount = itemsTotal + freight + surcharge + fumigation + documentCharges - discount + otherCharges;
      return { ...po, totalAmount };
    });
}

export function purchaseOrderGrandTotal(orders: SupplierPurchaseOrderWithTotal[]): number {
  return orders.reduce((sum: number, po) => sum + po.totalAmount, 0);
}
