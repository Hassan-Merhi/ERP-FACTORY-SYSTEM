// Renamed from `Location` to avoid colliding with the DOM global `Location` type
// and with the several structurally-similar-but-not-identical local `Location`
// interfaces previously duplicated across this feature's files (TS Cleanup Phase B).
import type { PeriodFilterValue } from "@/components/ui/period-filter";

export interface InventoryLocation {
  id: number;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  createdAt?: string;
  supplierPartnerPayableDeductionPerQty?: string | null;
  whatsappGroupChatId?: string | null;
  whatsappGroupName?: string | null;
  whatsappStockReportsEnabled?: boolean;
}

/** @deprecated use `InventoryLocation` */
export type Location = InventoryLocation;

export interface InventoryItem {
  inventoryId: number | null;
  locationId: number;
  locationName?: string | null;
  stockItemId: number;
  quantity: string;
  averageRate: string | null;
  totalValue: string | null;
  stockItemCode: string;
  stockItemName: string;
  stockItemUom: string;
  stockGroupId: number | null;
  stockGroupName: string | null;
  stockGroupCode: string | null;
  stockItemActive: boolean | null;
  categoryId?: number | null;
  categoryName?: string | null;
}

/** Row returned by GET /api/inventory/negative (admin repair route). */
export interface NegativeInventoryRow {
  id: number;
  locationId: number;
  locationName: string;
  stockItemId: number;
  code: string;
  name: string;
  quantity: string;
}

export interface StockGroupSummary {
  groupId: number | null;
  groupCode: string | null;
  groupName: string;
  totalQuantity: number;
  totalValue: number;
  averageRate: number;
  itemCount: number;
  items: InventoryItem[];
}

export interface CombinedStockRow {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  stockGroupId: number | null;
  stockGroupName: string;
  categoryId: number | null;
  categoryName: string | null;
  qtyByLocationName: Record<string, number>;
  totalQty: number;
  weightedCostSum: number;
  totalValue: number;
  avgCost: number;
}

export interface InventoryLocationOption {
  id: number;
  name: string;
}

export interface InventoryGroupOption {
  id: number | null;
  name: string;
}

export interface StockMovementItem {
  stockItemId: number;
  locationId: number | null;
  stockItemName: string;
  locationName?: string | null;
}

export interface StockMovementMonth {
  year: number;
  month: number;
  monthName: string;
}

export type StockMovementPeriod = PeriodFilterValue;

/** Month row from GET /api/inventory/movement (server inventory-movement/movement.ts). */
export interface StockMovementMonthlySummary {
  year: number;
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

/** Response of GET /api/inventory/movement. */
export interface StockMovementResponse {
  months: StockMovementMonthlySummary[];
  grandTotal: {
    inwardQty: number;
    inwardValue: number;
    outwardQty: number;
    outwardValue: number;
    closingQty: number;
    closingValue: number;
  };
}

/** Transaction row from GET /api/inventory/movement/drill (StockMovementTx + running close). */
export interface StockMovementDrillTx {
  date: string;
  particulars: string;
  vchType: string;
  voucherId: number | null;
  poId: number | null;
  inwardQty: number;
  inwardRate: number;
  inwardValue: number;
  outwardQty: number;
  outwardRate: number;
  outwardValue: number;
  isPOS: boolean;
  posSellingRate: number;
  posSellingValue: number;
  closingQty: number;
  closingRate: number;
  closingValue: number;
  isOpeningBalance: boolean;
}

/** Response of GET /api/inventory/movement/drill. */
export interface StockMovementDrillResponse {
  transactions: StockMovementDrillTx[];
  totals: {
    inwardQty: number;
    inwardRate: number;
    inwardValue: number;
    outwardQty: number;
    outwardRate: number;
    outwardValue: number;
  };
}

export interface WhatsappGroup {
  id: string;
  name: string;
  type: string;
}

export interface RenameLocationVariables {
  id: number;
  name: string;
  supplierPartnerPayableDeductionPerQty?: number;
}

export interface WhatsappGroupVariables {
  id: number;
  whatsappGroupChatId: string | null;
  enabled: boolean;
}

export interface WhatsappTestVariables {
  id: number;
  whatsappGroupChatId: string | null;
}

export interface PendingMutation<TVariables> {
  mutate: (variables: TVariables) => void;
  isPending: boolean;
}
