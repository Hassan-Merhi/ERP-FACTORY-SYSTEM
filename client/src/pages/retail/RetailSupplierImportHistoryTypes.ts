// Extracted from ./RetailSupplierImportHistory.tsx

export interface RetailSupplierPurchaseHistoryEntry {
  operationId: number;
  invoiceReference: string;
  deliveryReference: string | null;
  partialReceipt: boolean;
  invoiceDate: string;
  supplierId: number;
  supplierName: string;
  locationId: number;
  locationName: string;
  currency: string;
  purchaseTotal: string;
  baseTotal: string;
  voucherId: number;
  variantCount: number;
  unitsReceived: number;
  invoiceFileId: number | null;
  createdAt: string;
  createdBy: string;
}

export interface RetailSupplierPurchaseDetail {
  operationId: number;
  invoiceReference: string;
  deliveryReference: string | null;
  partialReceipt: boolean;
  invoiceDate: string;
  createdAt: string;
  createdBy: string;
  supplierId: number;
  supplierName: string;
  locationId: number;
  locationName: string;
  currency: string;
  exchangeRate: string;
  purchaseTotal: string;
  baseTotal: string;
  voucherId: number;
  items: Array<{
    rowNumber: number;
    variantId: number;
    barcode: string;
    quantity: number;
    name?: string;
    brand?: string;
    color?: string;
    size?: string;
    unitCost?: string;
    sellingPrice?: string;
  }>;
  totalUnits: number;
  movementsMatch: boolean;
  barcodesMatch: boolean;
  reprintAllowed: boolean;
  invoiceFile: null | {
    id: number;
    fileName: string;
    fileType: string;
    fileSize: number;
    downloadUrl: string;
  };
}

export interface RetailSupplierHistoryPage {
  rows: RetailSupplierPurchaseHistoryEntry[];
  nextOffset: number | null;
}
