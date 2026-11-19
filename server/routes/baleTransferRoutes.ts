/**
 * Bale-transfer routes.
 *
 * Inter-location bale transfers (list, create, detail, complete, delete,
 * update). Extracted from baleRoutes.ts as a sub-registrar; behaviour is
 * unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { strictIds } from "./helpers/companyOwnership";
import { baleTransfers, baleTransferItems, productionBales } from "@shared/schema";
import { registerBaleTransferRoutesPart1, allBalesOwned } from "./registerBaleTransferRoutesPart1";

/** The transfer when it belongs to `companyId`; every route by id goes through this. */
async function ownTransfer(transferId: number, companyId: number) {
  const [transfer] = await db
    .select()
    .from(baleTransfers)
    .where(and(eq(baleTransfers.id, transferId), eq(baleTransfers.companyId, companyId)));
  return transfer;
}

export function registerBaleTransferRoutes(app: Express) {
  // Bale Transfer Routes
  app.get("/api/bale-transfers", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const transfers = await db
        .select({
          id: baleTransfers.id,
          companyId: baleTransfers.companyId,
          sourceLocationId: baleTransfers.sourceLocationId,
          destinationLocationId: baleTransfers.destinationLocationId,
          transferDate: baleTransfers.transferDate,
          notes: baleTransfers.notes,
          createdBy: baleTransfers.createdBy,
          updatedBy: baleTransfers.updatedBy,
          status: baleTransfers.status,
          createdAt: baleTransfers.createdAt,
          updatedAt: baleTransfers.updatedAt,
          sourceLocationName: sql<string>`(SELECT name FROM locations WHERE id = ${baleTransfers.sourceLocationId})`,
          destinationLocationName: sql<string>`(SELECT name FROM locations WHERE id = ${baleTransfers.destinationLocationId})`,
          itemCount: sql<number>`(SELECT COUNT(*) FROM bale_transfer_items WHERE transfer_id = ${baleTransfers.id})::int`,
        })
        .from(baleTransfers)
        .where(eq(baleTransfers.companyId, companyId))
        .orderBy(desc(baleTransfers.createdAt));

      res.json(transfers);
    } catch (error: unknown) {
      logger.error("Error fetching bale transfers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerBaleTransferRoutesPart1(app);

  app.patch("/api/bale-transfers/:id/complete", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const transferId = parseInt(req.params.id);
      if (isNaN(transferId)) return res.status(400).json({ message: "Invalid transfer ID" });

      const transfer = await ownTransfer(transferId, companyId);

      if (!transfer) return res.status(404).json({ message: "Transfer not found" });

      const [updated] = await db
        .update(baleTransfers)
        .set({
          status: "COMPLETED",
          updatedBy: req.session.username || "system",
          updatedAt: sql`now()`,
        })
        .where(eq(baleTransfers.id, transferId))
        .returning();

      res.json({ success: true, transfer: updated });
    } catch (error: unknown) {
      logger.error("Error completing bale transfer:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/bale-transfers/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const transferId = parseInt(req.params.id);
      if (isNaN(transferId)) return res.status(400).json({ message: "Invalid transfer ID" });

      const transfer = await ownTransfer(transferId, companyId);

      if (!transfer) return res.status(404).json({ message: "Transfer not found" });

      if (transfer.status !== "PENDING") {
        return res.status(400).json({ message: "Only PENDING transfers can be deleted" });
      }

      await db.transaction(async (tx) => {
        const items = await tx.select().from(baleTransferItems).where(eq(baleTransferItems.transferId, transferId));

        for (const item of items) {
          await tx
            .update(productionBales)
            .set({
              locationId: transfer.sourceLocationId,
              updatedAt: sql`now()`,
            })
            .where(and(eq(productionBales.id, item.productionBaleId), eq(productionBales.companyId, companyId)));
        }

        await tx.delete(baleTransferItems).where(eq(baleTransferItems.transferId, transferId));
        await tx.delete(baleTransfers).where(eq(baleTransfers.id, transferId));
      });

      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting bale transfer:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/bale-transfers/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { items, status, notes } = req.body;
      const transferId = parseInt(req.params.id, 10);
      if (isNaN(transferId)) return res.status(400).json({ message: "Invalid transfer ID" });
      if (!(await ownTransfer(transferId, companyId))) return res.status(404).json({ message: "Transfer not found" });

      if (Array.isArray(items)) {
        // Edited lines must be lines of this transfer; new lines must add this company's bales.
        const editedIds = strictIds(items.map((item: { id?: unknown }) => item?.id));
        if (editedIds === null) return res.status(404).json({ message: "Transfer not found" });
        if (editedIds.length > 0) {
          const lines = await db
            .select({ id: baleTransferItems.id })
            .from(baleTransferItems)
            .where(and(eq(baleTransferItems.transferId, transferId), inArray(baleTransferItems.id, editedIds)));
          if (lines.length !== editedIds.length) return res.status(404).json({ message: "Transfer not found" });
        }
        const addedBaleIds = items
          .filter((item: { id?: unknown }) => !item?.id)
          .map((item: { productionBaleId?: unknown }) => item?.productionBaleId);
        if (!(await allBalesOwned(companyId, addedBaleIds))) return res.status(400).json({ message: "Bale not found" });
      }

      await storage.updateBaleTransfer(transferId, {
        status,
        notes,
        updatedBy: req.session.username || "system",
      });

      if (items) {
        for (const item of items) {
          if (item.id) {
            await storage.updateBaleTransferItem(item.id, {
              weightKg: item.weightKg.toString(),
              costPerKg: item.costPerKg.toString(),
              totalCost: item.totalCost.toString(),
            });
          } else {
            await storage.createBaleTransferItem({
              transferId,
              productionBaleId: item.productionBaleId,
              quantity: item.quantity,
              weightKg: item.weightKg.toString(),
              costPerKg: item.costPerKg.toString(),
              totalCost: item.totalCost.toString(),
            });
          }
        }
      }

      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
