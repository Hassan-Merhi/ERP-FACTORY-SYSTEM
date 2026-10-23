/** Read-only Factory/ERP accounting bridge: no write endpoints. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { getErrorMessage } from "../lib/httpHandlers";
import { factoryProductionAccountingAuditTx } from "../services/accounting/perpetualInventory/factoryProductionAccountingAudit";

const request = z.object({
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export function registerFactoryProductionAccountingRoutes(app: Express): void {
  app.get(
    "/api/accounting/factory-production/audit",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      const parsed = request.safeParse(req.query);
      if (!parsed.success)
        return res.status(400).json({
          code: "FACTORY_ACCOUNTING_DATE_INVALID",
          message: "asOfDate must be YYYY-MM-DD",
        });
      const companyId = Number(req.session.currentCompanyId);
      if (!Number.isSafeInteger(companyId) || companyId <= 0)
        return res.status(400).json({ code: "FACTORY_ACCOUNTING_COMPANY_REQUIRED", message: "Select a company" });
      try {
        const result = await db.transaction((tx) =>
          factoryProductionAccountingAuditTx(tx, {
            companyId,
            asOfDate: parsed.data.asOfDate,
          })
        );
        return res.json(result);
      } catch (e) {
        return res.status(500).json({ code: "FACTORY_ACCOUNTING_AUDIT_FAILED", message: getErrorMessage(e) });
      }
    }
  );
}
