// Extracted from ./stockInSalesDetailServiceLoadStockIn.ts
import type { StockInSalesReportMetrics } from "./stockInSalesReportService";

export interface StockInSalesDetailFilters {
  companyId: number;
  startDate: string;
  endDate: string;
  locationIds: number[];
  stockGroupIds: number[];
  search?: string;
  stockInPage: number;
  stockOutPage: number;
  limit: number;
  exportAll?: boolean;
}

export interface StockInDetailRow {
  id: number;
  activityDate: string;
  containerId: number;
  containerNumber: string;
  offloadId: number;
  locationId: number;
  locationName: string;
  stockGroupId: number | null;
  stockGroupName: string;
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  quantity: number;
  avgRate: number;
  totalValue: number;
}

export interface StockOutDetailRow {
  id: number;
  sourceType: "Sale" | "Credit Note" | "Debit Note";
  activityDate: string;
  voucherId: number;
  voucherNumber: string;
  isCreditSale: boolean | null;
  locationId: number | null;
  locationName: string;
  stockGroupId: number | null;
  stockGroupName: string;
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  quantity: number;
  sellingRate: number;
  unitCost: number;
  totalSales: number;
  totalCost: number;
  costProfit: number;
  avgProfitPerBale: number;
}

export interface StockAdjustmentDetailRow {
  id: number;
  activityDate: string;
  voucherId: number;
  voucherNumber: string;
  locationId: number;
  locationName: string;
  adjustmentType: string;
  direction: "In" | "Out";
  stockGroupId: number | null;
  stockGroupName: string;
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  quantity: number;
  unitRate: number;
  totalValue: number;
}

export interface PaginationResult<T> {
  rows: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  truncated: boolean;
}

export interface StockInSalesDetailResult {
  generatedAt: string;
  period: { startDate: string; endDate: string };
  filters: Omit<StockInSalesDetailFilters, "companyId" | "stockInPage" | "stockOutPage" | "limit" | "exportAll">;
  summary: StockInSalesReportMetrics;
  stockIn: PaginationResult<StockInDetailRow>;
  stockOut: PaginationResult<StockOutDetailRow>;
  adjustments: PaginationResult<StockAdjustmentDetailRow>;
}
