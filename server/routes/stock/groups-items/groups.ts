/**
 * stockGroupsItemsRoutes: StockGroup endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { storage } from "../../../storage";
import { masterDataDbErrorResponse } from "../../../lib/masterDataDbError";
import { requireAuth, requireNonPOS } from "../../../auth";
import { insertStockGroupSchema } from "@shared/schema";

export function registerStockGroupRoutes(app: Express) {
  app.get("/api/stock-groups", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const groups = await storage.getAllStockGroups(req.session.currentCompanyId);
      res.json(groups);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/stock-groups", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Inject companyId before schema validation
      const dataWithCompany = {
        ...req.body,
        companyId: req.session.currentCompanyId,
      };

      const parsed = insertStockGroupSchema.parse(dataWithCompany);

      // Check for duplicate code within the same company
      const existing = await storage.getStockGroupByCode(parsed.code, req.session.currentCompanyId);
      if (existing) {
        return res.status(400).json({
          message: "Stock group code already exists in this company",
        });
      }

      const group = await storage.createStockGroup(parsed);
      res.status(201).json(group);
    } catch (error: unknown) {
      const dbError = masterDataDbErrorResponse(error, "stock-group", req.session.currentCompanyId);
      if (dbError) return res.status(dbError.status).json(dbError.body);
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // ── Stock Grades ────────────────────────────────────────────────────────────
}
