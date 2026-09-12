/**
 * Types for the PendingInvoiceVerify page.
 *
 * Extracted from PendingInvoiceVerify.tsx during the Phase 4 god-file split.
 */

export interface FinalizePreviewBale {
  id: number;
  baleReference: string;
  productName: string;
  weightKg: number;
  locationName: string;
  status: string;
}

export interface FinalizePreview {
  baleCount: number;
  totalBalesInOrder: number;
  bales: FinalizePreviewBale[];
}

export interface ComparisonItem {
  articleCode: string;
  productName: string;
  loadedQty: number;
  expectedQty: number;
  diff: number;
  totalWeight: number;
  totalPrice: number;
  pricePerBale: string;
  inProforma: boolean;
  status: "LOADED_NOT_IN_PROFORMA" | "MISSING_FROM_LOADED" | "UNDER_LOADED" | "OVER_LOADED" | "MATCH";
}

export interface ProformaLine {
  articleCode: string;
  productName: string;
  expectedQty: number;
  pricePerBale: string;
}

export interface LoadedGroup {
  articleCode: string;
  productName: string;
  qty: number;
  totalWeight: number;
  totalPrice: number;
  pricePerBale: string;
}

export interface VerificationSummary {
  order: OrderDetail;
  proformaLines: ProformaLine[];
  loadedItems: LoadedGroup[];
  comparison: ComparisonItem[];
  totalLoadedBales: number;
  totalLoadedWeight: number;
}

export interface OrderCharge {
  id: number;
  name: string;
  amount: string;
  chargeType: string;
  ledgerAccountId?: number;
}

export interface OrderDetail {
  id: number;
  customerId: number;
  companyId: number;
  orderDate: string;
  status: string;
  invoiceNumber?: string;
  subtotalBales: string;
  freightAmount: string;
  otherChargesTotal: string;
  grandTotal: string;
  totalQtyBales: number;
  charges: OrderCharge[];
  containerNumber?: string;
  shippingCompany?: string;
  containerNotes?: string;
}
