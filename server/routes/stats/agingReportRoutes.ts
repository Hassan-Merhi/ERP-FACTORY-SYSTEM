/**
 * AR/AP aging report on the balance engine (accounting audit wave 17 A).
 * See services/reports/agingReport.ts for the rules.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireAuth, requireRole } from "../../auth";
import { getAgingReport, type AgingKind } from "../../services/reports/agingReport";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerAgingReportRoutes(app: Express) {
  app.get("/api/reports/aging", requireAuth, requireRole("Admin", "Owner", "Manager"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const kind = req.query.kind;
      if (kind !== "customer" && kind !== "supplier") {
        return res.status(400).json({ message: "kind must be customer or supplier" });
      }
      const asOfRaw = req.query.asOf;
      if (asOfRaw !== undefined && (typeof asOfRaw !== "string" || !ISO_DATE.test(asOfRaw))) {
        return res.status(400).json({ message: "asOf must be a single YYYY-MM-DD value" });
      }
      res.json(await getAgingReport(companyId, kind satisfies AgingKind, asOfRaw ?? null));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
