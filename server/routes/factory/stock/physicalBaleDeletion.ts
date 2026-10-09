/**
 * One authoritative physical-bale deletion transaction for ALL factory entry
 * points. The caller must acquire the company Priority Scan advisory lock
 * before calling this helper. No inventory writes are allowed outside this
 * transaction; the physical bale, order links, scan reversals, canonical
 * movement and daybook must commit or fail as a single unit.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  customerOrderBaleRemovals,
  customerOrderBales,
  customerOrders,
  factoryBaleProducts,
  factoryBales,
  factoryDailyBaleScans,
  factoryPhysicalBaleDeletions,
  inventory,
  stockItems,
} from "@shared/schema";
import { adjustInventory } from "../../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { writeDaybookEntry } from "../_helpers";
import { reversePriorityAllocationForDeletedBaleTx } from "../customer-orders/priorityAutoAllocation";
import type { PriorityScanTransaction } from "../customer-orders/priorityScanQueue";

const movementAdapter = createDatabaseStockMovementAdapter();

export interface PhysicalBaleDeletionArgs {
  companyId: number;
  baleIds: number[];
  actorId: string | null;
  actorName: string;
  reason: string;
  businessDate: string;
}
export type DeletedPhysicalBale = typeof factoryBales.$inferSelect;

/**
 * Queue lock must already be held. Explicitly reject duplicates, deleted
 * records, wrong-company IDs and finalized loading links rather than
 * acknowledging a partial batch.
 */
export async function deletePhysicalFactoryBalesTx(
  tx: PriorityScanTransaction,
  args: PhysicalBaleDeletionArgs
): Promise<DeletedPhysicalBale[]> {
  const { companyId, baleIds, actorId, actorName, reason, businessDate } = args;
  if (!Array.isArray(baleIds) || baleIds.length < 1 ||
      baleIds.some(id => !Number.isSafeInteger(id) || id < 1) ||
      new Set(baleIds).size !== baleIds.length) {
    throw new Error("Provide unique positive bale IDs");
  }
  const original = await tx.select().from(factoryBales)
    .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));
  if (original.length !== baleIds.length ||
      original.some(b => !!b.deletedAt || b.status === "DELETED" || b.status === "REMOVED")) {
    throw new Error("One or more bales do not exist, are already deleted, or belong to another company");
  }

  const removed: DeletedPhysicalBale[] = [];
  // Preserve caller order; lock the customer/proforma through the reversal
  // service before taking a bale row lock (same hierarchy as Priority Scan).
  for (const baleId of baleIds) {
    const originalBale = original.find(b => b.id === baleId)!;
    const links = await tx.select({
      orderId: customerOrderBales.orderId,
      status: customerOrders.status,
    }).from(customerOrderBales)
      .innerJoin(customerOrders, eq(customerOrders.id, customerOrderBales.orderId))
      .where(and(eq(customerOrderBales.baleId, baleId),
        eq(customerOrders.companyId, companyId)));
    if (links.some(link => !["DRAFT", "LOADING"].includes(link.status))) {
      throw new Error("Cannot physically delete a bale in a verified or finalized loading. Use the approved financial reversal first.");
    }
    if (["SOLD", "DISPATCHED"].includes(originalBale.status)) {
      throw new Error("Cannot physically delete a sold/dispatched bale. Use the controlled return process first.");
    }

    // Remove all live loading links, recalculate totals, mark historic Priority
    // Scan allocations reversed and reopen satisfied priorities as required.
    await reversePriorityAllocationForDeletedBaleTx(tx, {
      companyId, baleId, actor: actorName, actorId, reason,
    });

    if (links.length > 0) {
      await tx.insert(customerOrderBaleRemovals).values(links.map(link => ({
        orderId: link.orderId,
        baleId,
        referenceNumber: originalBale.referenceNumber,
        articleCode: originalBale.articleCode || null,
        productName: originalBale.productName || null,
        weightKg: originalBale.weightKg,
        removedByUserId: actorId,
        removedByUsername: actorName,
      })));
    }

    const [locked] = await tx.select().from(factoryBales)
      .where(and(eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId)))
      .for("update");
    if (!locked || !!locked.deletedAt || ["DELETED", "REMOVED"].includes(locked.status)) {
      throw new Error("Bale was already removed. No additional stock reversal was made.");
    }
    if (locked.status !== originalBale.status || locked.erpLocationId !== originalBale.erpLocationId) {
      throw new Error("Bale stock status or location changed during removal; retry.");
    }

    // V5 linked bales remain physically IN_STOCK, even though the customer
    // loading counts them. There must be ONE ERP decrement per physical bale.
    if (locked.status === "IN_STOCK") {
      if (!locked.erpLocationId) throw new Error("In-stock bale is missing its ERP location");
      const [product] = locked.productId
        ? await tx.select({
            articleCode: factoryBaleProducts.articleCode,
            code: factoryBaleProducts.code,
          }).from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.companyId, companyId),
            eq(factoryBaleProducts.id, locked.productId))).limit(1)
        : [];
      const itemCode = product?.articleCode || product?.code || locked.articleCode || locked.baleCode;
      if (!itemCode) throw new Error("In-stock bale has no ERP stock item code");
      const [item] = await tx.select({ id: stockItems.id }).from(stockItems)
        .where(and(eq(stockItems.companyId, companyId), eq(stockItems.code, itemCode))).limit(1);
      if (!item) {
        throw new Error(`Cannot remove ${locked.referenceNumber}: ERP stock item is missing`);
      }
      const [balance] = await tx.select({ averageRate: inventory.averageRate })
        .from(inventory).where(and(
          eq(inventory.companyId, companyId),
          eq(inventory.locationId, locked.erpLocationId),
          eq(inventory.stockItemId, item.id),
        )).limit(1);
      if (!balance) throw new Error("No ERP inventory balance exists for this stock bale");
      const rawCost = Number(balance.averageRate || 0);
      const unitCost = Number.isFinite(rawCost) ? Math.max(0, rawCost) : 0;
      await adjustInventory(tx, locked.erpLocationId, item.id, -1, companyId);
      await postStockMovementTx(tx, {
        companyId,
        stockItemId: item.id,
        kind: "adjustment",
        quantity: "1",
        unitCost: String(unitCost),
        fromLocationId: locked.erpLocationId,
        occurredAt: new Date().toISOString(),
        source: {
          sourceType: "factory_bale_removal",
          sourceId: String(baleId),
          idempotencyKey: `factory-bale-removal:${companyId}:${baleId}`,
        },
        actor: { userId: actorId, username: actorName, reason },
        allowNegativeStock: true,
      }, movementAdapter);
    }

    // The daily scan table is an active count of produced/scanned bales. The
    // permanent Priority Scan history remains untouched except for reversal
    // metadata, so no evidence of the original allocation is lost.
    await tx.delete(factoryDailyBaleScans).where(and(
      eq(factoryDailyBaleScans.companyId, String(companyId)),
      eq(factoryDailyBaleScans.referenceNumber, locked.referenceNumber),
    ));

    await tx.insert(factoryPhysicalBaleDeletions).values({
      companyId,
      baleId,
      referenceNumber: locked.referenceNumber,
      previousStatus: locked.status,
      originalLocationId: locked.erpLocationId,
      removedByUserId: actorId,
      removedByName: actorName,
      reason,
    });

    const now = new Date();
    const [updated] = await tx.update(factoryBales)
      .set({ status: "DELETED", deletedAt: now, updatedAt: now })
      .where(and(eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId),
        isNull(factoryBales.deletedAt)))
      .returning();
    if (!updated) throw new Error("Bale deletion conflicted with another stock operation");
    removed.push(updated);
  }

  const metaJson = JSON.stringify({
    bales: removed.map(b => ({
      id: b.id,
      ref: b.referenceNumber,
      productName: b.productName || b.articleCode || "Unknown",
      weightKg: b.weightKg,
      status: "DELETED",
    })),
    actorId, actorName, reason,
  });
  await writeDaybookEntry(tx, {
    companyId, txDate: businessDate, txType: "BALE_REMOVAL",
    description: `Removed ${removed.length} bale(s) from factory stock. Supervisor: ${actorName}. Reason: ${reason}`,
    metaJson,
  });
  return removed;
}
