/**
 * Types for the PosTransferOrders page.
 *
 * Extracted from PosTransferOrders.tsx during the Phase 4 god-file split.
 */

export interface PosUser {
  id: string | number;
  assignedLocationId?: number | null;
}

export interface PosTransferOrdersProps {
  posUser: PosUser;
}

export interface TransferSummary {
  transferId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  sourceLocationId?: number;
  sourceLocationName: string;
  destinationLocationId: number;
  destinationLocationName: string;
  itemCount: number;
  totalAmount: number;
  stockItemNames: string[];
  inventoryApplied: boolean;
}

export interface TransferDetailItem {
  id: number;
  transferId: number;
  stockItemId: number;
  stockItemName: string;
  sourceLocationId?: number;
  sourceLocationName?: string;
  quantity: string;
}

export interface RevisionItem {
  stockItemId: number;
  stockItemName: string;
  sourceLocationName?: string | null;
  originalQuantity: string;
  delta: string;
  newQuantity: string;
}

export type RevisionStatus = "pending" | "approved" | "rejected" | "cancelled" | "superseded";

export interface Revision {
  id: number;
  revisionNumber: number;
  note?: string;
  optional: boolean;
  status: RevisionStatus;
  createdBy?: string | number | null;
  createdAt: string;
  revisionDate?: string;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  rejectionReason?: string | null;
  supersededByRevisionId?: number | null;
  sourceLocationName?: string | null;
  destinationLocationName?: string | null;
  items: RevisionItem[];
}

export interface TransferDetail {
  transferId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  optional: boolean;
  inventoryApplied: boolean;
  sourceLocationId?: number;
  sourceLocationName: string;
  destinationLocationId: number;
  destinationLocationName: string;
  notes?: string;
  items: TransferDetailItem[];
  revisions: Revision[];
}

export interface InventoryItem {
  id?: number;
  stockItemId?: number;
  name?: string;
  stockItemName?: string;
  locationId?: number;
  quantity?: string | number;
}

export interface ExtraItem {
  stockItemId: number;
  stockItemName: string;
  qtyDraft: string;
}

export // ─── Create Transfer Dialog (multi-location POS users) ───────────────────────
interface NewTransferItem {
  stockItemId: number;
  stockItemName: string;
  quantity: string;
}
