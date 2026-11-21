// Extracted from ./OpeningStockDetail.tsx

interface StockItemData {
  id: number;
  code: string;
  name: string;
  uom: string;
  opening: {
    quantity: number;
    rate: number;
    value: number;
  };
  closing: {
    quantity: number;
    rate: number;
    value: number;
  };
}

export interface StockGroupItemsData {
  items: StockItemData[];
  grandTotal: {
    opening: { quantity: number; value: number };
    closing: { quantity: number; value: number };
  };
  stockGroup: {
    id: number;
    code: string;
    name: string;
  } | null;
}

interface InventoryRecord {
  id: number;
  locationId: number;
  locationName: string | null;
  locationDeleted: boolean;
  locationStatus: string;
  quantity: number;
  averageRate: number;
  totalValue: number;
  lastUpdated: string;
}

export interface DebugData {
  stockItem: {
    id: number;
    code: string;
    name: string;
    stockGroupId: number | null;
    openingQty: string;
    openingRate: string;
    openingValue: string;
  };
  inventoryRecords: InventoryRecord[];
  totals: {
    recordCount: number;
    totalQuantity: number;
    activeRecordCount: number;
    activeQuantity: number;
    activeValue: number;
    totalValue: number;
    calculatedRate: number;
  };
}

export function formatNumber(value: number, decimals: number = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatQty(value: number, uom: string = "BL"): string {
  if (value === 0) return "";
  return `${formatNumber(value)} ${uom}`;
}
