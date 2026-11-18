// Extracted from ./useStockItemDetailState.tsx

export type DatePreset =
  "all" | "today" | "yesterday" | "this-month" | "last-1-month" | "last-6-months" | "this-year" | "custom";

export interface StockItem {
  id: number;
  code: string;
  name: string;
  uom: string;
  stockGroupId: number | null;
  active: boolean;
}

interface Purchase {
  poNumber: string;
  poDate: string;
  supplierName: string;
  containerNumber: string | null;
  quantity: string;
  rate: string;
  amount: string;
}

export interface Sale {
  voucherNumber: string;
  saleDate: string;
  locationName: string | null;
  quantity: string;
  sellingPrice: string;
  totalSales: string;
  voucherId?: number;
  posStation?: number | null;
}

export interface InventoryLocation {
  locationId: number;
  locationName: string;
  locationCode: string;
  quantity: string;
  averageRate: string;
  totalValue: string;
}

export interface StockItemDetails {
  purchases: Purchase[];
  sales: Sale[];
  inventoryLocations: InventoryLocation[];
}
