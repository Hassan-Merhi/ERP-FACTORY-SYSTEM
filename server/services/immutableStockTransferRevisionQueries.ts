/**
 * Read side of the immutable stock-transfer revision lifecycle, plus the small
 * row and validation helpers the lifecycle's write paths share. Split out of
 * immutableStockTransferRevisionLifecycle.ts, which re-exports the public reads.
 */
import { inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { stockTransferRevisionItems } from "@shared/schema";
import type { LifecycleError } from "./immutableStockTransferRevisionInput";
import { resultRows } from "../lib/queryResult";

export type StockTransferRevisionStatus = "pending" | "approved" | "rejected" | "cancelled" | "superseded";

export function rows<T extends Record<string, unknown> = Record<string, unknown>>(result: unknown): T[] {
  return resultRows<T>(result);
}

export function firstRow<T extends Record<string, unknown> = Record<string, unknown>>(result: unknown): T | undefined {
  return rows<T>(result)[0];
}

export function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function lifecycleError(message: string, code: string): LifecycleError {
  const error: LifecycleError = new Error(message);
  error.code = code;
  return error;
}

export async function resolveTransferIdByVoucher(
  companyIdInput: number,
  voucherIdInput: number
): Promise<number | null> {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const voucherId = positiveInteger(voucherIdInput, "Voucher ID");
  const row = firstRow(
    await db.execute(sql`
      SELECT transfer.id
      FROM stock_transfer_vouchers transfer
      JOIN vouchers voucher ON voucher.id = transfer.voucher_id
      WHERE transfer.voucher_id = ${voucherId}
        AND voucher.company_id = ${companyId}
        AND voucher.deleted_at IS NULL
      LIMIT 1
    `)
  );
  return row ? Number(row.id) : null;
}

export async function listImmutableStockTransferRevisions(companyIdInput: number, transferIdInput: number) {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const transferId = positiveInteger(transferIdInput, "Transfer ID");
  const revisionRows = rows(
    await db.execute(sql`
      SELECT
        revision.id,
        revision.transfer_id,
        revision.revision_number,
        revision.note,
        revision.optional,
        revision.revision_date,
        revision.created_by,
        revision.status,
        revision.reviewed_at,
        revision.reviewed_by,
        revision.rejection_reason,
        revision.superseded_by_revision_id,
        transfer.source_location_id,
        source.name AS source_location_name,
        transfer.destination_location_id,
        destination.name AS destination_location_name
      FROM stock_transfer_revisions revision
      JOIN stock_transfer_vouchers transfer ON transfer.id = revision.transfer_id
      JOIN vouchers voucher ON voucher.id = transfer.voucher_id
      LEFT JOIN locations source ON source.id = transfer.source_location_id
      JOIN locations destination ON destination.id = transfer.destination_location_id
      WHERE revision.transfer_id = ${transferId}
        AND voucher.company_id = ${companyId}
        AND voucher.deleted_at IS NULL
      ORDER BY revision.revision_number DESC, revision.id DESC
    `)
  );
  if (revisionRows.length === 0) return [];

  const revisionIds = revisionRows.map((revision) => Number(revision.id));
  const itemRows = await db
    .select()
    .from(stockTransferRevisionItems)
    .where(inArray(stockTransferRevisionItems.revisionId, revisionIds));
  const byRevision = new Map<number, typeof itemRows>();
  for (const item of itemRows) {
    const group = byRevision.get(item.revisionId) || [];
    group.push(item);
    byRevision.set(item.revisionId, group);
  }

  return revisionRows.map((revision) => {
    const items = byRevision.get(Number(revision.id)) || [];
    const sourceNames = Array.from(
      new Set(items.map((item) => item.sourceLocationName).filter((name): name is string => Boolean(name)))
    );
    return {
      id: Number(revision.id),
      transferId: Number(revision.transfer_id),
      revisionNumber: Number(revision.revision_number),
      note: revision.note,
      optional: revision.status === "pending",
      status: revision.status as StockTransferRevisionStatus,
      revisionDate: revision.revision_date,
      createdAt: revision.revision_date,
      createdBy: revision.created_by,
      reviewedAt: revision.reviewed_at,
      reviewedBy: revision.reviewed_by,
      rejectionReason: revision.rejection_reason,
      supersededByRevisionId: revision.superseded_by_revision_id ? Number(revision.superseded_by_revision_id) : null,
      sourceLocationId: revision.source_location_id ? Number(revision.source_location_id) : null,
      sourceLocationName:
        sourceNames.length === 1
          ? sourceNames[0]
          : sourceNames.length > 1
            ? "Multiple Sources"
            : revision.source_location_name || "Unknown",
      destinationLocationId: Number(revision.destination_location_id),
      destinationLocationName: revision.destination_location_name || "Unknown",
      items,
    };
  });
}
