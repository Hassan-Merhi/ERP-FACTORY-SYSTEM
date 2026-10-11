/**
 * importRoutes: SilentProduction endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { inventory } from "@shared/schema";
import { getErrorMessage } from "../../lib/httpHandlers";
import { inventoryQuantity, toInventoryDecimal } from "../../lib/inventoryMath";
import { parseMoneyInput } from "../../lib/money";
import { allStockItemsOwned, ownLocationIds } from "../helpers/companyOwnership";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { adjustInventory } from "../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import {
  inventoryMovementLine,
  postInventoryMovementJournalTx,
  type InventoryMovementLine,
} from "../../services/accounting/perpetualInventory/inventoryMovementJournal";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerSilentProductionRoutes(app: Express) {
  // POST /api/inventory/silent-production — Developer-only silent production/consumption adjustment
  app.post("/api/inventory/silent-production", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (req.user?.role !== "Developer") {
        return res.status(403).json({ message: "Developer access required" });
      }
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { locationId, type, items } = req.body;
      if (!locationId || !type || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "locationId, type, and items are required" });
      }
      if (type !== "Production" && type !== "Consumption") {
        return res.status(400).json({ message: "type must be Production or Consumption" });
      }

      const locId = parseInt(locationId);
      // Body ids are outside the path-based company scope: check them here.
      if (!(await ownLocationIds(companyId, [locId])).has(locId)) {
        return res.status(400).json({ message: "Location not found" });
      }
      if (
        !(await allStockItemsOwned(
          companyId,
          items.map((item: { stockItemId?: unknown }) => item?.stockItemId)
        ))
      ) {
        return res.status(400).json({ message: "Stock item not found" });
      }
      const operationId = randomUUID();
      const occurredAt = new Date().toISOString();
      let applied = 0;

      await db.transaction(async (tx) => {
        const movementLines: InventoryMovementLine[] = [];
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const parsedQty = parseMoneyInput(item.quantity);
          const normalizedQty = parsedQty ? Number(inventoryQuantity(parsedQty.abs())) : 0;
          const parsedRate = parseMoneyInput(item.rate || "0");
          const rate = parsedRate && parsedRate.gte(0) ? parsedRate.toNumber() : 0;
          if (normalizedQty <= 0 || !item.stockItemId) continue;

          const stockItemId = parseInt(item.stockItemId);
          if (!Number.isInteger(stockItemId) || stockItemId <= 0) continue;

          let movementUnitCost = rate;
          if (type === "Consumption") {
            const [existingInventory] = await tx
              .select({ averageRate: inventory.averageRate })
              .from(inventory)
              .where(and(eq(inventory.stockItemId, stockItemId), eq(inventory.locationId, locId)))
              .limit(1);
            movementUnitCost = Math.max(toInventoryDecimal(existingInventory?.averageRate).toNumber(), 0);
          }

          const delta = type === "Production" ? normalizedQty : -normalizedQty;
          const adjustment = await adjustInventory(
            tx,
            locId,
            stockItemId,
            delta,
            companyId,
            type === "Production" ? rate : undefined
          );
          movementLines.push(inventoryMovementLine(adjustment, { stockItemId, locationId: locId }));
          await postStockMovementTx(
            tx,
            {
              companyId,
              stockItemId,
              kind: "adjustment",
              quantity: inventoryQuantity(normalizedQty),
              unitCost: String(movementUnitCost),
              fromLocationId: type === "Consumption" ? locId : undefined,
              toLocationId: type === "Production" ? locId : undefined,
              occurredAt,
              source: {
                sourceType: type === "Production" ? "silent_production" : "silent_consumption",
                sourceId: operationId,
                idempotencyKey: `silent-production:${companyId}:${operationId}:${index}:${stockItemId}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
          applied++;
        }
        // Wave 11: under perpetual inventory the ledger moves with the sub-ledger.
        await postInventoryMovementJournalTx(tx, {
          companyId,
          sourceType: type === "Production" ? "silent-production" : "silent-consumption",
          sourceId: operationId,
          date: occurredAt.slice(0, 10),
          reference: `${type} ${operationId.slice(0, 8)}`,
          lines: movementLines,
          offsetAccountCode: "INVENTORY_ADJUSTMENT",
          narration: type === "Production" ? "Silent production" : "Silent consumption",
          actor: req.user ? { userId: String(req.user.id), username: String(req.user.username) } : null,
          locationId: locId,
        });
      });

      res.json({ success: true, applied, type });
    } catch (err: unknown) {
      logger.error("Silent production/consumption error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
