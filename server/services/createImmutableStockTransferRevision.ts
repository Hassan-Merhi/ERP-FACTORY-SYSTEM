// Extracted from ./immutableStockTransferRevisionLifecycle.ts to keep that module under the source-size cap.
import { type AuditTxHook, finishWithAudit } from "../lib/auditTxHook";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { stockTransferRevisionItems, stockTransferRevisions } from "@shared/schema";
import { immutableRevisionPayloadHash, normalizeImmutableRevisionItems } from "./immutableStockTransferRevisionInput";
import {
  firstRow,
  lifecycleError,
  positiveInteger,
  rows,
  type StockTransferRevisionStatus,
} from "./immutableStockTransferRevisionQueries";
import { toMoney } from "../lib/money";
import {
  assertCompanyScope,
  assertSubmittedBaseline,
  assertTransfer,
  lockTransfer,
  type CreateImmutableRevisionInput,
  type ImmutableRevisionResult,
} from "./immutableStockTransferRevisionLifecycleAssertCompanyScope";

export async function createImmutableStockTransferRevision(
  input: CreateImmutableRevisionInput,
  auditTx?: AuditTxHook<ImmutableRevisionResult>,
  existingTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<ImmutableRevisionResult> {
  const companyId = positiveInteger(input.companyId, "Company ID");
  const transferId = positiveInteger(input.transferId, "Transfer ID");
  const userId = String(input.userId || "").trim();
  if (!userId) throw new Error("User ID is required");
  const note = input.note?.trim() || null;
  const normalized = normalizeImmutableRevisionItems(input.items);
  const hash = immutableRevisionPayloadHash(normalized, note);

  const run = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    const finish = finishWithAudit(tx, auditTx);
    const transfer = await lockTransfer(tx, transferId);
    assertTransfer(transfer, companyId);
    const destinationLocationId = positiveInteger(transfer.destination_location_id, "Destination location ID");

    for (const item of normalized) {
      if (item.sourceLocationId === destinationLocationId) {
        throw new Error("Revision source and destination locations must be different");
      }
      if (input.sourceLocationIdLimit && item.sourceLocationId !== input.sourceLocationIdLimit) {
        throw lifecycleError(
          "POS users may only revise items assigned to their own source location",
          "STOCK_TRANSFER_REVISION_SCOPE"
        );
      }
    }
    await assertCompanyScope(tx, companyId, destinationLocationId, normalized);
    await assertSubmittedBaseline(tx, transferId, normalized);

    const previousPending = input.pending
      ? rows(
          await tx.execute(sql`
            SELECT id, payload_hash
            FROM stock_transfer_revisions
            WHERE transfer_id = ${transferId}
              AND created_by = ${userId}
              AND status = 'pending'
            FOR UPDATE
          `)
        )
      : [];

    if (previousPending.some((revision) => revision.payload_hash === hash)) {
      throw lifecycleError("An identical pending revision already exists", "STOCK_TRANSFER_REVISION_DUPLICATE");
    }

    const previousIds = input.pending ? previousPending.map((revision) => Number(revision.id)) : [];
    if (previousIds.length > 0) {
      // Free the partial unique index before inserting the replacement pending
      // revision. The surrounding transaction restores these rows if the
      // replacement insert fails for any reason.
      await tx
        .update(stockTransferRevisions)
        .set({
          status: "superseded",
          optional: false,
          reviewedAt: new Date(),
          reviewedBy: userId,
        })
        .where(and(inArray(stockTransferRevisions.id, previousIds), eq(stockTransferRevisions.status, "pending")));
    }

    const maxRow = firstRow(
      await tx.execute(sql`
        SELECT COALESCE(MAX(revision_number), 0) AS max_revision
        FROM stock_transfer_revisions
        WHERE transfer_id = ${transferId}
      `)
    );
    const revisionNumber = Number(maxRow?.max_revision ?? 0) + 1;
    const status: StockTransferRevisionStatus = input.pending ? "pending" : "approved";

    const created = firstRow(
      await tx.execute(sql`
        INSERT INTO stock_transfer_revisions (
          transfer_id,
          revision_number,
          note,
          optional,
          revision_date,
          created_by,
          status,
          reviewed_at,
          reviewed_by,
          payload_hash
        ) VALUES (
          ${transferId},
          ${revisionNumber},
          ${note},
          ${input.pending},
          now(),
          ${userId},
          ${status},
          ${input.pending ? null : new Date()},
          ${input.pending ? null : userId},
          ${hash}
        )
        RETURNING id
      `)
    );
    const revisionId = positiveInteger(created?.id, "Revision ID");

    const savedItems = await tx
      .insert(stockTransferRevisionItems)
      .values(
        normalized.map((item) => ({
          revisionId,
          stockItemId: item.stockItemId,
          stockItemName: item.stockItemName,
          sourceLocationId: item.sourceLocationId,
          sourceLocationName: item.sourceLocationName,
          originalQuantity: toMoney(item.originalQuantity).toFixed(3),
          delta: toMoney(item.delta).toFixed(3),
          newQuantity: toMoney(item.newQuantity).toFixed(3),
        }))
      )
      .returning();

    if (previousIds.length > 0) {
      // The old rows were already superseded before the insert so the unique
      // pending-per-user index could admit the replacement. Link them to the
      // newly created revision now that its id is known.
      await tx
        .update(stockTransferRevisions)
        .set({ supersededByRevisionId: revisionId })
        .where(and(inArray(stockTransferRevisions.id, previousIds), eq(stockTransferRevisions.status, "superseded")));
    }

    const distinctSources = Array.from(
      new Set(savedItems.map((item) => item.sourceLocationName).filter((name): name is string => Boolean(name)))
    );
    return finish({
      revisionId,
      transferId,
      revisionNumber,
      status,
      optional: input.pending,
      itemCount: savedItems.length,
      voucherId: Number(transfer.voucher_id),
      voucherNumber: String(transfer.voucher_number),
      voucherDate: String(transfer.voucher_date),
      sourceLocationName:
        distinctSources.length === 1
          ? distinctSources[0]
          : distinctSources.length > 1
            ? "Multiple Sources"
            : String(transfer.source_location_name || "Unknown"),
      destinationLocationId,
      destinationLocationName: String(transfer.destination_location_name || "Unknown"),
      items: savedItems,
    });
  };
  return existingTx ? run(existingTx) : db.transaction(run);
}

/**
 * All pending revisions for a transfer, oldest first, locked for update.
 * Approval applies every one of them — a transfer fed by several POS locations
 * collects one pending revision per submitter, and approving only the clicked
 * row would silently discard the others.
 */
export async function lockedPendingRevisions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  transferId: number
) {
  return rows(
    await tx.execute(sql`
      SELECT id, revision_number
      FROM stock_transfer_revisions
      WHERE transfer_id = ${transferId}
        AND status = 'pending'
      ORDER BY revision_number ASC, id ASC
      FOR UPDATE
    `)
  ).map((revision) => ({ id: Number(revision.id), revisionNumber: Number(revision.revision_number) }));
}

export async function lockedRevision(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], revisionId: number) {
  return firstRow(
    await tx.execute(sql`
      SELECT
        revision.id AS revision_id,
        revision.transfer_id,
        revision.revision_number,
        revision.status,
        transfer.voucher_id,
        transfer.destination_location_id,
        transfer.inventory_applied,
        voucher.company_id,
        voucher.voucher_type,
        voucher.deleted_at
      FROM stock_transfer_revisions revision
      JOIN stock_transfer_vouchers transfer ON transfer.id = revision.transfer_id
      JOIN vouchers voucher ON voucher.id = transfer.voucher_id
      WHERE revision.id = ${revisionId}
      FOR UPDATE OF revision, transfer, voucher
    `)
  );
}
