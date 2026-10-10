/**
 * Types for the FactoryPOS page.
 *
 * Extracted from FactoryPOS.tsx during the Phase 4 god-file split.
 */

export interface CartRow {
  id: string;
  productId: number | null;
  productName: string;
  articleCode: string;
  availableQty: number;
  quantity: number;
  unitPrice: number;
  weightPerBale: number;
}

export interface InventoryItem {
  productId: number;
  productName: string;
  articleCode: string;
  category: string | null;
  quantity: number;
  totalWeight: number;
  sellingPrice: string;
  referenceNumbers?: string[];
}

export interface ExpenseRow {
  id: string;
  accountId: string;
  description: string;
  amount: string;
}

export interface PosLocation {
  id: number;
  name: string;
}

export interface PosCustomer {
  id: number;
  legalName?: string | null;
  name?: string | null;
  balance?: string | null;
  balanceSide?: "Dr" | "Cr" | string | null;
}

export interface PosLedgerAccount {
  id: number;
  name: string;
  accountType: string;
}

export interface PosSale {
  id: number;
  saleNumber: string;
  txDate: string;
  customerName?: string | null;
  totalAmount: string;
  status: string;
  currencyCode: string;
}

export interface SavedSaleExpense extends ExpenseRow {
  accountName?: string;
}

export interface SavedSale {
  saleNumber?: string;
  cartRows: CartRow[];
  customerName?: string;
  notes?: string;
  currencyCode: string;
  total: number;
  totalWeight: number;
  expenses: SavedSaleExpense[];
  netTotal: number;
  txDate: string;
  companyName: string;
  paymentType: string;
  depositAmount: string;
}

export interface EditSaleItem {
  id: number;
  productId: number | null;
  productName: string;
  articleCode?: string | null;
  quantity: string | number;
  unitPrice: string | number;
}

export interface ParsedExpense {
  accountId: string | number;
  description?: string | null;
  amount: string | number;
}
