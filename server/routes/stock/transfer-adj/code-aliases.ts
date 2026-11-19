/**
 * stockTransferAdjRoutes: StockItemCodeAlias endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { insertStockItemCodeAliasSchema } from "@shared/schema";
import {} from "drizzle-orm";
import { validateRequest } from "../../../lib/validateRequest";
import { createCodeAliasInput, deleteByIdInput } from "./transferAdjRouteSchemas";

export function registerStockItemCodeAliasRoutes(app: Express) {
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
  app.post(
    "/api/stock-items/:id/code-aliases",
    requireAuth,
    requireNonPOS,
    validateRequest(createCodeAliasInput),
    async (req, res) => {
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
    }
  );

  // Delete a code alias
  app.delete("/api/stock-item-code-aliases/:id", requireAuth, validateRequest(deleteByIdInput), async (req, res) => {
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
}
