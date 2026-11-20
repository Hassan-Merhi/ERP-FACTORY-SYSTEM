import type { Express } from "express";
import { and, desc, eq } from "drizzle-orm";
import { retailStockMovements, retailStockOperations } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { retailLocationRefusal } from "./retailLocationAccess";
import { currentUserId, ensureCompanyLocation, requireRetailCompany, toNumber } from "./retailPosContext";
import {
  addMovement,
  lockInventoryRow,
  nextAverageCost,
  setInventoryQuantity,
} from "../../services/retail/retailStockLedger";
import { trackRetailStockValueTx } from "../../services/retail/retailInventoryJournal";
import { ensureRetailVariant } from "../../services/retail/retailSaleService";
import { nextRetailTransferQuantities } from "../../services/retail/retailStockMath";
import { registerRetailPosCancellationRoute } from "./retailPosCancellationRoutes";
import { validateRequest, validatedInput } from "../../lib/validateRequest";
import { adjustmentInput, registerRetailPosRoutesPart1, transferInput } from "./registerRetailPosRoutesPart1";
import { registerRetailPosRoutesPart2 } from "./registerRetailPosRoutesPart2";

export function registerRetailPosRoutes(app: Express): void {
  registerRetailPosRoutesPart1(app);
  registerRetailPosRoutesPart2(app);
  registerRetailPosRoutesPart3(app);
}

function registerRetailPosRoutesPart3(app: Express) {
  app.post("/api/pos/retail/transfers", requireAuth, validateRequest(transferInput), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = validatedInput(req, transferInput).body;
      if (req.user?.role === "POS") return res.status(403).json({ message: "POS users cannot transfer retail stock" });
      if (body.fromLocationId === body.toLocationId)
        return res.status(400).json({ message: "Transfer locations must be different" });
      // An immediate transfer both ships and receives, so both stores must be the user's.
      const locationRefusal = await retailLocationRefusal(req, companyId, [body.fromLocationId, body.toLocationId]);
      if (locationRefusal)
        return res.status(403).json({ code: "RETAIL_LOCATION_NOT_ASSIGNED", message: locationRefusal });
      await Promise.all([
        ensureCompanyLocation(companyId, body.fromLocationId),
        ensureCompanyLocation(companyId, body.toLocationId),
        ensureRetailVariant(db, companyId, body.variantId),
      ]);
      const userId = currentUserId(req);
      const canSellNegativeStock = Boolean(req.user?.canSellNegativeStock);

      const result = await db.transaction(async (tx) => {
        const [operation] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "transfer",
            idempotencyKey: body.idempotencyKey,
            createdBy: userId,
            metadata: {
              fromLocationId: body.fromLocationId,
              toLocationId: body.toLocationId,
              notes: body.notes ?? null,
            },
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!operation) return { replayed: true };

        const orderedLocationIds = [body.fromLocationId, body.toLocationId].sort((a, b) => a - b);
        for (const locationId of orderedLocationIds) await lockInventoryRow(tx, companyId, body.variantId, locationId);
        const source = await lockInventoryRow(tx, companyId, body.variantId, body.fromLocationId);
        const destination = await lockInventoryRow(tx, companyId, body.variantId, body.toLocationId);
        const stockValue = await trackRetailStockValueTx(tx, companyId, [
          { variantId: body.variantId, locationId: body.fromLocationId },
          { variantId: body.variantId, locationId: body.toLocationId },
        ]);
        let sourceAfter: number;
        let destinationAfter: number;
        try {
          ({ sourceAfter, destinationAfter } = nextRetailTransferQuantities(
            source.quantity,
            destination.quantity,
            body.quantity,
            canSellNegativeStock
          ));
        } catch {
          throw new Error(`Insufficient stock for transfer. Available: ${source.quantity}`);
        }
        await setInventoryQuantity(tx, companyId, body.variantId, body.fromLocationId, sourceAfter);
        // Wave 17 (D): the destination takes the units at the source's cost (value-exact), blended into its average.
        await setInventoryQuantity(
          tx,
          companyId,
          body.variantId,
          body.toLocationId,
          destinationAfter,
          nextAverageCost(destination.quantity, destination.averageCost, body.quantity, source.averageCost)
        );
        await addMovement(tx, {
          companyId,
          variantId: body.variantId,
          locationId: body.fromLocationId,
          movementType: "transfer_out",
          quantityDelta: -body.quantity,
          before: source.quantity,
          after: sourceAfter,
          eventKey: `transfer:${operation.id}:out`,
          referenceType: "retail_transfer",
          referenceId: operation.id,
          createdBy: userId,
          metadata: { toLocationId: body.toLocationId },
        });
        await addMovement(tx, {
          companyId,
          variantId: body.variantId,
          locationId: body.toLocationId,
          movementType: "transfer_in",
          quantityDelta: body.quantity,
          before: destination.quantity,
          after: destinationAfter,
          eventKey: `transfer:${operation.id}:in`,
          referenceType: "retail_transfer",
          referenceId: operation.id,
          createdBy: userId,
          metadata: { fromLocationId: body.fromLocationId },
        });
        await stockValue.post({
          kind: "transfer",
          sourceId: operation.id,
          description: `Retail stock transfer #${operation.id}`,
          actor: { userId, username: req.user?.username ?? null },
        });
        return {
          replayed: false,
          operationId: operation.id,
          sourceQuantity: sourceAfter,
          destinationQuantity: destinationAfter,
        };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("Insufficient stock") ? 409 : 400).json({ message });
    }
  });

  app.post("/api/pos/retail/adjustments", requireAuth, validateRequest(adjustmentInput), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      if (req.user?.role === "POS") return res.status(403).json({ message: "POS users cannot make stock adjustments" });
      const body = validatedInput(req, adjustmentInput).body;
      await Promise.all([
        ensureCompanyLocation(companyId, body.locationId),
        ensureRetailVariant(db, companyId, body.variantId),
      ]);
      const userId = currentUserId(req);
      const result = await db.transaction(async (tx) => {
        const [operation] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "adjustment",
            idempotencyKey: body.idempotencyKey,
            createdBy: userId,
            metadata: { reason: body.reason },
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!operation) return { replayed: true };
        const stock = await lockInventoryRow(tx, companyId, body.variantId, body.locationId);
        const stockValue = await trackRetailStockValueTx(tx, companyId, [
          { variantId: body.variantId, locationId: body.locationId },
        ]);
        const after = stock.quantity + body.quantityDelta;
        if (after < -0.000001 && !req.user?.canSellNegativeStock) {
          throw new Error(`Insufficient stock for adjustment. Available: ${stock.quantity}`);
        }
        await setInventoryQuantity(tx, companyId, body.variantId, body.locationId, after);
        await addMovement(tx, {
          companyId,
          variantId: body.variantId,
          locationId: body.locationId,
          movementType: "adjustment",
          quantityDelta: body.quantityDelta,
          before: stock.quantity,
          after,
          eventKey: `adjustment:${operation.id}`,
          referenceType: "retail_adjustment",
          referenceId: operation.id,
          createdBy: userId,
          metadata: { reason: body.reason, reference: body.reference ?? null },
        });
        // Wave 17 (D): Dr/Cr Retail inventory against RETAIL-INVENTORY-ADJUSTMENT at the row's cost.
        await stockValue.post({
          kind: "adjustment",
          sourceId: operation.id,
          description: `Retail stock adjustment #${operation.id} · ${body.reason}`,
          actor: { userId, username: req.user?.username ?? null },
        });
        return { replayed: false, operationId: operation.id, quantity: after };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("Insufficient stock") ? 409 : 400).json({ message });
    }
  });

  registerRetailPosCancellationRoute(app);

  app.get("/api/pos/retail/movements", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const locationId = Number(req.query.locationId);
      const rows = await db
        .select()
        .from(retailStockMovements)
        .where(
          and(
            eq(retailStockMovements.companyId, companyId),
            Number.isInteger(locationId) && locationId > 0 ? eq(retailStockMovements.locationId, locationId) : undefined
          )
        )
        .orderBy(desc(retailStockMovements.createdAt))
        .limit(limit);
      res.json(
        rows.map((row) => ({
          ...row,
          quantityDelta: toNumber(row.quantityDelta),
          quantityBefore: toNumber(row.quantityBefore),
          quantityAfter: toNumber(row.quantityAfter),
        }))
      );
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
