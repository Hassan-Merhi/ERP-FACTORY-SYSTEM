export const PHASE9_LAN_ITEM_ID_BASE: 1000000000;
export const PHASE9_STOCK_ITEM_CREATE_KIND: "stock.item-create.v1";
export const PHASE9_STOCK_ITEM_DELETE_KIND: "stock.item-delete.v1";
export const PHASE9_STOCK_ITEM_NAME_EXISTS_CONFLICT: "PHASE9_STOCK_ITEM_NAME_EXISTS";
export class Phase9StockItemLifecycleRefusal extends Error {
  constructor(code: string);
}
interface Phase9Actor {
  companyId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  businessDate: string;
}
export interface Phase9StockItemFields {
  code: string;
  name: string;
  uom: string;
  stockGroupId: number;
  categoryId: number | null;
  gradeId: number | null;
  sellingPrice: string | null;
  openingQty: string | null;
  openingRate: string | null;
  openingValue: string | null;
  reorderLevel: string | null;
  active: boolean;
}
export interface Phase9StockItemCreateEvidence extends Phase9Actor {
  localStockItemId: number;
  item: Phase9StockItemFields;
}
export interface Phase9StockItemDeleteEvidence extends Phase9Actor {
  stockItemId: number;
  code: string;
}
export function phase9StockItemCreateEnvelope(
  evidence: Phase9StockItemCreateEvidence
): Phase9StockItemCreateEvidence & { kind: "stock.item-create.v1" };
export function phase9StockItemDeleteEnvelope(
  evidence: Phase9StockItemDeleteEvidence
): Phase9StockItemDeleteEvidence & { kind: "stock.item-delete.v1" };
