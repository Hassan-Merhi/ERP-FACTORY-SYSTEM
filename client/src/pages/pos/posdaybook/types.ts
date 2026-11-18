/**
 * Types for the POSDaybook page.
 *
 * Extracted from POSDaybook.tsx during the Phase 4 god-file split.
 */

export interface Voucher {
  id: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  description: string | null;
  optional?: boolean;
  totalAmount: string;
  currency?: string | null;
  exchangeRate?: string | null;
  nativeZmwTotal?: string | null;
  locationId: number;
  locationName?: string;
  createdAt: string;
  userId?: string | null;
}

export interface SalesItem {
  id: number;
  stockItemId: number;
  stockItemName?: string;
  quantity: string;
  sellingPrice: string;
  costPrice: string;
  totalSales: string;
  totalCost: string;
  profit: string;
  configuredPrice?: string | null;
}

export interface PosDaybookTransferData {
  id: number;
  voucherId: number;
  sourceLocationId: number | null;
  sourceLocationName: string;
  destinationLocationId: number;
  destinationLocationName: string;
  inventoryApplied: boolean | null;
  notes: string | null;
  items: Array<{
    id: number;
    stockItemId: number;
    stockItemCode: string;
    stockItemName: string;
    stockItemUom: string;
    sourceLocationId: number | null;
    sourceLocationName: string;
    quantity: string;
  }>;
}

export interface VoucherWithItems extends Voucher {
  transferData?: PosDaybookTransferData | null;
  salesItems?: SalesItem[];
  entries?: Array<{ transactionCurrency?: string | null; transactionDebitAmount?: string | null }>;
  isCreditSale?: boolean;
  customerName?: string | null;
}
