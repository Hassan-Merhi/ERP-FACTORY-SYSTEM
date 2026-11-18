// Extracted from ./immutableStockTransferRevisionLifecycle.ts to keep that module under the source-size cap.
import { type AuditTxHook, finishWithAudit } from "../lib/auditTxHook";
import { and, eq, inArray, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { db } from "../db";
import { assertNoBaleMirrorMovementTx } from "./accounting/perpetualInventory/cutoverRefusal";
import { applyTransferRevisionDeltaTx, postTransferResidualTx } from "./inventory/conservedStockTransfer";
import { journalStockTransferLeg, nextStockTransferRevision } from "./inventory/stockTransferJournal";
import { lineValueMoved, reversalDate } from "./inventory/valueExactReversal";
import {
  inventory,
  stockTransferItems,
  stockTransferRevisionItems,
  stockTransferRevisions,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";
import type { LifecycleError } from "./immutableStockTransferRevisionInput";
import { firstRow, lifecycleError, positiveInteger } from "./immutableStockTransferRevisionQueries";
import { lineAmount, MoneyDecimal, toMoney } from "../lib/money";
import {
  assertCompanyScope,
  toRevisionAuditItems,
  type ReviewImmutableRevisionResult,
} from "./immutableStockTransferRevisionLifecycleAssertCompanyScope";
import { lockedPendingRevisions, lockedRevision } from "./createImmutableStockTransferRevision";

export async function approveImmutableStockTransferRevision(
  companyIdInput: number,
  revisionIdInput: number,
  reviewerIdInput: string,
  auditTx?: AuditTxHook<ReviewImmutableRevisionResult>,
  existingTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<ReviewImmutableRevisionResult> {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const revisionId = positiveInteger(revisionIdInput, "Revision ID");
  const reviewerId = String(reviewerIdInput || "").trim();
  if (!reviewerId) throw new Error("Reviewer ID is required");

  const executeApproval = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    const finish = finishWithAudit(tx, auditTx);
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
      return finish({
        revisionId,
        transferId,
        voucherId,
        revisionNumber,
        transition: "no-op",
        changedItemCount: 0,
        appliedRevisionCount: 0,
        inventoryApplied,
        totalAmount: currentItems
          .reduce((sum, item) => sum.plus(lineAmount(item.quantity, item.rate)), new MoneyDecimal(0))
          .toFixed(2),
        items: toRevisionAuditItems(currentRevisionItems),
      });
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
    if (inventoryApplied) {
      // Wave 11: a factory bale-mirror item is moved in the factory after the cut-over.
      await assertNoBaleMirrorMovementTx(
        tx,
        companyId,
        changes.filter((change) => Math.abs(change.delta) >= 0.0005).map((change) => change.stockItemId),
        "stock-transfer-revision"
      );
    }

    // Wave 15: the revision moves value conserved and each line keeps its
    // value_moved (see applyTransferRevisionDeltaTx).
    const deltas: Decimal[] = [];
    for (const change of changes) {
      let valueMoved: string | null | undefined = change.existing?.valueMoved;
      if (inventoryApplied && Math.abs(change.delta) >= 0.0005) {
        const applied = await applyTransferRevisionDeltaTx(tx, {
          companyId,
          sourceLocationId: change.sourceLocationId,
          destinationLocationId,
          stockItemId: change.stockItemId,
          oldQuantity: change.existing?.quantity ?? 0,
          newQuantity: change.newQuantity.toFixed(3),
          lineValue: change.existing
            ? lineValueMoved({ valueMoved: change.existing.valueMoved, total: change.existing.totalAmount })
            : 0,
          fallbackRate: change.rate,
          sourceVoucherType: "Stock Transfer",
          sourceVoucherId: voucherId,
        });
        deltas.push(...applied.deltas);
        valueMoved = applied.valueMoved.toFixed(2);
      }
      if (change.existing) {
        if (change.newQuantity <= 0) {
          await tx.delete(stockTransferItems).where(eq(stockTransferItems.id, change.existing.id));
        } else {
          await tx
            .update(stockTransferItems)
            .set({
              quantity: toMoney(change.newQuantity).toFixed(3),
              totalAmount: lineAmount(change.newQuantity, change.rate).toFixed(2),
              valueMoved: valueMoved ?? null,
            })
            .where(eq(stockTransferItems.id, change.existing.id));
        }
      } else if (change.newQuantity > 0) {
        await tx.insert(stockTransferItems).values({
          transferId,
          stockItemId: change.stockItemId,
          sourceLocationId: change.sourceLocationId,
          quantity: toMoney(change.newQuantity).toFixed(3),
          rate: toMoney(change.rate).toFixed(2),
          totalAmount: lineAmount(change.newQuantity, change.rate).toFixed(2),
          valueMoved: valueMoved ?? null,
        });
      }

      if (inventoryApplied && Math.abs(change.delta) >= 0.0005) {
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

    await postTransferResidualTx(tx, {
      companyId,
      transferId,
      date: reversalDate(),
      reference: `Transfer ${transferId}`,
      deltas,
    });

    const finalItems = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    const totalAmount = finalItems
      .reduce((sum, item) => sum.plus(lineAmount(item.quantity, item.rate)), new MoneyDecimal(0))
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
    return finish({
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
    });
  };
  // Batch callers share one parent transaction so either every transfer is
  // approved or none of their inventory, voucher, or audit changes commit.
  return existingTx ? executeApproval(existingTx) : db.transaction(executeApproval);
}
