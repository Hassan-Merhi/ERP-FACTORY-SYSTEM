/**
 * Types for the SalesReportLegacy page.
 *
 * Extracted from SalesReportLegacy.tsx during the Phase 4 god-file split.
 */

export interface SalesReportItem {
  id: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  locationId: number | null;
  locationName: string | null;
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  quantity: string;
  actualSellingPrice: string;
  configuredSellingPrice: string;
  costPrice: string;
  totalSales: string;
  totalCost: string;
  totalConfiguredCost: number;
  costProfit: string;
  costProfitPercentage: number;
  configuredProfit: number;
  configuredProfitPercentage: number;
  isCreditSale?: boolean;
  createdAt: string;
  // Multi-company fields (only present in all-companies view)
  companyId?: number;
  companyCode?: string;
  companyName?: string;
}

export interface DailySummary {
  date: string; // compound key used for grouping (may have "-credit" suffix)
  dateKey: string; // clean date key for API queries (no suffix)
  displayDate: string;
  totalSales: number;
  totalCost: number;
  totalConfiguredCost: number;
  costProfit: number;
  configuredProfit: number;
  itemCount: number;
  totalQty: number;
  isCreditSale: boolean;
  hasMixedSales: boolean; // true when credit + normal are merged together
  items: SalesReportItem[];
}

export type GroupingType = "daily" | "monthly" | "yearly";

export type ProfitFilter = "all" | "positive" | "negative";

// Format number with commas, remove .00 if whole - handles string inputs

export interface SalesCogsReconciliation {
  openingStock: number;
  stockReceived: number;
  noteInventoryNet: number;
  stockAdjustmentNet: number;
  closingStock: number;
  totalSales: number;
  storedCogs: number;
  reconciledCogs: number;
  reconciliation: number;
  storedCostProfit: number;
  adjustedCostProfit: number;
  formula: string;
}
