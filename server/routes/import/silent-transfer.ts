/**
 * importRoutes: SilentTransfer endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { inventoryQuantity, toInventoryDecimal } from "../../lib/inventoryMath";
import { parseMoneyInput } from "../../lib/money";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { inventory } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { allStockItemsOwned, ownLocationIds } from "../helpers/companyOwnership";
import type Decimal from "decimal.js";
import { postInventoryMovementJournalTx } from "../../services/accounting/perpetualInventory/inventoryMovementJournal";
import { moveTransferLegConservedTx } from "../../services/inventory/conservedStockTransfer";
import {
  assertNoBaleMirrorMovementTx,
  sendBaleMirrorMovementRefusal,
} from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { sumDecimals } from "../../services/inventory/valueExactReversal";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { registerSilentTransferRoutesPart1 } from "./registerSilentTransferRoutesPart1";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerSilentTransferRoutes(app: Express) {
  registerSilentTransferRoutesPart1(app);

  // Apply the silent transfer — directly updates inventory, no voucher created
  app.post("/api/inventory/silent-transfer/apply", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { sourceLocationId, destinationLocationId, items } = req.body;
      if (!sourceLocationId || !destinationLocationId || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const srcId = parseInt(sourceLocationId);
      const dstId = parseInt(destinationLocationId);
      if (srcId === dstId) return res.status(400).json({ message: "Source and destination must be different" });

      const owned = await ownLocationIds(companyId, [srcId, dstId]);
      if (!owned.has(srcId)) return res.status(400).json({ message: "Source location not found" });
      if (!owned.has(dstId)) return res.status(400).json({ message: "Destination location not found" });

      // Every stock item must belong to the company before anything moves.
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
        // Wave 11: a factory bale-mirror item is moved in the factory after the cut-over.
        await assertNoBaleMirrorMovementTx(
          tx,
          companyId,
          items.map((item: { stockItemId?: unknown }) => item?.stockItemId),
          "silent-transfer"
        );
        const deltas: Decimal[] = [];
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const parsedQty = parseMoneyInput(item.quantity);
          if (!parsedQty) continue;
          const qty = Number(inventoryQuantity(parsedQty));
          if (qty <= 0) continue;

          const stockItemId = parseInt(item.stockItemId);
          if (!Number.isInteger(stockItemId) || stockItemId <= 0) continue;

          const [sourceInventory] = await tx
            .select({ averageRate: inventory.averageRate })
            .from(inventory)
            .where(and(eq(inventory.stockItemId, stockItemId), eq(inventory.locationId, srcId)))
            .limit(1);
          // The source's own average rate; the client's figure only when the source has none.
          const parsedFallbackRate = parseMoneyInput(item.averageRate || "0");
          const fallbackRate = parsedFallbackRate && parsedFallbackRate.gte(0) ? parsedFallbackRate.toNumber() : 0;
          const rate = sourceInventory?.averageRate
            ? Math.max(toInventoryDecimal(sourceInventory.averageRate).toNumber(), 0)
            : fallbackRate;

          // Wave 11: the destination receives exactly the value the source
          // relieved, so the company's stock value is conserved.
          const moved = await moveTransferLegConservedTx(tx, {
            companyId,
            sourceLocationId: srcId,
            destinationLocationId: dstId,
            stockItemId,
            quantity: qty,
            fallbackRate: rate,
          });
          deltas.push(moved.sourceDelta, moved.destinationDelta);
          await postStockMovementTx(
            tx,
            {
              companyId,
              stockItemId,
              kind: "transfer",
              quantity: inventoryQuantity(qty),
              unitCost: moved.rate.toString(),
              fromLocationId: srcId,
              toLocationId: dstId,
              occurredAt,
              source: {
                sourceType: "silent_transfer_import",
                sourceId: operationId,
                idempotencyKey: `silent-transfer:${companyId}:${operationId}:${index}:${stockItemId}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
          applied++;
        }
        // A shortage settled at the destination is the only source of a net.
        await postInventoryMovementJournalTx(tx, {
          companyId,
          sourceType: "silent-transfer",
          sourceId: operationId,
          date: occurredAt.slice(0, 10),
          reference: `Silent transfer ${operationId.slice(0, 8)}`,
          lines: [{ valueDelta: sumDecimals(deltas).toFixed(2) }],
          offsetAccountCode: "COGS",
          narration: "Silent transfer shortage settlement",
          locationId: dstId,
        });
      });

      res.json({ success: true, itemsTransferred: applied });
    } catch (err: unknown) {
      if (sendBaleMirrorMovementRefusal(res, err)) return;
      logger.error("Silent transfer apply error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
