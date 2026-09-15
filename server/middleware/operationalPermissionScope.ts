import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";
import { requirePermission } from "../lib/permissionMiddleware";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { classifyOperationalPermissionRoute } from "../services/security/operationalPermissionRoutePolicy";

function requestPath(req: Request): string {
  return req.originalUrl.split("?", 1)[0] || req.path;
}

function deny(req: Request, res: Response, status: number, code: string, message: string, operation: string): void {
  logger.error(
    JSON.stringify({
      event: "operational_permission_denied",
      ts: new Date().toISOString(),
      userId: req.session.userId ?? null,
      role: req._activeCompanyPermissionContext?.role ?? req.session.currentRole ?? null,
      companyId:
        req._activeCompanyPermissionContext?.companyId ??
        req.session.factoryCompanyId ??
        req.session.currentCompanyId ??
        null,
      method: req.method,
      path: requestPath(req),
      operation,
      code,
    })
  );
  res.status(status).json({ message, code });
}

/**
 * Global operational boundary registered before legacy route handlers.
 * It supplements, rather than replaces, each route's requireAuth/requireRole
 * checks and keeps business behavior unchanged after authorization succeeds.
 */
export async function enforceOperationalPermissionScope(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const match = classifyOperationalPermissionRoute(req.method, requestPath(req));
  if (!match || !req.session.userId) {
    next();
    return;
  }

  try {
    const context = await getActiveCompanyPermissionContext(req);

    if (match.developerOnly && context.role !== "Developer") {
      deny(
        req,
        res,
        403,
        "GLOBAL_EXPORT_DEVELOPER_REQUIRED",
        "Developer access is required for the all-company export center.",
        match.operation
      );
      return;
    }

    if (match.deniedRoles?.includes(context.role)) {
      deny(
        req,
        res,
        403,
        "OPERATIONAL_ROLE_DENIED",
        "Your role is not allowed to perform this operational task.",
        match.operation
      );
      return;
    }

    if (match.permissionBypassRoles?.includes(context.role)) {
      next();
      return;
    }

    const guard = requirePermission(match.permissionKey, match.permissionType);
    await guard(req, res, next);
  } catch (error) {
    if (error instanceof ActiveCompanyPermissionContextError) {
      deny(req, res, error.status, error.code, error.message, match.operation);
      return;
    }
    next(error);
  }
}
