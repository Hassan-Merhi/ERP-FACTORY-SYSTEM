/**
 * Accounting integrity routes (2026-10 accounting audit).
 *
 * Both are read-only: the integrity diagnostic runs the audit's ledger checks
 * for the current company, and the trial balance reports every posted line and
 * opening balance with any difference shown explicitly, never plugged.
 */
import type { Express } from "express";

import { requireAuth, requireRole } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { runAccountingIntegrityDiagnostic } from "../../services/accounting/integrity/accountingIntegrityDiagnostic";
import { buildTrialBalance } from "../../services/accounting/integrity/trialBalance";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerAccountingIntegrityRoutes(app: Express) {
  app.get("/api/accounting/integrity", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await runAccountingIntegrityDiagnostic(companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounting/trial-balance", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const asOf = typeof req.query.asOf === "string" && req.query.asOf ? req.query.asOf : null;
      if (asOf && !ISO_DATE.test(asOf)) return res.status(400).json({ message: "Invalid date" });
      res.json(await buildTrialBalance(companyId, asOf));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
