// Extracted from ./immutableStockTransferRevisionLifecycle.ts to keep that module under the source-size cap.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { locations, stockItems, stockTransferItems, stockTransferRevisionItems } from "@shared/schema";
import type {
  ImmutableRevisionItemInput,
  LifecycleError,
  LockedTransferRow,
  NormalizedImmutableRevisionItem,
} from "./immutableStockTransferRevisionInput";
import { firstRow, lifecycleError, type StockTransferRevisionStatus } from "./immutableStockTransferRevisionQueries";

export interface CreateImmutableRevisionInput {
  companyId: number;
  transferId: number;
  userId: string;
  note?: string | null;
  pending: boolean;
  sourceLocationIdLimit?: number | null;
  items: ImmutableRevisionItemInput[];
}

export interface ImmutableRevisionResult {
  revisionId: number;
  transferId: number;
  revisionNumber: number;
  status: StockTransferRevisionStatus;
  optional: boolean;
  itemCount: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  sourceLocationName: string;
  destinationLocationId: number;
  destinationLocationName: string;
  items: Array<typeof stockTransferRevisionItems.$inferSelect>;
}

export interface RevisionAuditItem {
  stockItemId: number;
  stockItemName: string;
  sourceLocationId: number;
  sourceLocationName: string | null;
  originalQuantity: number;
  newQuantity: number;
  delta: number;
  rate?: number;
}

export interface ReviewImmutableRevisionResult {
  revisionId: number;
  transferId: number;
  voucherId: number;
  revisionNumber: number;
  transition: "approved" | "rejected" | "no-op";
  changedItemCount: number;
  /** Pending revisions folded into this approval, including the requested one. */
  appliedRevisionCount?: number;
  inventoryApplied: boolean;
  totalAmount: string;
  /** Bounded business snapshot used by the audit trail/detail dialog. */
  items: RevisionAuditItem[];
}

export function toRevisionAuditItems(
  items: Array<typeof stockTransferRevisionItems.$inferSelect>,
  rates?: Map<string, number>
): RevisionAuditItem[] {
  return items.map((item) => {
    const key = `${item.stockItemId}:${item.sourceLocationId ?? ""}`;
    return {
      stockItemId: Number(item.stockItemId),
      stockItemName: String(item.stockItemName || `Item #${item.stockItemId}`),
      sourceLocationId: Number(item.sourceLocationId || 0),
      sourceLocationName: item.sourceLocationName ? String(item.sourceLocationName) : null,
      originalQuantity: Number(item.originalQuantity || 0),
      newQuantity: Number(item.newQuantity || 0),
      delta: Number(item.delta || 0),
      ...(rates?.has(key) ? { rate: rates.get(key)! } : {}),
    };
  });
}

export async function lockTransfer(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], transferId: number) {
  return firstRow<LockedTransferRow>(
    await tx.execute(sql`
      SELECT
        stv.id,
        stv.voucher_id,
        stv.source_location_id,
        stv.destination_location_id,
        stv.inventory_applied,
        v.company_id,
        v.voucher_type,
        v.voucher_number,
        v.voucher_date,
        v.deleted_at,
        src.name AS source_location_name,
        dst.name AS destination_location_name
      FROM stock_transfer_vouchers stv
      JOIN vouchers v ON v.id = stv.voucher_id
      LEFT JOIN locations src ON src.id = stv.source_location_id
      JOIN locations dst ON dst.id = stv.destination_location_id
      WHERE stv.id = ${transferId}
      FOR UPDATE OF stv, v
    `)
  );
}

export function assertTransfer(transfer: LockedTransferRow | undefined, companyId: number): asserts transfer {
  if (!transfer) throw new Error("Stock transfer not found");
  if (Number(transfer.company_id) !== companyId) {
    throw lifecycleError("Stock transfer belongs to a different company", "STOCK_TRANSFER_REVISION_SCOPE");
  }
  if (!["Stock Transfer", "StockTransfer", "Transfer"].includes(String(transfer.voucher_type))) {
    throw new Error("Voucher is not a stock transfer");
  }
  if (transfer.deleted_at) throw new Error("Deleted stock transfers cannot be revised");
}

export async function assertCompanyScope(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: number,
  destinationLocationId: number,
  items: Array<{ sourceLocationId: number; stockItemId: number }>
) {
  const locationIds = Array.from(new Set([destinationLocationId, ...items.map((item) => item.sourceLocationId)]));
  const validLocations = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, locationIds), isNull(locations.deletedAt)));
  if (validLocations.length !== locationIds.length) {
    throw lifecycleError(
      "One or more revision locations do not belong to the current company",
      "STOCK_TRANSFER_REVISION_SCOPE"
    );
  }

  const itemIds = Array.from(new Set(items.map((item) => item.stockItemId)));
  const validItems = await tx
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(
      and(
        eq(stockItems.companyId, companyId),
        inArray(stockItems.id, itemIds),
        eq(stockItems.active, true),
        isNull(stockItems.deletedAt)
      )
    );
  if (validItems.length !== itemIds.length) {
    throw lifecycleError(
      "One or more revision stock items do not belong to the current company or are inactive",
      "STOCK_TRANSFER_REVISION_SCOPE"
    );
  }
}

export async function assertSubmittedBaseline(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  transferId: number,
  items: NormalizedImmutableRevisionItem[]
) {
  const current = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
  for (const item of items) {
    const row = current.find(
      (candidate: typeof stockTransferItems.$inferSelect) =>
        candidate.stockItemId === item.stockItemId && candidate.sourceLocationId === item.sourceLocationId
    );
    const currentQuantity = Number(row?.quantity ?? 0);
    if (Math.abs(currentQuantity - item.originalQuantity) > 0.001) {
      const error: LifecycleError = lifecycleError(
        `Revision is stale for item ${item.stockItemId} at source ${item.sourceLocationId}. Expected ${item.originalQuantity}, current transfer quantity is ${currentQuantity}.`,
        "STOCK_TRANSFER_REVISION_STALE"
      );
      error.stockItemId = item.stockItemId;
      error.sourceLocationId = item.sourceLocationId;
      throw error;
    }
  }
}
