/**
 * Types for the POS Import page.
 *
 * Extracted from POSImport.tsx during the god-file split; shapes are
 * unchanged.
 */

export interface Location {
  id: number;
  name: string;
}

export interface LedgerAccount {
  id: number;
  code: string;
  name: string;
  accountType: string;
}

export interface Customer {
  id: number;
  legalName: string;
}

export interface PosImportItem {
  barcode?: string;
  quantity: number | string;
  rate: number | string;
  stockItemName?: string;
  stockItemId?: number;
  error?: string;
  warning?: string;
  currentStock?: number;
  [key: string]: unknown;
}

export interface PosImportPreview {
  items: PosImportItem[];
  totalValue: number;
}

export interface PosImportValidationResult {
  errors: string[];
  warnings: string[];
  validatedItems: PosImportItem[];
}

export interface ImportedSale {
  voucher?: {
    exchangeRate?: string;
    description?: string;
  } | null;
  items: PosImportItem[];
  grandTotal: number | string;
  saleDate: string;
  location?: Location;
  isCreditSale: boolean;
  customer?: { name: string } | null;
}
