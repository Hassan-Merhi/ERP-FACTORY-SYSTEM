import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";
import { storage } from "../storage";
import { buildPermissionMap, canAccess } from "./permissionHelpers";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
  type ActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";

export type PermMiddlewareType = "module" | "page" | "tab" | "action" | "sensitive" | "export" | "pos";

interface PermissionState {
  context: ActiveCompanyPermissionContext;
  permissionMap: Map<string, boolean>;
}

declare global {
  namespace Express {
    interface Request {
      _permissionStates?: Map<string, PermissionState>;
    }
  }
}

function permissionStateKey(context: ActiveCompanyPermissionContext): string {
  return `${context.companyId}:${context.role}`;
}

async function getPermissionState(req: Request): Promise<PermissionState> {
  const context = await getActiveCompanyPermissionContext(req);
  const key = permissionStateKey(context);

  req._permissionStates ??= new Map<string, PermissionState>();
  const cached = req._permissionStates.get(key);
  if (cached) return cached;

  // Developer and Admin remain unrestricted by role-feature rows, but their role
  // is still loaded from canonical storage above so a stale session cannot grant
  // privilege in the wrong company.
  if (context.role === "Developer" || context.role === "Admin") {
    const state = { context, permissionMap: new Map<string, boolean>() };
    req._permissionStates.set(key, state);
    return state;
  }

  const rows = await storage.getRoleFeaturePermissions(context.companyId);
  const state = {
    context,
    permissionMap: buildPermissionMap(rows, context.role),
  };
  req._permissionStates.set(key, state);
  return state;
}

function logPermissionEvent(
  req: Request,
  details: {
    event: "access_denied" | "permission_lookup_failed";
    key: string;
    permType: PermMiddlewareType;
    context?: ActiveCompanyPermissionContext | null;
    error?: unknown;
  }
): void {
  logger.warn(
    JSON.stringify({
      event: details.event,
      permType: details.permType,
      key: details.key,
      role: details.context?.role ?? req.session.currentRole ?? "unknown",
      userId: details.context?.userId ?? req.session.userId ?? null,
      companyId: details.context?.companyId ?? req.session.currentCompanyId ?? null,
      method: req.method,
      path: req.path,
      error: details.error instanceof Error ? details.error.message : details.error ? String(details.error) : undefined,
      ts: new Date().toISOString(),
    })
  );
}

function sendDenied(
  req: Request,
  res: Response,
  key: string,
  permType: PermMiddlewareType,
  context: ActiveCompanyPermissionContext
): void {
  logPermissionEvent(req, { event: "access_denied", key, permType, context });
  res.status(403).json({
    message: "Access denied: you do not have permission for this resource.",
    key,
    permType,
  });
}

function sendLookupFailure(
  req: Request,
  res: Response,
  key: string,
  permType: PermMiddlewareType,
  error: unknown
): void {
  if (error instanceof ActiveCompanyPermissionContextError) {
    logPermissionEvent(req, { event: "access_denied", key, permType, error });
    res.status(error.status).json({ message: error.message, code: error.code });
    return;
  }

  // Permission checks are security boundaries. A database or storage failure must
  // never turn into an implicit allow, especially for exports, repairs, imports,
  // POS capabilities, and writes. Return 503 so the caller can safely retry.
  logPermissionEvent(req, { event: "permission_lookup_failed", key, permType, error });
  res.status(503).json({
    message: "Permission service is temporarily unavailable. Please retry.",
    code: "PERMISSION_LOOKUP_UNAVAILABLE",
  });
}

/**
 * Check one permission key for the signed-in caller. Returns true when the
 * request may continue; otherwise the refusal (403, or 503 when permissions
 * cannot be read) has already been sent.
 */
export async function enforcePermissionKey(
  req: Request,
  res: Response,
  key: string,
  permType: PermMiddlewareType = "module"
): Promise<boolean> {
  try {
    const state = await getPermissionState(req);
    if (!canAccess(state.context.role, key, state.permissionMap)) {
      sendDenied(req, res, key, permType, state.context);
      return false;
    }
    return true;
  } catch (error) {
    sendLookupFailure(req, res, key, permType, error);
    return false;
  }
}

/** Permission key attached to `requirePermission` guards so the route access manifest can verify it. */
export const REQUIRED_PERMISSION_METADATA = "requiredPermission";

/**
 * Route-level permission guard. A route that uses one must also list the key
 * under `permission` in config/route-access-manifest.json, where the access
 * boundary enforces it for every request; tests/route-access-manifest.test.ts
 * fails when the two disagree. Do not mount this with `app.use()`: per-prefix
 * permission mounts were replaced by the manifest.
 */
export function requirePermission(key: string, permType: PermMiddlewareType = "module") {
  // Anonymous on purpose: the handler name is part of config/route-manifest.json.
  return Object.assign(
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      // Preserve the existing middleware composition: unauthenticated requests pass
      // through so the route's requireAuth middleware returns the canonical 401.
      if (!req.session?.userId) {
        next();
        return;
      }

      if (await enforcePermissionKey(req, res, key, permType)) next();
    },
    { [REQUIRED_PERMISSION_METADATA]: key }
  );
}

export function requirePageAccess(pageKey: string) {
  return requirePermission(pageKey, "page");
}

export function requireActionAccess(actionKey: string) {
  return requirePermission(actionKey, "action");
}

export function requireSensitiveAccess(fieldKey: string) {
  return requirePermission(fieldKey, "sensitive");
}

export function requireExportAccess(exportKey: string) {
  return requirePermission(exportKey, "export");
}

export function requirePosCapability(permissionKey: string) {
  return requirePermission(permissionKey, "pos");
}
