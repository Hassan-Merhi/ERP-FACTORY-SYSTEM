/**
 * Types for the PurchaseOrderEdit page.
 *
 * Extracted from PurchaseOrderEdit.tsx during the Phase 4 god-file split.
 */

export interface LineItem {
  id?: number;
  stockItemId: number | null;
  itemName: string;
  quantity: string;
  rate: string;
  lineTotal?: string;
  nativeRate?: string | null;
  nativeLineTotal?: string | null;
}

export interface StockItem {
  id: number;
  name: string;
  code: string;
}

export interface PurchaseOrder {
  id: number;
  poNumber: string;
  supplierId: number;
  supplierName: string;
  supplierCode: string;
  containerId: number;
  containerNumber: string;
  currency: string;
  historicalExchangeRate?: string | null;
  historicalRateDate?: string | null;
  nativeItemsTotal?: string | null;
  nativeFreight?: string | null;
  nativeSurcharge?: string | null;
  nativeFumigation?: string | null;
  nativeDocumentCharges?: string | null;
  nativeDiscount?: string | null;
  nativeOtherCharges?: string | null;
  itemsTotal: string;
  freight: string;
  surcharge: string;
  fumigation: string;
  documentCharges: string;
  discount: string;
  otherCharges: string;
  status: string;
  items: LineItem[];
  freightPaidBy?: string;
  freightOwnAccountId?: number | null;
  freightParentAccountId?: number | null;
}
