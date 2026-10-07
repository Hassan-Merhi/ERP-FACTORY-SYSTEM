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
import { sumMoney } from "../lib/money";
import { ownLocationIds, positiveIds } from "./helpers/companyOwnership";
import {
  baleTransfers,
  baleTransferItems,
  baleProducts,
  productionBales,
  factorySettings as fSettings,
  factoryDaybookEntries as fde,
} from "@shared/schema";

/** The transfer when it belongs to `companyId`; every route by id goes through this. */
async function ownTransfer(transferId: number, companyId: number) {
  const [transfer] = await db
    .select()
    .from(baleTransfers)
    .where(and(eq(baleTransfers.id, transferId), eq(baleTransfers.companyId, companyId)));
  return transfer;
}

/** True when every production bale id is a bale of `companyId`. */
async function allBalesOwned(companyId: number, baleIds: readonly unknown[]): Promise<boolean> {
  const ids = positiveIds(baleIds);
  if (ids.length !== baleIds.length) return false;
  if (ids.length === 0) return true;
  const rows = await db
    .select({ id: productionBales.id })
    .from(productionBales)
    .where(and(eq(productionBales.companyId, companyId), inArray(productionBales.id, ids)));
  return rows.length === ids.length;
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

  app.post("/api/bale-transfers", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { sourceLocationId, destinationLocationId, transferDate, notes, items } = req.body;

      if (
        !sourceLocationId ||
        !destinationLocationId ||
        !transferDate ||
        !items ||
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return res.status(400).json({
          message: "Missing required fields: sourceLocationId, destinationLocationId, transferDate, and items array",
        });
      }
      // Locations and bales come from the body, outside the path-based company
      // scope: all of them must belong to this company before anything moves.
      const ownedLocations = await ownLocationIds(companyId, [sourceLocationId, destinationLocationId]);
      if (!ownedLocations.has(Number(sourceLocationId)) || !ownedLocations.has(Number(destinationLocationId))) {
        return res.status(400).json({ message: "Location not found" });
      }
      if (
        !(await allBalesOwned(
          companyId,
          items.map((item: { productionBaleId?: unknown }) => item?.productionBaleId)
        ))
      ) {
        return res.status(400).json({ message: "Bale not found" });
      }
      const createdBy = req.session.username || "system";

      const result = await db.transaction(async (tx) => {
        const [transfer] = await tx
          .insert(baleTransfers)
          .values({
            companyId,
            sourceLocationId,
            destinationLocationId,
            transferDate,
            notes: notes || null,
            createdBy,
            status: "PENDING",
          })
          .returning();

        for (const item of items) {
          await tx.insert(baleTransferItems).values({
            transferId: transfer.id,
            productionBaleId: item.productionBaleId,
            quantity: item.quantity || 1,
            weightKg: item.weightKg.toString(),
            costPerKg: item.costPerKg.toString(),
            totalCost: item.totalCost.toString(),
          });

          await tx
            .update(productionBales)
            .set({
              locationId: destinationLocationId,
              status: "IN_STOCK",
              updatedAt: sql`now()`,
            })
            .where(and(eq(productionBales.id, item.productionBaleId), eq(productionBales.companyId, companyId)));
        }

        return transfer;
      });

      // Write to factory daybook if this company has factory settings
      try {
        const [fSetting] = await db.select().from(fSettings).where(eq(fSettings.companyId, companyId));
        if (fSetting) {
          const totalCost = sumMoney(items.map((it: { totalCost?: string | number | null }) => it.totalCost)).toFixed(
            2
          );
          await db.insert(fde).values({
            companyId,
            txDate: transferDate,
            txType: "BALE_TRANSFER",
            referenceId: result.id,
            referenceTable: "bale_transfers",
            description: notes || `Bale transfer #${result.id}`,
            currencyCode: "USD",
            amountCurrency: String(totalCost),
            fxRateToUsd: "1",
            amountUsd: String(totalCost),
            createdBy: null,
          });
        }
      } catch (dbErr) {
        logger.error("Factory daybook write failed (non-fatal):", { error: dbErr });
      }

      res.json({ success: true, transferId: result.id, transfer: result });
    } catch (error: unknown) {
      logger.error("Error creating bale transfer:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/bale-transfers/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const transferId = parseInt(req.params.id);
      if (isNaN(transferId)) return res.status(400).json({ message: "Invalid transfer ID" });

      const [transfer] = await db
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
        })
        .from(baleTransfers)
        .where(and(eq(baleTransfers.id, transferId), eq(baleTransfers.companyId, companyId)));

      if (!transfer) return res.status(404).json({ message: "Transfer not found" });

      const items = await db
        .select({
          id: baleTransferItems.id,
          transferId: baleTransferItems.transferId,
          productionBaleId: baleTransferItems.productionBaleId,
          quantity: baleTransferItems.quantity,
          weightKg: baleTransferItems.weightKg,
          costPerKg: baleTransferItems.costPerKg,
          totalCost: baleTransferItems.totalCost,
          createdAt: baleTransferItems.createdAt,
          baleCode: productionBales.baleCode,
          barcodeValue: productionBales.barcodeValue,
          baleCategory: productionBales.category,
          baleGrade: productionBales.grade,
          baleStatus: productionBales.status,
          productName: baleProducts.name,
          productCode: baleProducts.code,
        })
        .from(baleTransferItems)
        .leftJoin(productionBales, eq(baleTransferItems.productionBaleId, productionBales.id))
        .leftJoin(baleProducts, eq(productionBales.productId, baleProducts.id))
        .where(eq(baleTransferItems.transferId, transferId));

      res.json({ ...transfer, items });
    } catch (error: unknown) {
      logger.error("Error fetching bale transfer:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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
        const editedIds = positiveIds(
          items.filter((item: { id?: unknown }) => item?.id).map((item: { id: unknown }) => item.id)
        );
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
