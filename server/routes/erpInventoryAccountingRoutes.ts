/** Read-only source-to-ledger inventory audit for unified Accounting Phase 6. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { getErrorMessage } from "../lib/httpHandlers";
import { erpInventoryAccountingAuditTx } from "../services/accounting/perpetualInventory/erpInventoryAccountingAudit";
import { perpetualReadinessReport } from "../services/accounting/perpetualInventory/readiness";
import { DEFAULT_PERPETUAL_INVENTORY_FROM } from "../services/accounting/perpetualInventory/cutover";

const optionalIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
function company(req: Request): number {
  const id = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("COMPANY_REQUIRED");
  return id;
}
export function registerErpInventoryAccountingRoutes(app: Express): void {
  app.get(
    "/api/accounting/erp-inventory/audit",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      const parsed = z.object({ asOfDate: optionalIso }).safeParse(req.query);
      if (!parsed.success)
        return res.status(400).json({
          message: "asOfDate must use YYYY-MM-DD",
          code: "INVENTORY_AUDIT_DATE_INVALID",
        });
      try {
        return res.json(
          await db.transaction(async (tx) =>
            erpInventoryAccountingAuditTx(tx, {
              companyId: company(req),
              asOfDate: parsed.data.asOfDate,
            })
          )
        );
      } catch (error) {
        return res
          .status(getErrorMessage(error) === "COMPANY_REQUIRED" ? 400 : 500)
          .json({ message: getErrorMessage(error) });
      }
    }
  );
  app.get(
    "/api/accounting/erp-inventory/readiness",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      const parsed = z.object({ effectiveFrom: optionalIso }).safeParse(req.query);
      if (!parsed.success)
        return res.status(400).json({
          message: "effectiveFrom must use YYYY-MM-DD",
          code: "INVENTORY_READINESS_DATE_INVALID",
        });
      try {
        // Existing centralized cutover readiness service; inspection ONLY.
        return res.json(
          await perpetualReadinessReport(company(req), parsed.data.effectiveFrom ?? DEFAULT_PERPETUAL_INVENTORY_FROM)
        );
      } catch (error) {
        return res
          .status(getErrorMessage(error) === "COMPANY_REQUIRED" ? 400 : 500)
          .json({ message: getErrorMessage(error) });
      }
    }
  );
}
