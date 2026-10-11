export interface Location {
  id: number;
  name: string;
  code: string;
}

export interface StockMeta {
  id: number;
  name: string;
  active?: boolean;
}

export interface StockItemLight {
  id: number;
  name: string;
  code: string;
  uom: string;
}

export interface LocationData {
  quantity: number;
  rate: number;
  value: number;
}

export interface LocationSummaryItem {
  id: number;
  code: string;
  name: string;
  uom: string;
  locationData: Record<number, LocationData>;
}

export interface LocationSummaryGroup {
  id: number;
  name: string;
  items: LocationSummaryItem[];
}

export interface LocationSummaryResponse {
  stockGroups: LocationSummaryGroup[];
}

export type PerformanceClassification =
  "strong_seller" | "good_seller" | "normal_seller" | "slow_seller" | "overstocked" | "no_recent_sales";

export interface SmartPreviewLine {
  clientId: string;
  manual?: boolean;
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  uom: string;
  stockGroupId: number | null;
  categoryId: number | null;
  sourceLocationId: number;
  sourceLocationName: string;
  availableAtSource: number;
  sourceCurrentStock: number;
  sourceReserveQty: number;
  sourceAverageRate: number;
  destinationStock: number;
  otwQty: number;
  effectiveDestinationStock: number;
  olderTransferQty: number;
  newerTransferQty: number;
  salesAfterOlderTransfer: number;
  salesAfterNewerTransfer: number;
  totalSalesSinceOlderTransfer: number;
  olderSellThroughPercentage: number;
  newerSellThroughPercentage: number;
  overallSellThroughPercentage: number;
  averageSalesPerDay: number;
  latestSalesPerDay: number;
  estimatedDaysOfStockRemaining: number | null;
  classification: PerformanceClassification;
  classificationLabel: string;
  suggestedQuantity: number;
  itemSuggestedTotal: number;
  calculatedNeed: number;
  confidence: number;
  reason: string;
}

export interface SmartPreviewResponse {
  readOnly: true;
  destinationLocationId: number;
  destinationLocationName: string;
  sourceLocationIds: number[];
  sourceLocationNames: string[];
  targetQuantity: number;
  achievedQuantity: number;
  shortfallQuantity: number;
  shortfall: boolean;
  lines: Omit<SmartPreviewLine, "clientId" | "manual">[];
  warnings: string[];
  excludedItems: Array<{
    stockItemId: number;
    stockItemName: string;
    reason: string;
  }>;
  history: {
    newerTransfer: { voucherNumber: string; voucherDate: string } | null;
    olderTransfer: { voucherNumber: string; voucherDate: string } | null;
  };
}
