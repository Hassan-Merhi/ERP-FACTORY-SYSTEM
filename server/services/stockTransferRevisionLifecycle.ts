import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { adjustInventory } from "../inventoryHelper";
import { firstRow } from "../lib/queryResult";
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

// First-row access to `.execute()` results (both the node-postgres
// `{ rows: [...] }` shape and a bare row array) comes from the shared typed
// helper in lib/queryResult, matching the rest of the codebase.

export interface PendingRevisionItemInput {
  stockItemId: number;
  stockItemName: string;
  sourceLocationId: number;
  sourceLocationName?: string | null;
  originalQuantity: number;
  newQuantity: number;
}

export interface SavePendingRevisionInput {
  companyId: number;
  transferId: number;
  userId: string;
  note?: string | null;
  sourceLocationIdLimit?: number | null;
  items: PendingRevisionItemInput[];
}

export interface PendingRevisionResult {
  revisionId: number;
  transferId: number;
  revisionNumber: number;
  itemCount: number;
  optional: boolean;
  destinationLocationId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  items: Array<typeof stockTransferRevisionItems.$inferSelect>;
}

export interface ApproveRevisionResult {
  revisionId: number;
  transferId: number;
  voucherId: number;
  transition: "approved" | "no-op";
  approvedRevisionCount: number;
  changedItemCount: number;
  inventoryApplied: boolean;
  totalAmount: string;
}

interface NormalizedRevisionItem extends PendingRevisionItemInput {
  delta: number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function finiteNonNegative(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number`);
  return parsed;
}

export function normalizePendingRevisionItems(items: PendingRevisionItemInput[]): NormalizedRevisionItem[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error("At least one changed item is required");

  const byKey = new Map<string, NormalizedRevisionItem>();
  for (const raw of items) {
    const stockItemId = positiveInteger(raw.stockItemId, "Stock item ID");
    const sourceLocationId = positiveInteger(raw.sourceLocationId, "Source location ID");
    const originalQuantity = finiteNonNegative(raw.originalQuantity, "Original quantity");
    const newQuantity = finiteNonNegative(raw.newQuantity, "New quantity");
    const delta = newQuantity - originalQuantity;
    if (Math.abs(delta) < 0.0005) continue;

    const key = `${stockItemId}:${sourceLocationId}`;
    byKey.set(key, {
      stockItemId,
      stockItemName: String(raw.stockItemName || `Item ${stockItemId}`).trim(),
      sourceLocationId,
      sourceLocationName: raw.sourceLocationName ? String(raw.sourceLocationName).trim() : null,
      originalQuantity,
      newQuantity,
      delta,
    });
  }

  const normalized = Array.from(byKey.values()).sort(
    (a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId
  );
  if (normalized.length === 0) throw new Error("Revision has no effective quantity changes");
  return normalized;
}

async function lockTransferScope(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], transferId: number) {
  const result = await tx.execute(sql`
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
      v.deleted_at
    FROM stock_transfer_vouchers stv
    JOIN vouchers v ON v.id = stv.voucher_id
    WHERE stv.id = ${transferId}
    FOR UPDATE OF stv, v
  `);
  return firstRow(result);
}

function assertLockedTransfer(locked: Record<string, unknown> | undefined, companyId: number): asserts locked {
  if (!locked) throw new Error("Stock transfer not found");
  if (Number(locked.company_id) !== companyId) throw new Error("Stock transfer belongs to a different company");
  if (
    locked.voucher_type !== "Stock Transfer" &&
    locked.voucher_type !== "StockTransfer" &&
    locked.voucher_type !== "Transfer"
  ) {
    throw new Error("Voucher is not a stock transfer");
  }
  if (locked.deleted_at) throw new Error("Deleted stock transfers cannot be revised");
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
    throw new Error("One or more revision locations do not belong to the current company");
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
    throw new Error("One or more revision stock items do not belong to the current company or are inactive");
  }
}

export async function savePendingStockTransferRevision(
  input: SavePendingRevisionInput
): Promise<PendingRevisionResult> {
  const companyId = positiveInteger(input.companyId, "Company ID");
  const transferId = positiveInteger(input.transferId, "Transfer ID");
  if (!input.userId) throw new Error("User ID is required");
  const normalized = normalizePendingRevisionItems(input.items);

  return db.transaction(async (tx) => {
    const locked = await lockTransferScope(tx, transferId);
    assertLockedTransfer(locked, companyId);
    const destinationLocationId = positiveInteger(locked.destination_location_id, "Destination location ID");

    for (const item of normalized) {
      if (item.sourceLocationId === destinationLocationId) {
        throw new Error("Revision source and destination locations must be different");
      }
      if (input.sourceLocationIdLimit && item.sourceLocationId !== input.sourceLocationIdLimit) {
        throw new Error("POS users may only revise items assigned to their own source location");
      }
    }
    await assertCompanyScope(tx, companyId, destinationLocationId, normalized);

    const existingResult = await tx.execute(sql`
      SELECT *
      FROM stock_transfer_revisions
      WHERE transfer_id = ${transferId}
        AND optional = true
        AND created_by = ${input.userId}
      ORDER BY revision_number ASC
      LIMIT 1
      FOR UPDATE
    `);
    const existing = firstRow(existingResult);

    let revisionId: number;
    let revisionNumber: number;
    if (existing) {
      revisionId = Number(existing.id);
      revisionNumber = Number(existing.revision_number);
      await tx
        .update(stockTransferRevisions)
        .set({
          note: input.note?.trim() || null,
          revisionDate: new Date(),
        })
        .where(eq(stockTransferRevisions.id, revisionId));
      await tx.delete(stockTransferRevisionItems).where(eq(stockTransferRevisionItems.revisionId, revisionId));
    } else {
      const [latest] = await tx
        .select({ revisionNumber: stockTransferRevisions.revisionNumber })
        .from(stockTransferRevisions)
        .where(eq(stockTransferRevisions.transferId, transferId))
        .orderBy(asc(stockTransferRevisions.revisionNumber));

      const maxResult = await tx.execute(sql`
        SELECT COALESCE(MAX(revision_number), 0) AS max_revision
        FROM stock_transfer_revisions
        WHERE transfer_id = ${transferId}
      `);
      const maxRow = firstRow(maxResult);
      revisionNumber = Number(maxRow?.max_revision ?? latest?.revisionNumber ?? 0) + 1;
      const [created] = await tx
        .insert(stockTransferRevisions)
        .values({
          transferId,
          revisionNumber,
          note: input.note?.trim() || null,
          optional: true,
          createdBy: input.userId,
        })
        .returning();
      revisionId = created.id;
    }

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

    return {
      revisionId,
      transferId,
      revisionNumber,
      itemCount: savedItems.length,
      optional: true,
      destinationLocationId,
      voucherId: Number(locked.voucher_id),
      voucherNumber: String(locked.voucher_number),
      voucherDate: String(locked.voucher_date),
      items: savedItems,
    };
  });
}

interface NetRevisionTarget {
  stockItemId: number;
  sourceLocationId: number;
  originalQuantity: number;
  newQuantity: number;
}

export function mergePendingRevisionTargets(
  revisions: Array<{ id: number; revisionNumber: number }>,
  items: Array<{
    revisionId: number;
    stockItemId: number;
    sourceLocationId: number | null;
    originalQuantity: string;
    newQuantity: string;
  }>
): NetRevisionTarget[] {
  const byRevision = new Map<number, typeof items>();
  for (const item of items) {
    const group = byRevision.get(item.revisionId) || [];
    group.push(item);
    byRevision.set(item.revisionId, group);
  }

  const targets = new Map<string, NetRevisionTarget>();
  for (const revision of [...revisions].sort((a, b) => a.revisionNumber - b.revisionNumber)) {
    for (const item of byRevision.get(revision.id) || []) {
      if (!item.sourceLocationId) throw new Error("Revision item is missing its source location");
      const key = `${item.stockItemId}:${item.sourceLocationId}`;
      const existing = targets.get(key);
      const originalQuantity = finiteNonNegative(item.originalQuantity, "Original quantity");
      const newQuantity = finiteNonNegative(item.newQuantity, "New quantity");
      if (existing) targets.set(key, { ...existing, newQuantity });
      else {
        targets.set(key, {
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          originalQuantity,
          newQuantity,
        });
      }
    }
  }
  return Array.from(targets.values()).sort(
    (a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId
  );
}

export async function approvePendingStockTransferRevision(
  companyIdInput: number,
  revisionIdInput: number
): Promise<ApproveRevisionResult> {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const revisionId = positiveInteger(revisionIdInput, "Revision ID");

  return db.transaction(async (tx) => {
    const requestedResult = await tx.execute(sql`
      SELECT
        str.id AS revision_id,
        str.transfer_id,
        stv.voucher_id,
        stv.destination_location_id,
        stv.inventory_applied,
        v.company_id,
        v.voucher_type,
        v.deleted_at
      FROM stock_transfer_revisions str
      JOIN stock_transfer_vouchers stv ON stv.id = str.transfer_id
      JOIN vouchers v ON v.id = stv.voucher_id
      WHERE str.id = ${revisionId}
      FOR UPDATE OF str, stv, v
    `);
    const requested = firstRow(requestedResult);
    if (!requested) throw new Error("Revision not found");
    if (Number(requested.company_id) !== companyId) throw new Error("Revision belongs to a different company");
    if (
      requested.voucher_type !== "Stock Transfer" &&
      requested.voucher_type !== "StockTransfer" &&
      requested.voucher_type !== "Transfer"
    ) {
      throw new Error("Voucher is not a stock transfer");
    }
    if (requested.deleted_at) throw new Error("Deleted stock transfers cannot be revised");

    const transferId = Number(requested.transfer_id);
    const voucherId = Number(requested.voucher_id);
    const destinationLocationId = positiveInteger(requested.destination_location_id, "Destination location ID");
    const inventoryApplied = Boolean(requested.inventory_applied);

    const pendingResult = await tx.execute(sql`
      SELECT *
      FROM stock_transfer_revisions
      WHERE transfer_id = ${transferId}
        AND optional = true
      ORDER BY revision_number ASC
      FOR UPDATE
    `);
    const pendingRows = pendingResult.rows ?? pendingResult;
    if (pendingRows.length === 0) {
      const currentItems = await tx
        .select({ quantity: stockTransferItems.quantity, rate: stockTransferItems.rate })
        .from(stockTransferItems)
        .where(eq(stockTransferItems.transferId, transferId));
      const totalAmount = currentItems
        .reduce((sum, item) => sum + Number(item.quantity) * Number(item.rate ?? 0), 0)
        .toFixed(2);
      return {
        revisionId,
        transferId,
        voucherId,
        transition: "no-op",
        approvedRevisionCount: 0,
        changedItemCount: 0,
        inventoryApplied,
        totalAmount,
      };
    }

    const pendingIds = pendingRows.map((row) => Number(row.id));
    const pendingItems = await tx
      .select()
      .from(stockTransferRevisionItems)
      .where(inArray(stockTransferRevisionItems.revisionId, pendingIds));
    if (pendingItems.length === 0) throw new Error("Pending revision has no items");

    const targets = mergePendingRevisionTargets(
      pendingRows.map((row) => ({ id: Number(row.id), revisionNumber: Number(row.revision_number) })),
      pendingItems
    );
    await assertCompanyScope(tx, companyId, destinationLocationId, targets);

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

    for (const target of targets) {
      const existing =
        existingItems.find(
          (item) => item.stockItemId === target.stockItemId && item.sourceLocationId === target.sourceLocationId
        ) || null;
      const oldQuantity = existing ? Number(existing.quantity) : 0;
      if (Math.abs(oldQuantity - target.originalQuantity) > 0.001) {
        const error: Error & {
          code?: string;
          stockItemId?: number;
          sourceLocationId?: number;
          requiredQuantity?: number;
          availableQuantity?: number;
        } = new Error(
          `Revision is stale for item ${target.stockItemId} at source ${target.sourceLocationId}. ` +
            `Expected ${target.originalQuantity}, current transfer quantity is ${oldQuantity}.`
        );
        error.code = "STOCK_TRANSFER_REVISION_STALE";
        error.stockItemId = target.stockItemId;
        error.sourceLocationId = target.sourceLocationId;
        throw error;
      }

      let rate = existing ? Number(existing.rate ?? 0) : 0;
      if (!existing) {
        const [sourceInventory] = await tx
          .select({ averageRate: inventory.averageRate })
          .from(inventory)
          .where(
            and(
              eq(inventory.companyId, companyId),
              eq(inventory.locationId, target.sourceLocationId),
              eq(inventory.stockItemId, target.stockItemId)
            )
          )
          .limit(1);
        rate = Number(sourceInventory?.averageRate ?? 0);
      }

      changes.push({
        existing,
        stockItemId: target.stockItemId,
        sourceLocationId: target.sourceLocationId,
        oldQuantity,
        newQuantity: target.newQuantity,
        delta: target.newQuantity - oldQuantity,
        rate: Number.isFinite(rate) ? rate : 0,
      });
    }

    if (inventoryApplied) {
      const sourceRequirements = new Map<string, { sourceLocationId: number; stockItemId: number; quantity: number }>();
      const destinationReturns = new Map<number, number>();
      for (const change of changes) {
        if (change.delta > 0) {
          const key = `${change.sourceLocationId}:${change.stockItemId}`;
          const current = sourceRequirements.get(key);
          if (current) current.quantity += change.delta;
          else {
            sourceRequirements.set(key, {
              sourceLocationId: change.sourceLocationId,
              stockItemId: change.stockItemId,
              quantity: change.delta,
            });
          }
        } else if (change.delta < 0) {
          destinationReturns.set(
            change.stockItemId,
            (destinationReturns.get(change.stockItemId) ?? 0) + Math.abs(change.delta)
          );
        }
      }

      const orderedSources = Array.from(sourceRequirements.values()).sort(
        (a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId
      );
      for (const requirement of orderedSources) {
        const lockedInventory = await tx.execute(sql`
          SELECT quantity
          FROM inventory
          WHERE company_id = ${companyId}
            AND location_id = ${requirement.sourceLocationId}
            AND stock_item_id = ${requirement.stockItemId}
          FOR UPDATE
        `);
        const row = firstRow(lockedInventory);
        const available = Number(row?.quantity ?? 0);
        if (available + 1e-9 < requirement.quantity) {
          const error: Error & {
            code?: string;
            stockItemId?: number;
            sourceLocationId?: number;
            requiredQuantity?: number;
            availableQuantity?: number;
          } = new Error(
            `Insufficient stock for revision item ${requirement.stockItemId} at source ${requirement.sourceLocationId}: ` +
              `required ${requirement.quantity}, available ${available}`
          );
          error.code = "STOCK_TRANSFER_INSUFFICIENT_STOCK";
          error.stockItemId = requirement.stockItemId;
          error.sourceLocationId = requirement.sourceLocationId;
          error.requiredQuantity = requirement.quantity;
          error.availableQuantity = available;
          throw error;
        }
      }

      for (const [stockItemId, required] of Array.from(destinationReturns.entries()).sort((a, b) => a[0] - b[0])) {
        const lockedDestination = await tx.execute(sql`
          SELECT quantity
          FROM inventory
          WHERE company_id = ${companyId}
            AND location_id = ${destinationLocationId}
            AND stock_item_id = ${stockItemId}
          FOR UPDATE
        `);
        const row = firstRow(lockedDestination);
        const available = Number(row?.quantity ?? 0);
        if (available + 1e-9 < required) {
          const error: Error & {
            code?: string;
            stockItemId?: number;
            sourceLocationId?: number;
            requiredQuantity?: number;
            availableQuantity?: number;
          } = new Error(
            `Destination stock is too low to reduce transfer item ${stockItemId}: required ${required}, available ${available}`
          );
          error.code = "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT";
          error.stockItemId = stockItemId;
          error.requiredQuantity = required;
          error.availableQuantity = available;
          throw error;
        }
      }
    }

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
    await tx
      .update(stockTransferRevisions)
      .set({ optional: false })
      .where(and(eq(stockTransferRevisions.transferId, transferId), eq(stockTransferRevisions.optional, true)));

    return {
      revisionId,
      transferId,
      voucherId,
      transition: "approved",
      approvedRevisionCount: pendingRows.length,
      changedItemCount: changes.filter((change) => Math.abs(change.delta) >= 0.0005).length,
      inventoryApplied,
      totalAmount,
    };
  });
}
