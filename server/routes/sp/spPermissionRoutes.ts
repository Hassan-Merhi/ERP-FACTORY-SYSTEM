import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { SP_PERMISSIONS } from "./spAccessControl";
import { requireSpCompany } from "./spHelpers";
import { resultRows } from "../../lib/queryResult";

export function registerSpPermissionRoutes(app: Express): void {
  app.get("/api/sp/permissions", requireAuth, requireRole("Admin"), async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;
      const result = await db.execute(sql`
        SELECT company_id AS "companyId", user_id AS "userId", permission, enabled,
               granted_by AS "grantedBy", granted_at AS "grantedAt"
        FROM sp_permission_grants
        WHERE company_id = ${companyId}
        ORDER BY user_id, permission
      `);
      res.json({ permissions: SP_PERMISSIONS, grants: resultRows(result) ?? [] });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put(
    "/api/sp/permissions/:userId/:permission",
    requireAuth,
    requireRole("Admin"),
    async (req: Request, res: Response) => {
      try {
        const companyId = await requireSpCompany(req, res);
        if (!companyId) return;
        const permission = String(req.params.permission);
        if (!(SP_PERMISSIONS as readonly string[]).includes(permission)) {
          return res.status(400).json({ message: releaseDebtEnglish("Unknown Supplier Partner permission") });
        }
        const confirmation = String(req.body?.confirmation ?? "");
        if (confirmation !== "CHANGE SP PERMISSION") {
          return res.status(400).json({
            code: "SP_EXACT_CONFIRMATION_REQUIRED",
            message: releaseDebtEnglish("Type exactly: CHANGE SP PERMISSION"),
          });
        }
        const reason = String(req.body?.reason ?? "").trim();
        if (reason.length < 5)
          return res
            .status(400)
            .json({ code: "SP_REASON_REQUIRED", message: releaseDebtEnglish("A meaningful reason is required.") });
        const userId = String(req.params.userId).trim();
        const enabled = req.body?.enabled === true;
        await db.execute(sql`
        INSERT INTO sp_permission_grants(company_id, user_id, permission, enabled, granted_by, granted_at)
        VALUES (${companyId}, ${userId}, ${permission}, ${enabled}, ${req.user?.id ?? req.session.userId ?? null}, now())
        ON CONFLICT (company_id, user_id, permission)
        DO UPDATE SET enabled = EXCLUDED.enabled, granted_by = EXCLUDED.granted_by, granted_at = now()
      `);
        res.json({ companyId, userId, permission, enabled });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/sp/audit-events", requireAuth, requireRole("Admin"), async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      const result = await db.execute(sql`
        SELECT * FROM sp_audit_events
        WHERE company_id = ${companyId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
      res.json(resultRows(result) ?? []);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
