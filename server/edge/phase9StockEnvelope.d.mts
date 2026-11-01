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
