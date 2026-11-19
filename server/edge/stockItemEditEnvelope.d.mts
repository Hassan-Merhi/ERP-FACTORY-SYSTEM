export const PHASE9_STOCK_ITEM_EDIT_KIND: "stock.item-edit.v1";
export const PHASE9_STOCK_ITEM_CHANGED_CONFLICT: "PHASE9_STOCK_ITEM_CHANGED";
export type Phase9StockItemEditTarget = "item" | "location-price" | "alias";
export type Phase9StockItemValueType = "text" | "decimal" | "ref" | "boolean";
export const PHASE9_STOCK_ITEM_EDIT_FIELDS: Readonly<
  Record<Phase9StockItemEditTarget, Readonly<Record<string, Phase9StockItemValueType>>>
>;
export const PHASE9_STOCK_ITEM_EDIT_ROUTES: readonly string[];
export class Phase9StockItemEditRefusal extends Error {
  constructor(code: string);
}
export function validPhase9StockItemValue(type: Phase9StockItemValueType, value: unknown, nullable: boolean): boolean;
export interface Phase9StockItemChange {
  target: Phase9StockItemEditTarget;
  stockItemId: number;
  code: string;
  locationId?: number;
  field: string;
  before: string | null;
  after: string | null;
}
export interface Phase9StockItemEditEvidence {
  companyId: number;
  localEditId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  businessDate: string;
  route: string;
  changes: Phase9StockItemChange[];
}
export function phase9StockItemEditEnvelope(
  evidence: Phase9StockItemEditEvidence
): Phase9StockItemEditEvidence & { kind: "stock.item-edit.v1" };
