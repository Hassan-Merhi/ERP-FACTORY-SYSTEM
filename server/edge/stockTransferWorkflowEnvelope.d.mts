export const PHASE9_STOCK_TRANSFER_EDIT_KIND: "stock.transfer-edit.v1";
export const PHASE9_STOCK_TRANSFER_FINALIZE_KIND: "stock.transfer-finalize.v1";
export const PHASE9_STOCK_TRANSFER_REVISION_KIND: "stock.transfer-revision.v1";
export const PHASE9_STOCK_TRANSFER_REVISION_REVIEW_KIND: "stock.transfer-revision-review.v1";
export const PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT: "PHASE9_STOCK_TRANSFER_CHANGED";
export class Phase9StockTransferWorkflowRefusal extends Error {
  constructor(code: string);
}
interface Phase9Actor {
  companyId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  businessDate: string;
}
export type Phase9TransferRef = { origin: "lan"; localTransferId: number } | { origin: "cloud"; transferId: number };
export type Phase9RevisionRef = { origin: "lan"; localRevisionId: number } | { origin: "cloud"; revisionId: number };
export interface Phase9TransferSnapshot {
  destinationLocationId: number;
  optional: boolean;
  inventoryApplied: boolean;
  lines: Array<{ sourceLocationId: number; stockItemId: number; quantity: string }>;
}
export interface Phase9TransferEditTarget {
  destinationLocationId: number;
  notes: string;
  items: Array<{ stockItemId: number; sourceLocationId: number; quantity: number; rate: number }>;
}
export interface Phase9TransferRevisionBody {
  note: string | null;
  pending: boolean;
  sourceLocationIdLimit: number | null;
  items: Array<{
    stockItemId: number;
    stockItemName: string;
    sourceLocationId: number;
    sourceLocationName: string | null;
    originalQuantity: number;
    newQuantity: number;
  }>;
}
export interface Phase9StockTransferEditEvidence extends Phase9Actor {
  localEditId: number;
  transfer: Phase9TransferRef;
  before: Phase9TransferSnapshot;
  after: Phase9TransferEditTarget;
}
export interface Phase9StockTransferFinalizeEvidence extends Phase9Actor {
  localEditId: number;
  transfer: Phase9TransferRef;
  before: Phase9TransferSnapshot;
}
export interface Phase9StockTransferRevisionEvidence extends Phase9Actor {
  localRevisionId: number;
  transfer: Phase9TransferRef;
  revision: Phase9TransferRevisionBody;
}
export interface Phase9StockTransferRevisionReviewEvidence extends Phase9Actor {
  localEditId: number;
  revision: Phase9RevisionRef;
  decision: "approve" | "reject";
  reason: string | null;
}
export function phase9TransferSnapshot(
  header: { destinationLocationId: unknown; optional: unknown; inventoryApplied: unknown },
  rows: ReadonlyArray<{ sourceLocationId: unknown; stockItemId: unknown; quantity: unknown }>
): Phase9TransferSnapshot;
export function phase9StockTransferEditEnvelope(
  evidence: Phase9StockTransferEditEvidence
): Phase9StockTransferEditEvidence & { kind: "stock.transfer-edit.v1" };
export function phase9StockTransferFinalizeEnvelope(
  evidence: Phase9StockTransferFinalizeEvidence
): Phase9StockTransferFinalizeEvidence & { kind: "stock.transfer-finalize.v1" };
export function phase9StockTransferRevisionEnvelope(
  evidence: Phase9StockTransferRevisionEvidence
): Phase9StockTransferRevisionEvidence & { kind: "stock.transfer-revision.v1" };
export function phase9StockTransferRevisionReviewEnvelope(
  evidence: Phase9StockTransferRevisionReviewEvidence
): Phase9StockTransferRevisionReviewEvidence & { kind: "stock.transfer-revision-review.v1" };
