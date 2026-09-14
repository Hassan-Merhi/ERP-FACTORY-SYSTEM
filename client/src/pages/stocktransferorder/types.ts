/**
 * Types for the StockTransferOrder page.
 *
 * Extracted from StockTransferOrder.tsx during the Phase 4 god-file split.
 */

export interface LocationData {
  quantity: number;
  rate: number;
  value: number;
}

export interface StockItemData {
  id: number;
  code: string;
  name: string;
  uom: string;
  locationData: Record<number, LocationData>;
}

export interface StockGroupData {
  id: number;
  code: string;
  name: string;
  locationData: Record<number, LocationData>;
  items: StockItemData[];
}

export interface LocationSummaryResponse {
  stockGroups: StockGroupData[];
  grandTotals: Record<number, LocationData>;
  asOfDate: string;
}

export interface Location {
  id: number;
  name: string;
  code: string;
}

export interface OrderItem {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  uom: string;
  sourceLocationId: number;
  sourceLocationName: string;
  quantity: number;
  availableQty: number;
  rate: number;
}

export interface QuantityPickerState {
  open: boolean;
  stockItem: StockItemData | null;
  locationId: number;
  locationName: string;
  availableQty: number;
}

export interface ImportPreviewRow {
  rawCode: string;
  rawName: string;
  stockItemId: number | null;
  stockItemName: string;
  currentQty: number;
  change: number;
  newQty: number;
  sourceLocationId: number | null;
  sourceLocationName: string;
  status: "ok" | "not_found" | "remove" | "new_item";
}

export interface StockItemOption {
  id: number;
  name: string;
  code: string;
  uom: string;
}

export interface ExistingStockTransferItem {
  stockItemId: number;
  sourceLocationId?: number | null;
  quantity: string | number;
  rate?: string | number | null;
}

export interface ExistingStockTransfer {
  id: number;
  destinationLocationId?: number | null;
  items?: ExistingStockTransferItem[];
}

export interface ExistingVoucherHeader {
  optional?: boolean;
  voucherDate?: string | null;
}

export interface StockTransferRevisionItem {
  stockItemName: string;
  sourceLocationName?: string | null;
  originalQuantity: string | number;
  delta: string | number;
  newQuantity: string | number;
}

export interface StockTransferRevision {
  id: number;
  revisionNumber: number;
  optional: boolean;
  revisionDate?: string | null;
  note?: string | null;
  items?: StockTransferRevisionItem[];
}

export interface MonthlyStockMovement {
  month: number;
  monthName: string;
  openingQty: number;
  openingRate: number;
  openingValue: number;
  inwardQty: number;
  inwardRate: number;
  inwardValue: number;
  outwardQty: number;
  outwardRate: number;
  outwardValue: number;
  closingQty: number;
  closingRate: number;
  closingValue: number;
}

export type StockMovementTotals = Omit<MonthlyStockMovement, "month" | "monthName">;

export interface StockMovementSummaryData {
  monthlyData?: MonthlyStockMovement[];
  grandTotal?: StockMovementTotals;
}

export interface StockMovementTransaction {
  type: string;
  date: string;
  reference: string;
  qty: number;
  rate: number;
  value: number;
  sellingRate?: number;
  sellingValue?: number;
}

export interface StockMovementDetailData {
  inTransactions?: StockMovementTransaction[];
  outTransactions?: StockMovementTransaction[];
}
