import { Request, Response, NextFunction } from "express";
import { logger } from "./lib/logger";
import { db } from "./db";
import { userLocations } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { getClientDate } from "./lib/dateUtils";
import { enforceRuntimeSession } from "./services/security/sessionEnforcementAdapter";
import { hydrateActiveCredentialVersion } from "./services/security/credentialVersionService";
import { CompanyIsolationError, assertRequestCompanyMatchesSession } from "./services/security/companyIsolationPolicy";
import { decideExplicitCompanyScope } from "./services/security/companyRequestScopePolicy";

const EXPECTED_ANONYMOUS_SESSION_REASONS = new Set(["SESSION_REQUIRED", "SESSION_USER_REQUIRED"]);

// Session expiry is a normal lifecycle event (browser left open, user idle, etc.).
// Log at WARN so operators can distinguish routine expiry from real security incidents.
const SESSION_EXPIRY_REASONS = new Set([
  "SESSION_IDLE_EXPIRED",
  "SESSION_ABSOLUTE_EXPIRED",
  "SESSION_TIMESTAMPS_INVALID",
  "SESSION_COMPANY_REQUIRED",
]);

function logDenied(params: {
  userId?: string | null;
  username?: string | null;
  role?: string | null;
  companyId?: number | null;
  method: string;
  path: string;
  reason: string;
}) {
  const payload = JSON.stringify({
    event: "access_denied",
    ts: new Date().toISOString(),
    userId: params.userId ?? null,
    role: params.role ?? null,
    companyId: params.companyId ?? null,
    method: params.method,
    path: params.path,
    reason: params.reason,
  });

  const isExpectedAnonymousRequest = !params.userId && EXPECTED_ANONYMOUS_SESSION_REASONS.has(params.reason);

  if (isExpectedAnonymousRequest) {
    logger.info(payload);
    return;
  }

  if (SESSION_EXPIRY_REASONS.has(params.reason)) {
    logger.warn(payload);
    return;
  }

  logger.error(payload);
}

function rejectInvalidSession(
  req: Request,
  res: Response,
  result: ReturnType<typeof enforceRuntimeSession>,
  fallbackMessage: string
) {
  logDenied({
    userId: req.session.userId ?? null,
    username: req.session.username ?? null,
    role: req.session.currentRole ?? null,
    companyId: req.session.currentCompanyId ?? null,
    method: req.method,
    path: req.path,
    reason: result.code,
  });

  if (result.destroySession) {
    req.session.destroy(() => undefined);
  }

  return res.status(result.status).json({ message: fallbackMessage });
}

async function enforceCredentialAwareSession(
  req: Request,
  options: { requireCompanyContext: boolean; requireRecentPasswordConfirmation?: boolean }
) {
  if (req.session.userId) {
    await hydrateActiveCredentialVersion(
      db,
      req.session as unknown as Parameters<typeof hydrateActiveCredentialVersion>[1]
    );
  }
  return enforceRuntimeSession(req.session as unknown as Parameters<typeof enforceRuntimeSession>[0], options);
}

function authorizeExplicitCompanyScope(req: Request, res: Response): boolean {
  const decision = decideExplicitCompanyScope({
    queryCompanyId: req.query?.companyId,
    bodyCompanyId: (req.body as Record<string, unknown> | undefined)?.companyId,
    pathCompanyId: req.params?.companyId,
  });

  if (decision.kind === "none") return true;

  if (decision.kind === "invalid") {
    res.status(400).json({
      code: "COMPANY_ID_INVALID",
      message: `Invalid companyId in request ${decision.source}.`,
    });
    return false;
  }

  if (decision.kind === "conflict") {
    res.status(400).json({
      code: "COMPANY_ID_CONFLICT",
      message: "All companyId values in the request must match.",
    });
    return false;
  }

  if (req.method === "POST" && req.path === "/api/auth/set-company") {
    return true;
  }

  const userId = req.session.userId;
  const role = req.session.currentRole;

  // Developer is the system-wide support/admin role. Its company access is
  // already constrained by the role-specific route policies and canonical
  // company lookups, so it must be able to send an explicit target company
  // when managing roles, locations, ledgers, and other cross-company settings.
  // This restores the intended behavior that was lost during later hardening.
  if (role === "Developer") return true;

  const companyId = req.session.currentCompanyId ?? null;

  try {
    assertRequestCompanyMatchesSession(
      userId && role && companyId ? { userId, role, companyId } : null,
      decision.companyId
    );
    return true;
  } catch (error) {
    if (!(error instanceof CompanyIsolationError)) throw error;

    logDenied({
      userId: userId ?? null,
      username: req.session.username ?? null,
      role: role ?? null,
      companyId: decision.companyId,
      method: req.method,
      path: req.path,
      reason: error.code,
    });
    res.status(403).json({ code: error.code, message: error.message });
    return false;
  }
}

export async function requireLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await enforceCredentialAwareSession(req, {
      requireCompanyContext: false,
    });
    if (!result.valid) {
      return rejectInvalidSession(req, res, result, "Unauthorized");
    }
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionResult = await enforceCredentialAwareSession(req, {
      requireCompanyContext: true,
    });
    if (!sessionResult.valid) {
      const message = sessionResult.code === "SESSION_COMPANY_REQUIRED" ? "No company selected" : "Unauthorized";
      return rejectInvalidSession(req, res, sessionResult, message);
    }

    const role = req.session.currentRole;
    if (!role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!authorizeExplicitCompanyScope(req, res)) return;

    req.user = {
      id: req.session.userId,
      username: req.session.username,
      role,
      assignedLocationId: req.session.currentLocationId ?? null,
      posStation: req.session.currentPOSStation ?? null,
      cashAccountId: req.session.cashAccountId ?? null,
      canSellNegativeStock: ["Admin", "Owner", "Manager", "Developer"].includes(role)
        ? true
        : (req.session.canSellNegativeStock ?? false),
      posViewOnly: req.session.posViewOnly ?? false,
      daybookEditDays: req.session.daybookEditDays ?? 0,
      canAccessCustomers: req.session.canAccessCustomers ?? false,
      canDeleteRecords: req.session.canDeleteRecords ?? false,
    } as unknown as {
      id: string | undefined;
      username: string | undefined;
      role: string;
      assignedLocationId: number | null;
      posStation: number | null;
      cashAccountId: number | null;
      canSellNegativeStock: boolean;
      posViewOnly: boolean;
      daybookEditDays: number;
      canAccessCustomers: boolean;
      canDeleteRecords: boolean;
    } & (
      | ({
          id: string;
          active: boolean;
          createdAt: Date;
          username: string;
          password: string;
          chatbotEnabled: boolean;
          hiddenErpCostFields: string[];
        } & {
          role?: string;
          assignedLocationId?: number | null;
          posStation?: number | null;
          cashAccountId?: number | null;
          canSellNegativeStock?: boolean;
          daybookEditDays?: number;
          canAccessCustomers?: boolean;
        })
      | undefined
    );

    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (req.user.role === "Developer" || roles.includes(req.user.role)) {
      return next();
    }

    return res.status(403).json({ message: "Forbidden" });
  };
}

export function canDelete(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const role = req.user.role;
  const path = req.path;
  const method = req.method;
  const userId = req.session.userId ?? null;
  const username = req.session.username ?? null;
  const companyId = req.session.currentCompanyId ?? null;

  if (role === "Developer" || role === "Admin") {
    return next();
  }

  if (role === "Owner") {
    logDenied({ userId, username, role, companyId, method, path, reason: "Owner role cannot delete records" });
    return res.status(403).json({ message: "Owners cannot delete records" });
  }

  if (role === "POS") {
    logDenied({ userId, username, role, companyId, method, path, reason: "POS role cannot delete records" });
    return res.status(403).json({ message: "POS users cannot delete records" });
  }

  if (req.session.canDeleteRecords === true) {
    return next();
  }

  if (role === "Manager") {
    logDenied({ userId, username, role, companyId, method, path, reason: "Manager without canDeleteRecords flag" });
    return res.status(403).json({ message: "This manager account does not have delete permission" });
  }

  logDenied({
    userId,
    username,
    role,
    companyId,
    method,
    path,
    reason: `Role '${role}' is not permitted to delete records`,
  });
  return res.status(403).json({ message: "You do not have permission to delete records" });
}

export function canModifyDate(dateField: string = "voucherDate") {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const role = req.user.role;
    if (role === "Admin" || role === "Developer") return next();

    const recordDate: string | undefined = req.body[dateField];
    if (!recordDate) return next();

    const today = getClientDate(req);
    if (role === "POS") {
      if (recordDate !== today) {
        return res.status(403).json({ message: "You can only create or modify records for today's date" });
      }
      return next();
    }

    if (role === "Manager" || role === "Owner") {
      if (recordDate === today) return next();
      const editDays = req.session.daybookEditDays ?? 0;
      if (editDays === 0) {
        return res.status(403).json({ message: "You can only create or modify records for today's date" });
      }
      const todayMs = new Date(today).getTime();
      const recordMs = new Date(recordDate).getTime();
      const diffDays = Math.floor((todayMs - recordMs) / 86_400_000);
      if (diffDays < 0 || diffDays > editDays) {
        return res.status(403).json({ message: `You can only modify records within ${editDays} day(s) of today` });
      }
      return next();
    }

    next();
  };
}

export async function checkPOSLocation(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (req.user.role !== "POS") {
      return next();
    }

    const rawLocationId = req.params.locationId ?? req.body?.locationId ?? req.query.locationId;
    const locationId = Number.parseInt(String(rawLocationId ?? ""), 10);

    if (!Number.isInteger(locationId) || locationId <= 0) {
      return next();
    }

    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      return res.status(403).json({ message: "No company selected" });
    }

    const [assignment] = await db
      .select({ id: userLocations.id })
      .from(userLocations)
      .where(
        and(
          eq(userLocations.userId, req.user.id),
          eq(userLocations.companyId, companyId),
          eq(userLocations.locationId, locationId)
        )
      )
      .limit(1);

    if (!assignment) {
      return res.status(403).json({ message: "You can only access data for your assigned locations" });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

export async function requirePasswordConfirmation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await enforceCredentialAwareSession(req, {
      requireCompanyContext: true,
      requireRecentPasswordConfirmation: true,
    });
    if (!result.valid) {
      const message =
        result.code === "SESSION_PASSWORD_CONFIRMATION_REQUIRED" ? "Password confirmation required" : "Unauthorized";
      return rejectInvalidSession(req, res, result, message);
    }
    next();
  } catch (error) {
    next(error);
  }
}

const VIEW_ONLY_PASSIVE_LIFECYCLE_WRITES = new Set([
  "PATCH /api/user-presence",
  "DELETE /api/user-presence",
  "POST /api/user-presence/leave",
  "POST /api/screen-feed",
  "POST /api/screen-feed/pointer",
  "POST /api/screen-feed/control/tab-heartbeat",
]);

/**
 * View Only accounts must stay read-only for ERP business data, but a few
 * authenticated writes are transport/lifecycle operations rather than business
 * mutations. These exact paths keep presence, Remote Support capture/control
 * acknowledgements, and the target emergency-stop working without opening a
 * broad /api/screen-feed write exemption.
 *
 * Route-level requireLogin/requireAuth, target-user/session checks, CSRF, and
 * remote-support sensitive-action policies still execute after this middleware.
 */
function isViewOnlyPassiveLifecycleWrite(req: Request): boolean {
  const method = req.method.toUpperCase();
  const path = req.path;
  if (VIEW_ONLY_PASSIVE_LIFECYCLE_WRITES.has(`${method} ${path}`)) return true;
  if (method !== "POST") return false;

  return (
    /^\/api\/screen-feed\/control\/sessions\/[^/]+\/commands\/[^/]+\/result$/.test(path) ||
    /^\/api\/screen-feed\/control\/sessions\/[^/]+\/keyboard-commands\/[^/]+\/result$/.test(path) ||
    /^\/api\/screen-feed\/control\/sessions\/[^/]+\/stop$/.test(path)
  );
}

export function blockViewOnlyWrites(req: Request, res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (!req.path.startsWith("/api")) return next();
  if (req.path.startsWith("/api/auth/")) return next();
  if (isViewOnlyPassiveLifecycleWrite(req)) return next();

  const role = req.session?.currentRole;
  if (role === "View Only") {
    logDenied({
      userId: req.session.userId ?? null,
      username: req.session.username ?? null,
      role,
      companyId: req.session.currentCompanyId ?? null,
      method: req.method,
      path: req.path,
      reason: "View Only role attempted a write operation",
    });
    return res.status(403).json({ message: "View Only accounts cannot make changes" });
  }
  next();
}

export function requireNonPOS(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.user.role) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const isPOS = req.user.role === "POS";
  if (isPOS) {
    logDenied({
      userId: req.session.userId ?? null,
      username: req.session.username ?? null,
      role: req.user.role,
      companyId: req.session.currentCompanyId ?? null,
      method: req.method,
      path: req.path,
      reason: "POS role attempted access to non-POS route",
    });
    return res.status(403).json({ message: "Access denied: This resource is not available for POS users" });
  }

  next();
}
