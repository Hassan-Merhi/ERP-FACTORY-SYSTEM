import type { Express, NextFunction, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db, pool } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { persistSecurityEvent } from "../../services/security/securityAuditRuntime";
import {
  KNOWN_SECURITY_PERMISSIONS,
  hydrateSessionNamedPermissions,
  invalidateUserCompanySessions,
  loadNamedPermissions,
  normalizePermissionList,
  replaceNamedPermissions,
} from "../../services/security/namedPermissionService";

function activeCompany(req: Request): number | null {
  const value = req.session.currentCompanyId;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function requirePermissionAdministrator(req: Request, res: Response, next: NextFunction) {
  try {
    const permissions = await hydrateSessionNamedPermissions(db, req.session);
    if (!permissions.includes("security.permissions.manage")) {
      return res.status(403).json({ message: "Forbidden" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

export function registerSecurityPermissionRoutes(app: Express) {
  const guards = [requireAuth, requireRole("Admin", "Developer"), requirePermissionAdministrator] as const;

  app.get("/api/admin/security-permissions/catalog", ...guards, (_req, res) => {
    res.json({ permissions: KNOWN_SECURITY_PERMISSIONS });
  });

  app.get("/api/admin/users/:userId/security-permissions", ...guards, async (req, res) => {
    try {
      const companyId = activeCompany(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const permissions = await loadNamedPermissions(db, req.params.userId, companyId);
      res.json({ userId: req.params.userId, companyId, permissions });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/admin/users/:userId/security-permissions", ...guards, async (req, res) => {
    try {
      const companyId = activeCompany(req);
      const actorUserId = req.session.userId;
      if (!companyId || !actorUserId) return res.status(403).json({ message: "Forbidden" });
      const permissions = normalizePermissionList(req.body?.permissions);
      const saved = await db.transaction((tx) =>
        replaceNamedPermissions(tx, {
          userId: req.params.userId,
          companyId,
          permissions,
          grantedBy: actorUserId,
        })
      );
      await persistSecurityEvent(
        db,
        {
          kind: "authorization",
          action: "security.permissions.replace",
          outcome: "allowed",
          companyId,
          actorUserId,
          targetType: "user",
          targetId: req.params.userId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: { permissionCount: saved.length },
        },
        req.session.username || actorUserId
      );
      await invalidateUserCompanySessions(pool, req.params.userId, companyId);
      res.json({ userId: req.params.userId, companyId, permissions: saved });
    } catch (error: unknown) {
      if (getErrorMessage(error) === "Invalid permissions") return res.status(400).json({ message: "Invalid request" });
      if (getErrorMessage(error) === "User not found") return res.status(404).json({ message: "Not found" });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
