import type { Express } from "express";
import { ZodError } from "zod";
import { requireAuth, requireRole } from "../auth";
import { storage } from "../storage";
import { getErrorMessage } from "../lib/httpHandlers";
import {
  canManageExcelAppearance,
  loadCompanyExcelAppearance,
  saveCompanyExcelAppearance,
} from "../services/excelAppearanceSettings";

/** All reads and writes are bound to the authenticated session company. */
export function registerExcelAppearanceRoutes(app: Express): void {
  app.get("/api/excel-export/appearance", requireAuth, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "Select a company first" });
    try {
      const [appearance, company] = await Promise.all([
        loadCompanyExcelAppearance(companyId),
        storage.getCompanyById(companyId),
      ]);
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ appearance, companyName: company?.name ?? "" });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/excel-export/appearance", requireAuth, requireRole("Admin", "Developer"), async (req, res) => {
    // Require current effective role; base Admin alone must not bypass a
    // View-Only role switch. Company ID is never accepted from request body.
    if (!canManageExcelAppearance(req.session.currentRole)) {
      return res.status(403).json({ message: "Admin or Developer role required" });
    }
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "Select a company first" });
    try {
      const appearance = await saveCompanyExcelAppearance(companyId, req.body);
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ appearance });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid Excel appearance settings", issues: error.issues });
      }
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
