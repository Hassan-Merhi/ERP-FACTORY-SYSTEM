/**
 * stockGroupsItemsRoutes: StockItemBulk endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { logAudit } from "../../_helpers";
import { inventory, stockItems } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  finishStockItemEditCaptureTx,
  stockItemEditRecorder,
  updateStockItemFieldsTx,
} from "../../../services/inventory/stockItemEditCapture";
import { registerStockItemBulkRoutesPart1 } from "./registerStockItemBulkRoutesPart1";

export function registerStockItemBulkRoutes(app: Express) {
  // Bulk delete stock items
  app.post("/api/stock-items/bulk-delete", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { ids: rawIds } = req.body;
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        return res.status(400).json({ message: "Invalid or empty ids array" });
      }
      // Explicitly parse all IDs as integers to prevent "operator does not exist: integer = text"
      const ids = rawIds.map((id) => parseInt(id, 10)).filter((n: number) => !isNaN(n) && n > 0);
      if (ids.length === 0) {
        return res.status(400).json({ message: "No valid numeric IDs provided" });
      }

      // Get all items that exist and belong to the current company
      const validItems = await storage.bulkGetStockItemsByIds(ids, req.session.currentCompanyId);
      const validIds = validItems.map((item) => item.id);

      if (validIds.length === 0) {
        return res.status(404).json({ message: "No valid stock items found to delete" });
      }

      // Block deletion if any item has inventory records (regardless of quantity)
      const inventoryCheck = await db
        .selectDistinct({ stockItemId: inventory.stockItemId })
        .from(inventory)
        .where(inArray(inventory.stockItemId, validIds));
      if (inventoryCheck.length > 0) {
        const blockedIds = new Set(inventoryCheck.map((r) => Number(r.stockItemId)));
        const blockedCodes = validItems.filter((item) => blockedIds.has(item.id)).map((item) => item.code);
        return res.status(400).json({
          message: `Cannot delete ${blockedCodes.length} item(s) — they have existing inventory records: ${blockedCodes.join(", ")}. Please clear all inventory first.`,
        });
      }

      // Phase 21 (B): the soft delete and one audit row per item commit together.
      await db.transaction(async (tx) => {
        await storage.bulkDeleteStockItems(validIds, tx);
        for (const deletedItem of validItems) {
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId: req.session.currentCompanyId!,
              action: "delete",
              tableName: "stock_items",
              recordId: deletedItem.id,
              recordIdentifier: deletedItem.name,
              changes: {
                name: { old: deletedItem.name },
                code: { old: deletedItem.code },
                uom: { old: deletedItem.uom },
              },
            },
            tx
          );
        }
      });

      const skippedCount = ids.length - validIds.length;
      const message =
        skippedCount > 0
          ? `Successfully deleted ${validIds.length} stock item(s). ${skippedCount} item(s) were skipped (not found or belong to another company).`
          : `Successfully deleted ${validIds.length} stock item(s)`;

      res.json({
        message,
        deleted: validIds.length,
        skipped: skippedCount,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bulk assign category to stock items
  app.post("/api/stock-items/bulk-assign-category", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const companyId = req.session.currentCompanyId;
      const { ids: rawIds, categoryId: rawCategoryId } = req.body;
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        return res.status(400).json({ message: "Invalid or empty ids array" });
      }
      const ids = rawIds.map((id) => parseInt(id, 10)).filter((n: number) => !isNaN(n) && n > 0);
      if (ids.length === 0) {
        return res.status(400).json({ message: "No valid numeric IDs provided" });
      }
      // categoryId null means remove category
      const categoryId = rawCategoryId === null || rawCategoryId === undefined ? null : parseInt(rawCategoryId, 10);

      // Verify items belong to this company
      const validItems = await storage.bulkGetStockItemsByIds(ids, companyId);
      const validIds = validItems.map((item) => item.id);
      if (validIds.length === 0) {
        return res.status(404).json({ message: "No valid stock items found" });
      }

      const nextCategoryId = isNaN(categoryId as number) ? null : categoryId;
      const recorder = stockItemEditRecorder("POST /api/stock-items/bulk-assign-category");
      if (recorder.active) {
        // Factory LAN server: per item, recorded for the cloud (owner decision 2026-11-02).
        await db.transaction(async (tx) => {
          for (const id of validIds) await updateStockItemFieldsTx(tx, recorder, id, { categoryId: nextCategoryId });
          await finishStockItemEditCaptureTx(tx, req, recorder);
        });
      } else {
        await db
          .update(stockItems)
          .set({ categoryId: nextCategoryId })
          .where(and(inArray(stockItems.id, validIds), eq(stockItems.companyId, companyId)));
      }

      res.json({ message: `Category updated for ${validIds.length} item(s)`, updated: validIds.length });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerStockItemBulkRoutesPart1(app);

  // Bulk rename stock items
  app.post("/api/stock-items/bulk-rename", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { findText, replaceWith, itemIds, wholeWordOnly, caseInsensitive } = req.body;

      if (!findText || typeof findText !== "string" || findText.trim() === "") {
        return res.status(400).json({ message: "findText is required" });
      }
      if (typeof replaceWith !== "string") {
        return res.status(400).json({ message: "replaceWith is required" });
      }
      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        return res.status(400).json({ message: "itemIds must be a non-empty array" });
      }

      const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = wholeWordOnly ? `\\b${escaped}\\b` : escaped;
      const flags = caseInsensitive !== false ? "gi" : "g";
      const regex = new RegExp(pattern, flags);

      const results: { id: number; oldName: string; newName: string }[] = [];
      const failures: { id: number; name: string; reason: string }[] = [];

      const validItems = await storage.bulkGetStockItemsByIds(
        itemIds.map((id) => Number(id)),
        req.session.currentCompanyId
      );

      const recorder = stockItemEditRecorder("POST /api/stock-items/bulk-rename");
      await db.transaction(async (tx) => {
        for (const item of validItems) {
          const newName = item.name.replace(regex, replaceWith);
          if (newName === item.name) {
            continue;
          }
          if (!newName || newName.trim() === "") {
            failures.push({ id: item.id, name: item.name, reason: "Resulting name would be empty" });
            continue;
          }
          try {
            // A savepoint per item: one refused rename leaves the others.
            await tx.transaction(async (itemTx) => {
              await updateStockItemFieldsTx(itemTx, recorder, item.id, { name: newName });
            });
            results.push({ id: item.id, oldName: item.name, newName });
          } catch (err: unknown) {
            failures.push({ id: item.id, name: item.name, reason: getErrorMessage(err) });
          }
        }
        // Factory LAN server: the renames are recorded for the cloud.
        await finishStockItemEditCaptureTx(tx, req, recorder);
      });

      res.json({
        message: `Renamed ${results.length} item(s)`,
        updated: results.length,
        results,
        failures,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
