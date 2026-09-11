/**
 * stockMergeRoutes: StockItemEdit endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { storage } from "../../../storage";
import { requireAuth } from "../../../auth";
import { logAudit } from "../../_helpers";

export function registerStockItemEditRoutes(app: Express) {
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
        const _sti: Record<string, { new: string }> = {};
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

  // Update stock adjustment item
  app.patch("/api/stock-adjustment-items/:id", requireAuth, async (req, res) => {
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

      const updated = await storage.updateStockAdjustmentItem(itemId, req.body);
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
