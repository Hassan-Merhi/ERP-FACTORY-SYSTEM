import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { adjustInventory } from "../inventoryHelper";
import { journalStockTransferLeg, nextStockTransferRevision } from "./inventory/stockTransferJournal";
import {
  inventory,
  locations,
  stockItems,
  stockTransferItems,
  stockTransferRevisionItems,
  stockTransferRevisions,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";
import {
  immutableRevisionPayloadHash,
  normalizeImmutableRevisionItems,
  type ImmutableRevisionItemInput,
  type LifecycleError,
  type LockedTransferRow,
  type NormalizedImmutableRevisionItem,
} from "./immutableStockTransferRevisionInput";
import { resultRows } from "../lib/queryResult";

export { normalizeImmutableRevisionItems } from "./immutableStockTransferRevisionInput";
export type { ImmutableRevisionItemInput } from "./immutableStockTransferRevisionInput";

export type StockTransferRevisionStatus = "pending" | "approved" | "rejected" | "cancelled" | "superseded";

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

function rows<T extends Record<string, unknown> = Record<string, unknown>>(result: unknown): T[] {
  return resultRows<T>(result);
}

function firstRow<T extends Record<string, unknown> = Record<string, unknown>>(result: unknown): T | undefined {
  return rows<T>(result)[0];
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function lifecycleError(message: string, code: string): LifecycleError {
  const error: LifecycleError = new Error(message);
  error.code = code;
  return error;
}

function toRevisionAuditItems(
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

async function lockTransfer(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], transferId: number) {
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

function assertTransfer(transfer: LockedTransferRow | undefined, companyId: number): asserts transfer {
  if (!transfer) throw new Error("Stock transfer not found");
  if (Number(transfer.company_id) !== companyId) {
    throw lifecycleError("Stock transfer belongs to a different company", "STOCK_TRANSFER_REVISION_SCOPE");
  }
  if (!["Stock Transfer", "StockTransfer", "Transfer"].includes(String(transfer.voucher_type))) {
    throw new Error("Voucher is not a stock transfer");
  }
  if (transfer.deleted_at) throw new Error("Deleted stock transfers cannot be revised");
}

async function assertCompanyScope(
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

async function assertSubmittedBaseline(
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

export async function createImmutableStockTransferRevision(
  input: CreateImmutableRevisionInput
): Promise<ImmutableRevisionResult> {
  const companyId = positiveInteger(input.companyId, "Company ID");
  const transferId = positiveInteger(input.transferId, "Transfer ID");
  const userId = String(input.userId || "").trim();
  if (!userId) throw new Error("User ID is required");
  const note = input.note?.trim() || null;
  const normalized = normalizeImmutableRevisionItems(input.items);
  const hash = immutableRevisionPayloadHash(normalized, note);

  return db.transaction(async (tx) => {
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
          originalQuantity: item.originalQuantity.toFixed(3),
          delta: item.delta.toFixed(3),
          newQuantity: item.newQuantity.toFixed(3),
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
    return {
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
    };
  });
}

/**
 * All pending revisions for a transfer, oldest first, locked for update.
 * Approval applies every one of them — a transfer fed by several POS locations
 * collects one pending revision per submitter, and approving only the clicked
 * row would silently discard the others.
 */
async function lockedPendingRevisions(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], transferId: number) {
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

async function lockedRevision(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], revisionId: number) {
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

export async function approveImmutableStockTransferRevision(
  companyIdInput: number,
  revisionIdInput: number,
  reviewerIdInput: string
): Promise<ReviewImmutableRevisionResult> {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const revisionId = positiveInteger(revisionIdInput, "Revision ID");
  const reviewerId = String(reviewerIdInput || "").trim();
  if (!reviewerId) throw new Error("Reviewer ID is required");

  return db.transaction(async (tx) => {
    const requested = await lockedRevision(tx, revisionId);
    if (!requested) throw new Error("Revision not found");
    if (Number(requested.company_id) !== companyId) {
      throw lifecycleError("Revision belongs to a different company", "STOCK_TRANSFER_REVISION_SCOPE");
    }
    if (requested.deleted_at) throw new Error("Deleted stock transfers cannot be revised");

    const transferId = Number(requested.transfer_id);
    const voucherId = Number(requested.voucher_id);
    const revisionNumber = Number(requested.revision_number);
    const inventoryApplied = Boolean(requested.inventory_applied);
    const destinationLocationId = positiveInteger(requested.destination_location_id, "Destination location ID");

    if (requested.status === "approved") {
      const currentItems = await tx
        .select({ quantity: stockTransferItems.quantity, rate: stockTransferItems.rate })
        .from(stockTransferItems)
        .where(eq(stockTransferItems.transferId, transferId));
      const currentRevisionItems = await tx
        .select()
        .from(stockTransferRevisionItems)
        .where(eq(stockTransferRevisionItems.revisionId, revisionId));
      return {
        revisionId,
        transferId,
        voucherId,
        revisionNumber,
        transition: "no-op",
        changedItemCount: 0,
        inventoryApplied,
        totalAmount: currentItems
          .reduce((sum, item) => sum + Number(item.quantity) * Number(item.rate ?? 0), 0)
          .toFixed(2),
        items: toRevisionAuditItems(currentRevisionItems),
      };
    }
    if (requested.status !== "pending") {
      throw lifecycleError(
        `Revision #${revisionNumber} is ${requested.status} and cannot be approved`,
        "STOCK_TRANSFER_REVISION_STATUS"
      );
    }

    // Approving one pending revision approves every pending revision on the
    // transfer. Each POS location submits its own, and they are merged per
    // (stockItemId, sourceLocationId) with the newest revision winning the key.
    const pendingRevisions = await lockedPendingRevisions(tx, transferId);
    const pendingIds = pendingRevisions.map((revision) => revision.id);
    if (!pendingIds.includes(revisionId)) pendingIds.push(revisionId);
    const revisionOrder = new Map(pendingRevisions.map((revision, index) => [revision.id, index]));

    const pendingItems = await tx
      .select()
      .from(stockTransferRevisionItems)
      .where(inArray(stockTransferRevisionItems.revisionId, pendingIds));
    if (pendingItems.length === 0) throw new Error("Pending revision has no items");

    // Last writer wins per key; every contributing revision is still validated
    // against the transfer's current quantities below.
    const winningItems = new Map<string, (typeof pendingItems)[number]>();
    for (const item of pendingItems) {
      const key = `${item.stockItemId}:${item.sourceLocationId ?? ""}`;
      const current = winningItems.get(key);
      if (
        !current ||
        (revisionOrder.get(item.revisionId) ?? -1) > (revisionOrder.get(current.revisionId) ?? -1) ||
        ((revisionOrder.get(item.revisionId) ?? -1) === (revisionOrder.get(current.revisionId) ?? -1) &&
          item.id > current.id)
      ) {
        winningItems.set(key, item);
      }
    }
    const revisionItems = Array.from(winningItems.values());

    // A pending revision every one of whose items lost its key contributed
    // nothing and is recorded as superseded rather than approved.
    const contributingRevisionIds = new Set(revisionItems.map((item) => item.revisionId));
    contributingRevisionIds.add(revisionId);
    const overriddenRevisionIds = pendingIds.filter((id) => !contributingRevisionIds.has(id));

    const scopedItems = pendingItems.map((item) => ({
      sourceLocationId: positiveInteger(item.sourceLocationId, "Source location ID"),
      stockItemId: item.stockItemId,
    }));
    await assertCompanyScope(tx, companyId, destinationLocationId, scopedItems);

    const existingItems = await tx
      .select()
      .from(stockTransferItems)
      .where(eq(stockTransferItems.transferId, transferId));

    const changes: Array<{
      existing: (typeof existingItems)[number] | null;
      stockItemId: number;
      sourceLocationId: number;
      oldQuantity: number;
      newQuantity: number;
      delta: number;
      rate: number;
    }> = [];

    // Every pending item — winners and overridden alike — was authored against
    // the transfer's current quantities, so all of them must still agree with
    // them before any of the merged changes are applied.
    const revisionNumbersById = new Map(pendingRevisions.map((revision) => [revision.id, revision.revisionNumber]));
    for (const item of pendingItems) {
      const sourceLocationId = positiveInteger(item.sourceLocationId, "Source location ID");
      const existing = existingItems.find(
        (candidate: (typeof existingItems)[number]) =>
          candidate.stockItemId === item.stockItemId && candidate.sourceLocationId === sourceLocationId
      );
      const oldQuantity = Number(existing?.quantity ?? 0);
      const expectedQuantity = Number(item.originalQuantity);
      if (Math.abs(oldQuantity - expectedQuantity) > 0.001) {
        const error: LifecycleError = lifecycleError(
          `Revision #${revisionNumbersById.get(item.revisionId) ?? revisionNumber} is stale for ${item.stockItemName}. Expected ${expectedQuantity}, current transfer quantity is ${oldQuantity}.`,
          "STOCK_TRANSFER_REVISION_STALE"
        );
        error.stockItemId = item.stockItemId;
        error.sourceLocationId = sourceLocationId;
        throw error;
      }
    }

    for (const item of revisionItems) {
      const sourceLocationId = positiveInteger(item.sourceLocationId, "Source location ID");
      const existing =
        existingItems.find(
          (candidate) => candidate.stockItemId === item.stockItemId && candidate.sourceLocationId === sourceLocationId
        ) || null;
      const oldQuantity = Number(existing?.quantity ?? 0);
      const newQuantity = Number(item.newQuantity);

      let rate = Number(existing?.rate ?? 0);
      if (!existing) {
        const [sourceInventory] = await tx
          .select({ averageRate: inventory.averageRate })
          .from(inventory)
          .where(
            and(
              eq(inventory.companyId, companyId),
              eq(inventory.locationId, sourceLocationId),
              eq(inventory.stockItemId, item.stockItemId)
            )
          )
          .limit(1);
        rate = Number(sourceInventory?.averageRate ?? 0);
      }
      changes.push({
        existing,
        stockItemId: item.stockItemId,
        sourceLocationId,
        oldQuantity,
        newQuantity,
        delta: newQuantity - oldQuantity,
        rate: Number.isFinite(rate) ? rate : 0,
      });
    }

    if (inventoryApplied) {
      for (const change of changes) {
        if (change.delta > 0) {
          const sourceInventory = firstRow(
            await tx.execute(sql`
              SELECT quantity
              FROM inventory
              WHERE company_id = ${companyId}
                AND location_id = ${change.sourceLocationId}
                AND stock_item_id = ${change.stockItemId}
              FOR UPDATE
            `)
          );
          const available = Number(sourceInventory?.quantity ?? 0);
          if (available + 1e-9 < change.delta) {
            const error: LifecycleError = lifecycleError(
              `Insufficient stock for revision item ${change.stockItemId}: required ${change.delta}, available ${available}`,
              "STOCK_TRANSFER_INSUFFICIENT_STOCK"
            );
            error.stockItemId = change.stockItemId;
            error.sourceLocationId = change.sourceLocationId;
            error.requiredQuantity = change.delta;
            error.availableQuantity = available;
            throw error;
          }
        } else if (change.delta < 0) {
          const destinationInventory = firstRow(
            await tx.execute(sql`
              SELECT quantity
              FROM inventory
              WHERE company_id = ${companyId}
                AND location_id = ${destinationLocationId}
                AND stock_item_id = ${change.stockItemId}
              FOR UPDATE
            `)
          );
          const required = Math.abs(change.delta);
          const available = Number(destinationInventory?.quantity ?? 0);
          if (available + 1e-9 < required) {
            const error: LifecycleError = lifecycleError(
              `Destination stock is too low to reduce transfer item ${change.stockItemId}: required ${required}, available ${available}`,
              "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT"
            );
            error.stockItemId = change.stockItemId;
            error.requiredQuantity = required;
            error.availableQuantity = available;
            throw error;
          }
        }
      }
    }

    const canonicalRevision = await nextStockTransferRevision(tx, companyId, transferId);

    for (const change of changes) {
      if (change.existing) {
        if (change.newQuantity <= 0) {
          await tx.delete(stockTransferItems).where(eq(stockTransferItems.id, change.existing.id));
        } else {
          await tx
            .update(stockTransferItems)
            .set({
              quantity: change.newQuantity.toFixed(3),
              totalAmount: (change.newQuantity * change.rate).toFixed(2),
            })
            .where(eq(stockTransferItems.id, change.existing.id));
        }
      } else if (change.newQuantity > 0) {
        await tx.insert(stockTransferItems).values({
          transferId,
          stockItemId: change.stockItemId,
          sourceLocationId: change.sourceLocationId,
          quantity: change.newQuantity.toFixed(3),
          rate: change.rate.toFixed(2),
          totalAmount: (change.newQuantity * change.rate).toFixed(2),
        });
      }

      if (inventoryApplied && Math.abs(change.delta) >= 0.0005) {
        await adjustInventory(tx, change.sourceLocationId, change.stockItemId, -change.delta, companyId, change.rate);
        await adjustInventory(tx, destinationLocationId, change.stockItemId, change.delta, companyId, change.rate);

        // A revision applies a delta, not a whole quantity: positive moves more
        // stock out to the destination, negative brings some of it back. The
        // journal records the direction the stock actually travelled, so the
        // legs are swapped for a negative delta rather than logged as a
        // negative issue nobody would read correctly.
        await journalStockTransferLeg(tx, {
          companyId,
          transferId,
          revision: canonicalRevision,
          phase: change.delta > 0 ? "issue" : "reverse",
          fromLocationId: change.delta > 0 ? change.sourceLocationId : destinationLocationId,
          toLocationId: change.delta > 0 ? destinationLocationId : change.sourceLocationId,
          leg: { stockItemId: change.stockItemId, quantity: change.delta, rate: change.rate },
        });
      }
    }

    const finalItems = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    const totalAmount = finalItems
      .reduce((sum, item) => sum + Number(item.quantity) * Number(item.rate ?? 0), 0)
      .toFixed(2);
    const uniqueSources = Array.from(
      new Set(finalItems.map((item) => item.sourceLocationId).filter((value): value is number => Boolean(value)))
    );
    const headerSourceId = uniqueSources.length === 1 ? uniqueSources[0] : null;

    await tx
      .update(stockTransferVouchers)
      .set({ sourceLocationId: headerSourceId })
      .where(eq(stockTransferVouchers.id, transferId));
    await tx
      .update(vouchers)
      .set({ totalAmount, locationId: headerSourceId, ...(headerSourceId === null ? { locationName: null } : {}) })
      .where(eq(vouchers.id, voucherId));
    await tx.execute(sql`
      UPDATE stock_transfer_revisions
      SET status = 'approved', optional = false, reviewed_at = now(), reviewed_by = ${reviewerId}
      WHERE id = ${revisionId} AND status = 'pending'
    `);
    // Every other pending revision whose items landed in the merge is approved
    // alongside it — their quantities are now part of the transfer.
    const coApprovedIds = pendingIds.filter((id) => id !== revisionId && !overriddenRevisionIds.includes(id));
    if (coApprovedIds.length > 0) {
      await tx
        .update(stockTransferRevisions)
        .set({ status: "approved", optional: false, reviewedAt: new Date(), reviewedBy: reviewerId })
        .where(and(inArray(stockTransferRevisions.id, coApprovedIds), eq(stockTransferRevisions.status, "pending")));
    }
    // Anything still pending contributed nothing to the merge (every key it
    // touched was overridden by a newer revision), or arrived after the lock.
    await tx.execute(sql`
      UPDATE stock_transfer_revisions
      SET
        status = 'superseded',
        optional = false,
        reviewed_at = now(),
        reviewed_by = ${reviewerId},
        superseded_by_revision_id = ${revisionId}
      WHERE transfer_id = ${transferId}
        AND id <> ${revisionId}
        AND status = 'pending'
    `);

    const auditRates = new Map(
      changes.map((change) => [`${change.stockItemId}:${change.sourceLocationId}`, change.rate] as const)
    );
    return {
      revisionId,
      transferId,
      voucherId,
      revisionNumber,
      transition: "approved",
      changedItemCount: changes.filter((change) => Math.abs(change.delta) >= 0.0005).length,
      appliedRevisionCount: pendingIds.length - overriddenRevisionIds.length,
      inventoryApplied,
      totalAmount,
      items: toRevisionAuditItems(revisionItems, auditRates),
    };
  });
}

export async function rejectImmutableStockTransferRevision(
  companyIdInput: number,
  revisionIdInput: number,
  reviewerIdInput: string,
  reasonInput?: string | null
): Promise<ReviewImmutableRevisionResult> {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const revisionId = positiveInteger(revisionIdInput, "Revision ID");
  const reviewerId = String(reviewerIdInput || "").trim();
  if (!reviewerId) throw new Error("Reviewer ID is required");
  const reason = reasonInput?.trim() || null;

  return db.transaction(async (tx) => {
    const requested = await lockedRevision(tx, revisionId);
    if (!requested) throw new Error("Revision not found");
    if (Number(requested.company_id) !== companyId) {
      throw lifecycleError("Revision belongs to a different company", "STOCK_TRANSFER_REVISION_SCOPE");
    }
    const transferId = Number(requested.transfer_id);
    const voucherId = Number(requested.voucher_id);
    const revisionNumber = Number(requested.revision_number);
    const inventoryApplied = Boolean(requested.inventory_applied);
    const rejectedRevisionItems = await tx
      .select()
      .from(stockTransferRevisionItems)
      .where(eq(stockTransferRevisionItems.revisionId, revisionId));

    if (requested.status === "rejected") {
      const currentItems = await tx
        .select({ quantity: stockTransferItems.quantity, rate: stockTransferItems.rate })
        .from(stockTransferItems)
        .where(eq(stockTransferItems.transferId, transferId));
      return {
        revisionId,
        transferId,
        voucherId,
        revisionNumber,
        transition: "no-op",
        changedItemCount: 0,
        inventoryApplied,
        totalAmount: currentItems
          .reduce((sum, item) => sum + Number(item.quantity) * Number(item.rate ?? 0), 0)
          .toFixed(2),
        items: toRevisionAuditItems(rejectedRevisionItems),
      };
    }
    if (requested.status !== "pending") {
      throw lifecycleError(
        `Revision #${revisionNumber} is ${requested.status} and cannot be rejected`,
        "STOCK_TRANSFER_REVISION_STATUS"
      );
    }

    await tx.execute(sql`
      UPDATE stock_transfer_revisions
      SET
        status = 'rejected',
        optional = false,
        reviewed_at = now(),
        reviewed_by = ${reviewerId},
        rejection_reason = ${reason}
      WHERE id = ${revisionId} AND status = 'pending'
    `);
    const currentItems = await tx
      .select({ quantity: stockTransferItems.quantity, rate: stockTransferItems.rate })
      .from(stockTransferItems)
      .where(eq(stockTransferItems.transferId, transferId));
    return {
      revisionId,
      transferId,
      voucherId,
      revisionNumber,
      transition: "rejected",
      changedItemCount: 0,
      inventoryApplied,
      totalAmount: currentItems
        .reduce((sum, item) => sum + Number(item.quantity) * Number(item.rate ?? 0), 0)
        .toFixed(2),
      items: toRevisionAuditItems(rejectedRevisionItems),
    };
  });
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
