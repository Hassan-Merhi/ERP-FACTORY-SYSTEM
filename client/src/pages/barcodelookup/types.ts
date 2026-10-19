import type { BaleLabelPrint, BaleProduct } from "@shared/schema";

export type SearchMode = "reference" | "article";
export type LookupDate = string | Date | null | undefined;

export type LookupBaleProduct = BaleProduct & {
  active?: boolean;
  articleCode?: string | null;
  code: string;
  name: string;
};

export type LookupLabelPrint = Omit<BaleLabelPrint, "scannedAt" | "scannedByUserId"> & {
  approxWeightKg: string;
  articleCode?: string | null;
  baleStatus?: string | null;
  pieces?: number | null;
  printedAt?: LookupDate;
  printedByName?: string | null;
  printedByUserId?: number | string | null;
  referenceNumber: string;
  scannedAt?: LookupDate;
  scannedByName?: string | null;
  scannedByUserId?: number | string | null;
};

export interface BaleInfo {
  id: number;
  baleCode: string;
  status: string;
  weightKg: string;
  costPerKg: string;
  totalCost: string;
  productName: string | null;
  grade: string | null;
  stockEntryDate: string | null;
  pressedAt: string | null;
  finalizedAt: string | null;
  workerName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
}

export interface SourceContainerInfo {
  id: number;
  containerNumber: string;
  origin: string | null;
  arrivalDate: string | null;
  status: string;
  supplierName: string | null;
  weightKgUsed: string | null;
  currencyCode: string;
  ratePerKg: string | null;
}

export interface LoadedOrderInfo {
  orderId: number;
  invoiceNumber: string | null;
  orderDate: string;
  status: string;
  containerNumber: string | null;
  shippingCompany: string | null;
  containerNotes: string | null;
  destination: string | null;
  bookingInfo: string | null;
  canViewBookingInfo: boolean;
  loadingStartedAt: string | null;
  loadingFinalizedAt: string | null;
  grandTotal: string;
  totalQtyBales: number;
  customerName: string | null;
  priceUsed: string;
  baleWeight: string;
  scannedBy: string | null;
}

export interface AuditHistoryEntry {
  id: number;
  action: string;
  username: string;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  createdAt: string;
}

export interface ReferenceLookupResult {
  labelPrint: LookupLabelPrint | null;
  product: LookupBaleProduct | null;
  baleInfo: BaleInfo | null;
  locationInfo: { id: number; name: string; city: string | null; state: string | null } | null;
  pressingBatch: {
    id: number;
    status: string;
    expectedCount: number;
    finalizedAt: string | null;
    notes: string | null;
  } | null;
  mixBatch: {
    id: number;
    batchCode: string;
    batchNumber: string | null;
    name: string | null;
    batchDate: string | null;
    totalWeightKg: string;
    costPerKg: string;
    status: string;
    operatorUser: string | null;
  } | null;
  containers_used: SourceContainerInfo[];
  loadedOnOrder: LoadedOrderInfo | null;
  auditHistory: AuditHistoryEntry[];
}

export interface ArticleLookupResult {
  product: LookupBaleProduct | null;
  labelPrints: LookupLabelPrint[];
}

export interface SwapPreview {
  referenceNumber: string;
  productName: string | null;
  weightKg: string;
  status: string;
  articleCode: string | null;
}

export interface ReturnToStockOrderInfo {
  status: string;
  invoiceNumber?: string | null;
  customerName?: string | null;
  grandTotal?: string | null;
  totalBalesInOrder: number;
}

export interface ReturnToStockResult {
  invoiceNumber?: string | null;
  newGrandTotal?: string | null;
}

export interface SwapResult {
  invoiceNumber?: string | null;
  newGrandTotal?: string | null;
  replacedRef: string;
  replacementRef: string;
}
