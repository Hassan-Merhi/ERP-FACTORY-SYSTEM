/**
 * Types for the TransactionJournal page.
 *
 * Extracted from TransactionJournal.tsx during the Phase 4 god-file split.
 */

export interface JournalVoucher {
  id: number;
  companyId: number;
  companyName: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  totalAmount: string;
  currency: "USD" | "CFA";
  optional: boolean;
  description: string | null;
  narration: string | null;
  deletedAt: string | null;
}

export interface SummaryRow {
  companyId: number;
  companyName: string;
  currency: string;
  voucherCount: number;
  totalDebits: string | null;
  totalCredits: string | null;
}

export interface CompanyOption {
  id: number;
  name: string;
}

export interface JournalResponse {
  vouchers: JournalVoucher[];
  total: number;
  page: number;
  totalPages: number;
  summary: SummaryRow[];
  companies: CompanyOption[];
}

export interface VoucherEntry {
  id: number;
  ledgerAccountId: number | null;
  customerId: number | null;
  accountName: string | null;
  debitAmount: string;
  creditAmount: string;
  narration: string | null;
}

export interface VoucherDetail {
  voucher: JournalVoucher;
  entries: VoucherEntry[];
}

// ─── View-entries detail shapes ───────────────────────────────────────────────
//
// /api/global/transactions/:voucherId/view-entries returns either a plain row
// array or, for Purchase vouchers that still have their purchase order, a
// `{ entries, purchaseOrder, items }` envelope (server/routes/
// globalTransactionRoutes.ts). Both shapes are modelled here.

/** Row returned by the view-entries detail endpoint. */
export interface JournalViewEntry {
  id: number;
  accountName: string | null;
  debitAmount: string;
  creditAmount: string;
  narration?: string | null;
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
  fixedAssetId?: number | null;
  supplierId?: number | null;
  employeeId?: number | null;
  factorySupplierId?: number | null;
  customerId?: number | null;
  // Stock-item rows (Sales/POS, Stock Transfer, Production/Consumption/Mixed,
  // Purchase line items) carry the movement fields on the same row.
  voucherId?: number;
  stockItemId?: number | null;
  stockItemName?: string;
  stockItemCode?: string;
  quantity?: string;
  rate?: string;
  sellingPrice?: string;
  costPrice?: string | null;
  totalSales?: string;
  profit?: string | null;
  hassansPrice?: string | null;
  hassansProfit?: string | null;
  hassansPercentage?: string | null;
  totalAmount?: string;
  isStockItem?: boolean;
  isPurchaseItem?: boolean;
  adjustmentType?: string;
}

/** Enriched purchase-order header from the Purchase view-entries envelope. */
export interface JournalPurchaseOrder {
  id: number;
  poNumber: string;
  supplierId: number;
  supplierName: string;
  containerId: number;
  containerNumber: string;
  currency: string;
  itemsTotal: string | null;
  freight: string | null;
  fumigation: string | null;
  surcharge: string | null;
  documentCharges: string | null;
  otherCharges: string | null;
  discount: string | null;
  status: string;
}

/** Purchase view-entries envelope. */
export interface JournalViewEntriesEnvelope {
  entries: JournalViewEntry[];
  purchaseOrder: JournalPurchaseOrder;
  items: JournalViewEntry[];
}

export type JournalViewEntriesResponse = JournalViewEntry[] | JournalViewEntriesEnvelope;

// ─── Helpers ──────────────────────────────────────────────────────────────────
