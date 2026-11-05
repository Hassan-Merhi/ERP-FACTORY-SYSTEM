/**
 * Types for the FactoryLocationInventory page.
 *
 * Extracted from FactoryLocationInventory.tsx during the Phase 4 god-file split.
 */

export type SortField = "name" | "bales" | "kg" | "value";

export type SortDir = "asc" | "desc";

export interface Location {
  id: number;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface FactoryBaleProduct {
  productId: number;
  articleCode: string;
  productName: string;
  productNameAr?: string | null;
  category: string | null;
  categoryId: number | null;
  quantity: number;
  totalWeight: number;
  totalCost: number;
  baleCount: number;
  loadingCount?: number;
  sellingPrice: string;
  productionPrice: number;
  reservedQty?: number;
  availableQty?: number;
  reservations?: Array<{ proformaId: number; proformaName: string; customerId: number; qty: number }>;
  isInactive?: boolean;
}

export interface CategoryGroup {
  categoryId: number | null;
  categoryName: string;
  baleCount: number;
  totalWeight: number;
  totalCost: number;
  totalSellValue: number;
  productCount: number;
  products: FactoryBaleProduct[];
}

export interface ProformaSelection {
  productId: number;
  articleCode: string;
  productName: string;
  availableBales: number;
  totalWeight: number;
  selectedQty: number;
  pricePerBale: string;
}

export interface Customer {
  id: number;
  legalName: string;
  balance: number;
  balanceSide: string;
}

export interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}

export interface FactoryProformaLine {
  articleCode: string;
  quantity: number;
  pricePerBale: string;
  productName?: string;
}

export interface CustomerProformaRecord {
  id: number;
  destination?: string | null;
  lines?: FactoryProformaLine[];
}

export interface ProformaMutationResult {
  id: number;
}

export interface RemoveBalesResult {
  removed: number;
}
