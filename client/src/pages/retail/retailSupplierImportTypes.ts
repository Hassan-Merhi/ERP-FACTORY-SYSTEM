/** Shared types of the Retail supplier stock import dialog and its preview (split out of RetailSupplierImportDialog.tsx). */

export interface SupplierOption {
  id: number;
  code?: string | null;
  legalName?: string | null;
  name?: string | null;
}

export type CatalogDecision = {
  rowNumber: number;
  status: "new-product" | "new-variant" | "existing-variant" | "conflict";
  productId: number | null;
  variantId: number | null;
  existingBarcode: string | null;
  messages: string[];
};

export type BarcodePlan = {
  rowNumber: number;
  action: "reuse" | "supplier" | "generate" | "conflict";
  barcode: string | null;
  message: string;
};

export type SupplierPurchaseResult = {
  replayed: boolean;
  operationId: number;
  voucherId: number;
  purchaseTotal: string;
  baseTotal: string;
  currency: string;
  items: Array<{ rowNumber: number; variantId: number; barcode: string; quantity: number }>;
};

export type CatalogPreview = {
  decisions: CatalogDecision[];
  barcodePlans: BarcodePlan[];
  summary: { newProducts: number; newVariants: number; existingVariants: number; conflicts: number };
};

export const catalogLabels: Record<CatalogDecision["status"], string> = {
  "new-product": "New product",
  "new-variant": "New variant",
  "existing-variant": "Existing variant — restock",
  conflict: "Catalog conflict",
};
