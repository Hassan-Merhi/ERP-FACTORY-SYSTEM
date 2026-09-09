import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import { insertStockItemCodeAliasSchema } from "@shared/schema";
import { sql } from "drizzle-orm";
import type { RawQueryRow } from "../../db";
import type { InsertStockItem } from "@shared/schema";
import { toFiniteNumber } from "@shared/typeGuards";

export function registerStockItemManageRoutes(app: Express) {
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

  // Get stock item transactions (transfers and adjustments)
  app.get("/api/stock-items/:id/transactions", requireAuth, async (req, res) => {
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

      const { startDate, endDate } = req.query;
      const transactions = await storage.getStockItemTransactions(
        stockItemId,
        req.session.currentCompanyId,
        startDate as string | undefined,
        endDate as string | undefined
      );

      res.json(transactions);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get stock item details (last purchase, last sale, inventory locations)
  app.get("/api/stock-items/:id/details", requireAuth, async (req, res) => {
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

      const fromDate = typeof req.query.from === "string" ? req.query.from : undefined;
      const toDate = typeof req.query.to === "string" ? req.query.to : undefined;

      // Get all purchases, all sales, and current locations
      const [purchases, sales, inventoryLocations] = await Promise.all([
        storage.getAllPurchasesForItem(stockItemId, req.session.currentCompanyId, fromDate, toDate),
        storage.getAllSalesForItem(stockItemId, req.session.currentCompanyId, fromDate, toDate),
        storage.getInventoryLocationsByItem(stockItemId, req.session.currentCompanyId),
      ]);

      res.json({
        purchases,
        sales,
        inventoryLocations,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get voucher history for a stock item (all transactions - sales, transfers, consumption, production)
  app.get("/api/stock-items/:id/voucher-history", requireAuth, async (req, res) => {
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

      // Get all voucher transactions for this item
      const voucherHistory = await storage.getVoucherHistoryForItem(stockItemId, req.session.currentCompanyId);

      res.json(voucherHistory);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get all code aliases for a stock item
  app.get("/api/stock-items/:id/code-aliases", requireAuth, async (req, res) => {
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

      const aliases = await storage.getStockItemCodeAliases(stockItemId);
      res.json(aliases);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Create a new code alias for a stock item
  app.post("/api/stock-items/:id/code-aliases", requireAuth, requireNonPOS, async (req, res) => {
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

      // Validate the alias (include companyId for security)
      const validatedAlias = insertStockItemCodeAliasSchema.parse({
        ...req.body,
        stockItemId,
        companyId: req.session.currentCompanyId,
      });

      const alias = await storage.createStockItemCodeAlias(validatedAlias);
      res.status(201).json(alias);
    } catch (error: unknown) {
      if ((error as { name?: string }).name === "ZodError") {
        return res.status(400).json({ message: "Validation error", errors: (error as { errors?: unknown }).errors });
      }
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Delete a code alias
  app.delete("/api/stock-item-code-aliases/:id", requireAuth, async (req, res) => {
    try {
      const aliasId = parseInt(req.params.id);
      if (isNaN(aliasId)) {
        return res.status(400).json({ message: "Invalid alias ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get the alias first to verify ownership
      const alias = await storage.getStockItemCodeAliasById(aliasId);
      if (!alias) {
        return res.status(404).json({ message: "Code alias not found" });
      }

      // Verify the alias belongs to the current company
      if (alias.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Code alias belongs to a different company",
        });
      }

      await storage.deleteStockItemCodeAlias(aliasId);
      res.json({ message: "Code alias deleted successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Update stock transfer item
  app.patch("/api/stock-transfer-items/:id", requireAuth, async (req, res) => {
    try {
      const itemId = parseInt(req.params.id);
      if (isNaN(itemId)) {
        return res.status(400).json({ message: "Invalid item ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Validate numeric fields if provided
      if (req.body.quantity !== undefined) {
        const qty = parseFloat(req.body.quantity);
        if (isNaN(qty)) {
          return res.status(400).json({ message: "Quantity must be a valid number" });
        }
      }
      if (req.body.rate !== undefined) {
        const rate = parseFloat(req.body.rate);
        if (isNaN(rate) || rate < 0) {
          return res.status(400).json({ message: "Rate must be a valid non-negative number" });
        }
      }
      if (req.body.stockItemId !== undefined) {
        const stockItemId = parseInt(req.body.stockItemId);
        if (isNaN(stockItemId)) {
          return res.status(400).json({ message: "Stock item ID must be a valid number" });
        }
      }

      const updated = await storage.updateStockTransferItem(itemId, req.body);
      try {
        const _sti: Record<string, any> = {};
        if (req.body.quantity !== undefined) _sti.quantity = { new: String(req.body.quantity) };
        if (req.body.rate !== undefined) _sti.rate = { new: String(req.body.rate) };
        if (req.body.stockItemId !== undefined) _sti.stockItemId = { new: String(req.body.stockItemId) };
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "stock_transfer_items",
          recordId: itemId,
          recordIdentifier: `Transfer item #${itemId}`,
          changes: _sti,
        });
      } catch {
        /* non-fatal */
      }
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
