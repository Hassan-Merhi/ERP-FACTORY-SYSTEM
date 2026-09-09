// Renamed from `Location` to avoid colliding with the DOM global `Location` type
// and with the several structurally-similar-but-not-identical local `Location`
// interfaces previously duplicated across this feature's files (TS Cleanup Phase B).
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
