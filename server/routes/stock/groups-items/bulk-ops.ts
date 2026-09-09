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
import { stockItems, stockItemLocationPrices } from "@shared/schema";
import { eq, and, or, inArray, sql } from "drizzle-orm";
import type { RawQueryRow } from "../../../db";

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
      const inventoryCheck = await db.execute<RawQueryRow<{ stock_item_id: number }>>(
        sql`SELECT stock_item_id FROM inventory WHERE stock_item_id = ANY(ARRAY[${sql.join(
          validIds.map((id) => sql`${id}`),
          sql`, `
        )}]) GROUP BY stock_item_id`
      );
      if (inventoryCheck.rows.length > 0) {
        const blockedIds = new Set(inventoryCheck.rows.map((r) => Number(r.stock_item_id)));
        const blockedCodes = validItems.filter((item) => blockedIds.has(item.id)).map((item) => item.code);
        return res.status(400).json({
          message: `Cannot delete ${blockedCodes.length} item(s) — they have existing inventory records: ${blockedCodes.join(", ")}. Please clear all inventory first.`,
        });
      }

      await storage.bulkDeleteStockItems(validIds);
      try {
        for (const deletedItem of validItems) {
          await logAudit({
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
          });
        }
      } catch {
        /* non-fatal */
      }

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

      await db
        .update(stockItems)
        .set({ categoryId: isNaN(categoryId as number) ? null : categoryId })
        .where(and(inArray(stockItems.id, validIds), eq(stockItems.companyId, companyId)));

      res.json({ message: `Category updated for ${validIds.length} item(s)`, updated: validIds.length });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bulk update selling prices by barcode (global or location-specific)
  app.post("/api/stock-items/bulk-update-prices", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { prices } = req.body;
      if (!Array.isArray(prices) || prices.length === 0) {
        return res.status(400).json({ message: "Invalid or empty prices array" });
      }

      const companyId = req.session.currentCompanyId;

      // Pre-fetch all items + aliases once to avoid N+1
      const allItems = await storage.getAllStockItems(companyId);
      const allAliases = await storage.getAllCompanyCodeAliases(companyId);
      const itemsById = new Map(allItems.map((i) => [i.id, i]));
      const itemsByCode = new Map<string, (typeof allItems)[0]>();
      for (const item of allItems) {
        if (item.code) itemsByCode.set(item.code.toLowerCase(), item);
      }
      for (const alias of allAliases) {
        if (alias.aliasCode && !itemsByCode.has(alias.aliasCode.toLowerCase())) {
          const item = itemsById.get(alias.stockItemId);
          if (item) itemsByCode.set(alias.aliasCode.toLowerCase(), item);
        }
      }

      let updated = 0;
      let notFound = 0;
      type GlobalUpdate = { id: number; sellingPrice: string };
      type LocationUpdate = { stockItemId: number; locationId: number; sellingPrice: string };
      const globalUpdates: GlobalUpdate[] = [];
      const locationUpdates: LocationUpdate[] = [];

      for (const priceEntry of prices) {
        const { barcode, sellingPrice, locationId } = priceEntry;
        if (!barcode || !sellingPrice) continue;
        const item = itemsByCode.get((barcode as string).toLowerCase());
        if (item) {
          if (locationId) {
            locationUpdates.push({ stockItemId: item.id, locationId, sellingPrice });
          } else {
            globalUpdates.push({ id: item.id, sellingPrice });
          }
          updated++;
        } else {
          notFound++;
        }
      }

      if (globalUpdates.length > 0 || locationUpdates.length > 0) {
        await db.transaction(async (tx) => {
          for (const u of globalUpdates) {
            await tx.update(stockItems).set({ sellingPrice: u.sellingPrice }).where(eq(stockItems.id, u.id));
          }
          for (const u of locationUpdates) {
            await tx
              .insert(stockItemLocationPrices)
              .values({
                stockItemId: u.stockItemId,
                locationId: u.locationId,
                sellingPrice: u.sellingPrice,
              })
              .onConflictDoUpdate({
                target: [stockItemLocationPrices.stockItemId, stockItemLocationPrices.locationId],
                set: { sellingPrice: u.sellingPrice, updatedAt: new Date() },
              });
          }
        });
      }

      const message = `Updated ${updated} price(s)${notFound > 0 ? `. ${notFound} barcode(s) not found.` : "."}`;
      try {
        if (updated > 0) {
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: companyId,
            action: "update",
            tableName: "stock_items",
            recordId: 0,
            recordIdentifier: `Bulk price update (${updated} items)`,
            changes: {
              pricesUpdated: { new: updated },
              barcodesNotFound: { new: notFound },
            },
          });
        }
      } catch {
        /* non-fatal */
      }
      res.json({ message, updated, notFound });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Import Opening Balances from Excel (columns: Barcode, Qty, Rate, Total Value)
  // This only updates stockItems opening fields, does NOT affect location inventory
  app.post("/api/stock-items/import-opening-balances", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { openingBalances } = req.body;
      if (!Array.isArray(openingBalances) || openingBalances.length === 0) {
        return res.status(400).json({ message: "Invalid or empty opening balances array" });
      }

      let updated = 0;
      let notFound = 0;
      const notFoundBarcodes: string[] = [];

      // Pre-fetch all stock items once for efficient lookup
      const allItems = await storage.getAllStockItems(req.session.currentCompanyId);
      // Map by primary code field (skip empty/null codes)
      const itemsByCode = new Map<string, (typeof allItems)[0]>();
      const itemsById = new Map(allItems.map((i) => [i.id, i]));
      for (const item of allItems) {
        if (item.code && typeof item.code === "string") {
          itemsByCode.set((item.code || "").toLowerCase(), item);
        }
      }

      // Pre-fetch all code aliases and build alias lookup map (skip empty/null aliases)
      const allAliases = await storage.getAllCompanyCodeAliases(req.session.currentCompanyId);
      const itemsByAlias = new Map<string, (typeof allItems)[0]>();
      for (const alias of allAliases) {
        if (alias.aliasCode && typeof alias.aliasCode === "string") {
          const item = itemsById.get(alias.stockItemId);
          if (item) {
            itemsByAlias.set((alias.aliasCode || "").toLowerCase(), item);
          }
        }
      }

      for (const entry of openingBalances) {
        const { barcode, openingQty, openingRate, openingValue } = entry;
        if (!barcode || typeof barcode !== "string") continue;

        // Find item by primary code first, then by alias (case-insensitive)
        const barcodeLC = (barcode || "").toLowerCase();
        const item = itemsByCode.get(barcodeLC) || itemsByAlias.get(barcodeLC);

        if (item) {
          // Calculate total value if not provided: qty * rate
          const qty = parseFloat(openingQty) || 0;
          const rate = parseFloat(openingRate) || 0;
          let totalValue = parseFloat(openingValue) || 0;

          // If total value not provided, calculate from qty * rate
          if (totalValue === 0 && qty > 0 && rate > 0) {
            totalValue = qty * rate;
          }

          await storage.updateStockItem(item.id, {
            openingQty: String(qty),
            openingRate: String(rate),
            openingValue: String(totalValue),
          });
          updated++;
        } else {
          notFound++;
          notFoundBarcodes.push(barcode);
        }
      }

      const message = `Updated opening balances for ${updated} item(s)${notFound > 0 ? `. ${notFound} barcode(s) not found: ${notFoundBarcodes.slice(0, 5).join(", ")}${notFoundBarcodes.length > 5 ? "..." : ""}` : "."}`;
      res.json({ message, updated, notFound, notFoundBarcodes });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bulk update UOM from "bale" to "BL"
  app.post("/api/stock-items/bulk-update-uom", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Find all stock items with UOM = "bale" for current company (case-insensitive)
      const baleItems = await db.query.stockItems.findMany({
        where: and(
          eq(stockItems.companyId, req.session.currentCompanyId),
          or(eq(stockItems.uom, "bale"), eq(stockItems.uom, "Bale"), eq(stockItems.uom, "BALE"))
        ),
      });

      if (baleItems.length === 0) {
        return res.json({ message: "No items with UOM 'bale' found to update", updated: 0 });
      }

      // Update all bale items to BL
      let updated = 0;
      for (const item of baleItems) {
        await storage.updateStockItem(item.id, { uom: "BL" });
        updated++;
      }

      res.json({ message: `Successfully updated ${updated} stock item(s) from 'bale' to 'BL'`, updated });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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
          await storage.updateStockItem(item.id, { name: newName });
          results.push({ id: item.id, oldName: item.name, newName });
        } catch (err: unknown) {
          failures.push({ id: item.id, name: item.name, reason: getErrorMessage(err) });
        }
      }

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
