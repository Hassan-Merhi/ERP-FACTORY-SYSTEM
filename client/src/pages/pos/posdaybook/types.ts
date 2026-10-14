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
  totalAmount: string;
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

export interface VoucherWithItems extends Voucher {
  salesItems?: SalesItem[];
  exchangeRate?: string | null;
  isCreditSale?: boolean;
  customerName?: string | null;
}
