// Extracted from ./StockInSalesReportDetail.tsx to keep that module under the source-size cap.

export interface Metrics {
  openingStockQty: number;
  openingStockValue: number;
  stockInQty: number;
  stockInValue: number;
  stockInAvgRate: number;
  stockAdjustmentQty: number;
  stockAdjustmentValue: number;
  totalAvailableQty: number;
  stockOutQty: number;
  stockOutValue: number;
  closingStockQty: number;
  closingStockValue: number;
  totalSales: number;
  costOfSales: number;
  costProfit: number;
  avgProfitPerBale: number;
}

export interface StockInRow {
  id: number;
  activityDate: string;
  containerNumber: string;
  locationName: string;
  stockItemId?: number;
  stockItemName: string;
  quantity: number;
  avgRate: number;
  totalValue: number;
}
