/**
 * stockTransferAdjRoutes: StockItemWrite endpoints.
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
import {} from "@shared/schema";
import { sql } from "drizzle-orm";
import type { RawQueryRow } from "../../../db";
import type { InsertStockItem } from "@shared/schema";
import { toFiniteNumber } from "@shared/typeGuards";

export function registerStockItemWriteRoutes(app: Express) {
  // Update stock item
  app.patch("/api/stock-items/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const stockItemId = parseInt(req.params.id);
      if (isNaN(stockItemId)) {
        return res.status(400).json({ message: "Invalid stock item ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Verify stock item exists and belongs to current company
      const existingItem = await storage.getStockItemById(stockItemId);
      if (!existingItem) {
        return res.status(404).json({ message: "Stock item not found" });
      }

      if (existingItem.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Stock item belongs to a different company",
        });
      }

      // Trim and validate required fields
      const updates: Partial<InsertStockItem> = {};

      if (req.body.code !== undefined) {
        const trimmedCode = String(req.body.code).trim();
        if (trimmedCode === "") {
          return res.status(400).json({ message: "Code is required" });
        }
        updates.code = trimmedCode;
      }

      if (req.body.name !== undefined) {
        const trimmedName = String(req.body.name).trim();
        if (trimmedName === "") {
          return res.status(400).json({ message: "Name is required" });
        }
        updates.name = trimmedName;
      }

      if (req.body.uom !== undefined) {
        const trimmedUom = String(req.body.uom).trim();
        if (trimmedUom === "") {
          return res.status(400).json({ message: "Unit of measure is required" });
        }
        updates.uom = trimmedUom;
      }

      // NOTE: `stock_items` has no `barcode` column - barcodes live in
      // `stock_item_code_aliases`. A previous `updates: any` hid the fact that
      // Drizzle silently drops an unknown key, so any `barcode` sent by the
      // client was already discarded before reaching SQL. The assignment is
      // omitted rather than reinstated: persisting it would be a behaviour
      // change (alias rows carry their own uniqueness semantics).

      if (req.body.stockGroupId !== undefined) {
        if (req.body.stockGroupId === null) {
          return res.status(400).json({ message: "Stock Group is required. Please select a valid stock group." });
        }
        updates.stockGroupId = req.body.stockGroupId;
      }

      if (req.body.sellingPrice !== undefined) {
        updates.sellingPrice = req.body.sellingPrice ? String(req.body.sellingPrice) : "0";
      }

      if (req.body.active !== undefined) {
        updates.active = req.body.active;
      }

      if (req.body.gradeId !== undefined) {
        updates.gradeId = req.body.gradeId === null ? null : parseInt(req.body.gradeId);
      }

      if (req.body.categoryId !== undefined) {
        updates.categoryId = req.body.categoryId === null ? null : parseInt(req.body.categoryId);
      }

      // If updating code, check for duplicates
      if (updates.code && updates.code !== existingItem.code) {
        const duplicate = await storage.getStockItemByCode(updates.code, req.session.currentCompanyId);
        if (duplicate) {
          return res.status(400).json({ message: "Stock item code already exists" });
        }
      }

      const updated = await storage.updateStockItem(stockItemId, updates);
      try {
        const _stockChanges: Record<string, { old?: unknown; new?: unknown }> = {};
        for (const _f of ["name", "code", "uom", "barcode", "sellingPrice", "active"] as const) {
          if (
            String((existingItem as { [key: string]: unknown })[_f] ?? "") !==
            String((updated as { [key: string]: unknown })[_f] ?? "")
          ) {
            _stockChanges[_f] = {
              old: (existingItem as { [key: string]: unknown })[_f],
              new: (updated as { [key: string]: unknown })[_f],
            };
          }
        }
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "stock_items",
          recordId: updated.id,
          recordIdentifier: updated.name,
          changes: _stockChanges,
        });
      } catch {
        /* non-fatal */
      }
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Delete stock item
  app.delete("/api/stock-items/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const stockItemId = parseInt(req.params.id);
      if (isNaN(stockItemId)) {
        return res.status(400).json({ message: "Invalid stock item ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Verify stock item exists and belongs to current company
      const existingItem = await storage.getStockItemById(stockItemId);
      if (!existingItem) {
        return res.status(404).json({ message: "Stock item not found" });
      }

      if (existingItem.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Stock item belongs to a different company",
        });
      }

      // Check if item has ANY inventory record (regardless of quantity)
      const anyInventory = await db.execute<RawQueryRow<{ count: string | number }>>(
        sql`SELECT COUNT(*) as count FROM inventory WHERE stock_item_id = ${stockItemId}`
      );
      const inventoryCount = toFiniteNumber(anyInventory.rows[0]?.count) ?? 0;

      if (inventoryCount > 0) {
        return res.status(400).json({
          message: `Cannot delete stock item "${existingItem.code}": it has inventory records in ${inventoryCount} location(s). Please transfer or adjust all inventory to zero and clear the records first.`,
        });
      }

      await storage.deleteStockItem(stockItemId);
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "delete",
          tableName: "stock_items",
          recordId: existingItem.id,
          recordIdentifier: existingItem.name,
          changes: {
            name: { old: existingItem.name },
            code: { old: existingItem.code },
            uom: { old: existingItem.uom },
            sellingPrice: { old: existingItem.sellingPrice || "0" },
          },
        });
      } catch {
        /* non-fatal */
      }
      res.json({ message: "Stock item deleted successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
