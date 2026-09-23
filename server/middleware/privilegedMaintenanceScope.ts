import type { NextFunction, Request, Response } from "express";
import { db } from "../db";
import { logger } from "../lib/logger";
import { privilegedMutationRateLimit } from "./privilegedEndpointSecurity";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { getCompanyRequestRuntimeContext } from "../services/security/companyRequestRuntimeContext";
import {
  loadNamedPermissions,
  SecuritySchemaUnavailableError,
} from "../services/security/namedPermissionService";
import {
  classifyPrivilegedMaintenanceRoute,
  decidePrivilegedMaintenanceAccess,
} from "../services/security/privilegedMaintenanceRoutePolicy";

function requestPath(req: Request): string {
  return req.originalUrl.split("?", 1)[0] || req.path;
}

function deny(
  req: Request,
  res: Response,
  status: number,
  code: string,
  companyId: number | null,
  role: string | null,
  operation: string
): void {
  logger.error(
    JSON.stringify({
      event: "privileged_maintenance_denied",
      ts: new Date().toISOString(),
      userId: req.session.userId ?? null,
      role,
      companyId,
      method: req.method,
      path: requestPath(req),
      operation,
      code,
    })
  );
  res.status(status).json({ message: "Forbidden", code });
}

/**
 * Global admission boundary for legacy repair/rebuild/backfill/reconciliation
 * mutations. It runs before route registrars, but leaves unauthenticated
 * requests to each route's existing requireAuth middleware.
 *
 * This intentionally does not invent new request-body confirmation fields.
 * Routes with stronger signed preview/apply tokens keep those flows unchanged.
 */
export async function enforcePrivilegedMaintenanceScope(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const match = classifyPrivilegedMaintenanceRoute(req.method, requestPath(req));
  if (!match || !req.session?.userId) {
    next();
    return;
  }

  try {
    const context = getCompanyRequestRuntimeContext() ?? (await getActiveCompanyPermissionContext(req));
    const permissions = context.developerBypass
      ? []
      : await loadNamedPermissions(db, context.userId, context.companyId);
    const decision = decidePrivilegedMaintenanceAccess({
      role: context.role,
      developerBypass: context.developerBypass,
      permissions,
    });

    if (!decision.allowed) {
      deny(
        req,
        res,
        403,
        decision.code,
        context.companyId,
        context.role,
        match.operation
      );
      return;
    }

    privilegedMutationRateLimit(req, res, next);
  } catch (error) {
    if (error instanceof ActiveCompanyPermissionContextError) {
      deny(
        req,
        res,
        error.status,
        error.code,
        null,
        req.session.currentRole ?? null,
        match.operation
      );
      return;
    }
    if (error instanceof SecuritySchemaUnavailableError) {
      deny(
        req,
        res,
        503,
        error.code,
        req.session.currentCompanyId ?? null,
        req.session.currentRole ?? null,
        match.operation
      );
      return;
    }
    next(error);
  }
}
