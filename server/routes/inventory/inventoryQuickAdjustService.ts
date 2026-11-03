import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { companies } from "@shared/schema";

import { db } from "../../db";
import { capturePhase9StockAdjustTx } from "../../edge/phase9StockOutbox";
import { getErrorMessage } from "../../lib/httpHandlers";
import { storage } from "../../storage";
import { InventoryRouteError } from "./inventoryErrors";
import { applyQuickAdjustmentCoreTx } from "./inventoryQuickAdjustCore";
import type { InventoryAuditActor, QuickAdjustmentInput } from "./inventoryRequestContext";

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
      const operationId = randomUUID();
      const occurredAt = new Date().toISOString();
      const applied = await applyQuickAdjustmentCoreTx(tx, {
        companyId,
        stockItem: { id: stockItem.id, code: stockItem.code },
        location: { id: location.id, name: location.name },
        direction: input.type,
        quantity: input.quantity,
        actor,
        operationId,
        occurredAt,
        allowNegative: false,
      });
      // On the factory LAN server this records the committed movement for
      // cloud replay in the same transaction; elsewhere it does nothing.
      await capturePhase9StockAdjustTx(tx, {
        companyId,
        localMovementId: applied.movementId,
        stockItemId: stockItem.id,
        locationId: location.id,
        actorUserId: String(actor.userId),
        actorUsername: actor.username,
        requestId: operationId,
        direction: input.type,
        quantity: applied.normalizedQuantity,
        occurredAt,
        businessDate: occurredAt.slice(0, 10),
      });
      return {
        currentQuantity: applied.previousQuantity,
        newQuantity: applied.newQuantity,
        adjustedQuantity: applied.adjustedQuantity,
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
