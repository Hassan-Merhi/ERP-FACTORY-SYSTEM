export const PHASE9_STOCK_ADJUST_KIND: "stock.quick-adjust.v1";
export const PHASE9_STOCK_NEGATIVE_CONFLICT: "PHASE9_STOCK_WOULD_GO_NEGATIVE";
export class Phase9StockRefusal extends Error {
  constructor(code: string);
}
export interface Phase9StockAdjustEvidence {
  companyId: number;
  localMovementId: number;
  stockItemId: number;
  locationId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  direction: "add" | "subtract";
  quantity: string;
  occurredAt: string;
  businessDate: string;
}
export interface Phase9StockAdjustEnvelope extends Phase9StockAdjustEvidence {
  kind: "stock.quick-adjust.v1";
}
export function phase9StockAdjustEnvelope(evidence: Phase9StockAdjustEvidence): Phase9StockAdjustEnvelope;
export const PHASE9_STOCK_TRANSFER_KIND: "stock.transfer.v1";
export interface Phase9StockTransferEvidence {
  companyId: number;
  localTransferId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  businessDate: string;
  sourceLocationId: number | null;
  destinationLocationId: number;
  notes: string | null;
  optional: boolean;
  allowNegativeInventory: boolean;
  items: Array<{ sourceLocationId: number; stockItemId: number; quantity: string; rate: string }>;
}
export function phase9StockTransferEnvelope(
  evidence: Phase9StockTransferEvidence
): Phase9StockTransferEvidence & { kind: "stock.transfer.v1" };
