import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { companies, inventory } from "@shared/schema";

import { db } from "../../db";
import { adjustInventory } from "../../inventoryHelper";
import { getErrorMessage } from "../../lib/httpHandlers";
import { inventoryQuantity } from "../../lib/inventoryMath";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import {
  inventoryMovementLine,
  postInventoryMovementJournalTx,
} from "../../services/accounting/perpetualInventory/inventoryMovementJournal";
import { writeAuditEvent } from "../../services/audit";
import { storage } from "../../storage";
import { InventoryRouteError } from "./inventoryErrors";
import type { InventoryAuditActor, QuickAdjustmentInput } from "./inventoryRequestContext";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export async function quickAdjustInventory(companyId: number, input: QuickAdjustmentInput, actor: InventoryAuditActor) {
  const [company] = await db
    .select({ companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (company?.companyType === "supplier_partner") {
    throw new InventoryRouteError(403, "Supplier Partner companies must use SP Sales / SP Containers for this action.");
  }

  const [location, stockItem] = await Promise.all([
    storage.getLocationById(input.locationId),
    storage.getStockItemById(input.stockItemId),
  ]);
  if (!location) throw new InventoryRouteError(404, "Location not found");
  if (location.companyId !== companyId) {
    throw new InventoryRouteError(403, "Location belongs to a different company");
  }
  if (!stockItem) throw new InventoryRouteError(404, "Stock item not found");
  if (stockItem.companyId !== companyId) {
    throw new InventoryRouteError(403, "Stock item belongs to a different company");
  }

  let result;
  try {
    result = await db.transaction(async (tx) => {
      const [existingInventory] = await tx
        .select()
        .from(inventory)
        .where(and(eq(inventory.stockItemId, input.stockItemId), eq(inventory.locationId, input.locationId)))
        .limit(1);

      const normalizedQuantity = Number.parseFloat(inventoryQuantity(input.quantity));
      if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
        throw new InventoryRouteError(400, "Quantity must be at least 0.001 units.");
      }

      const currentQuantity = existingInventory ? Number.parseFloat(existingInventory.quantity || "0") : 0;
      const adjustedQuantity = input.type === "add" ? normalizedQuantity : -normalizedQuantity;
      const newQuantity = currentQuantity + adjustedQuantity;
      if (newQuantity < 0) {
        throw new InventoryRouteError(
          400,
          `Cannot subtract ${normalizedQuantity} units. Only ${currentQuantity} units available at this location.`
        );
      }

      const preAdjustmentRate = existingInventory ? Number.parseFloat(existingInventory.averageRate || "0") : 0;
      const adjustment = await adjustInventory(tx, input.locationId, input.stockItemId, adjustedQuantity, companyId);
      const operationId = randomUUID();
      const movementUnitCost =
        input.type === "subtract" && Number.isFinite(preAdjustmentRate)
          ? Math.max(preAdjustmentRate, 0)
          : adjustment.averageRate;
      await postStockMovementTx(
        tx,
        {
          companyId,
          stockItemId: input.stockItemId,
          kind: "adjustment",
          quantity: inventoryQuantity(normalizedQuantity),
          unitCost: String(movementUnitCost),
          fromLocationId: input.type === "subtract" ? input.locationId : undefined,
          toLocationId: input.type === "add" ? input.locationId : undefined,
          occurredAt: new Date().toISOString(),
          source: {
            sourceType: "inventory_quick_adjustment",
            sourceId: operationId,
            idempotencyKey: `inventory-quick-adjust:${companyId}:${operationId}`,
          },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
      // Wave 11: under perpetual inventory the ledger moves with the sub-ledger
      // (Dr/Cr Inventory against INVENTORY_ADJUSTMENT), in this transaction.
      const journal = await postInventoryMovementJournalTx(tx, {
        companyId,
        sourceType: "quick-adjust",
        sourceId: operationId,
        date: new Date().toISOString().slice(0, 10),
        reference: `${stockItem.code} @ ${location.name}`,
        lines: [inventoryMovementLine(adjustment, { stockItemId: input.stockItemId, locationId: input.locationId })],
        offsetAccountCode: "INVENTORY_ADJUSTMENT",
        narration: "Inventory quick adjustment",
        actor,
        locationId: input.locationId,
      });
      // The audit is written with the movement: both commit or neither does.
      await writeAuditEvent(
        {
          ...actor,
          companyId,
          action: "update",
          tableName: "inventory",
          recordId: stockItem.id,
          recordIdentifier: `${stockItem.code} @ ${location.name}`,
          changes: {
            item: { old: stockItem.code, new: stockItem.code },
            location: { new: location.name },
            adjustmentType: { new: input.type === "add" ? "Add Stock" : "Subtract Stock" },
            quantity: { old: String(adjustment.previousQuantity), new: String(adjustment.newQuantity) },
            adjustment: { new: `${input.type === "add" ? "+" : "-"}${Math.abs(adjustedQuantity)}` },
            valueDelta: { new: adjustment.valueDelta },
            ...(journal ? { journal: { new: journal.voucherNumber } } : {}),
          },
        },
        tx
      );
      return {
        currentQuantity: adjustment.previousQuantity,
        newQuantity: adjustment.newQuantity,
        adjustedQuantity,
      };
    });
  } catch (error: unknown) {
    if (error instanceof InventoryRouteError) throw error;
    const message = getErrorMessage(error);
    if (message?.includes("Cannot subtract") || message?.includes("non-existent inventory")) {
      throw new InventoryRouteError(400, message);
    }
    throw error;
  }

  return {
    message: `Successfully ${input.type === "add" ? "added" : "subtracted"} ${input.quantity} units. New quantity: ${result.newQuantity}`,
    previousQuantity: result.currentQuantity,
    newQuantity: result.newQuantity,
    adjustment: result.adjustedQuantity,
  };
}
