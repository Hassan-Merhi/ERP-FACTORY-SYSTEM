// Extracted from ./auth.ts
import { Request, Response, NextFunction } from "express";
import { logDenied } from "./authDenialLog";
import { db } from "./db";
import { userLocations } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { enforceRuntimeSession } from "./services/security/sessionEnforcementAdapter";
import { hydrateActiveCredentialVersion } from "./services/security/credentialVersionService";
import { CompanyIsolationError, assertRequestCompanyMatchesSession } from "./services/security/companyIsolationPolicy";
import { decideExplicitCompanyScope } from "./services/security/companyRequestScopePolicy";
import { canReadAccountMigrationSource } from "./services/security/accountMigrationRequestPolicy";

const OWNER_PROTECTED_DELETE_PREFIXES = [
  "/api/accounts",
  "/api/ledger-accounts",
  "/api/bank-accounts",
  "/api/account-groups",
];

export function isOwnerProtectedDeleteRequest(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.toLowerCase();
  const isDeleteRequest =
    normalizedMethod === "DELETE" ||
    (normalizedMethod !== "GET" && normalizedMethod !== "HEAD" && normalizedPath.includes("/bulk-delete"));

  if (!isDeleteRequest) return false;

  const isVoucherDelete = normalizedPath.includes("/voucher");
  const isAccountDelete = OWNER_PROTECTED_DELETE_PREFIXES.some(
    (prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );

  return isVoucherDelete || isAccountDelete;
}

export function rejectInvalidSession(
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

export async function enforceCredentialAwareSession(
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

export function authorizeExplicitCompanyScope(req: Request, res: Response): boolean {
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

  // Account Migration is an intentional cross-company Admin read. The global
  // :companyId guard and the route handler each verify actual user membership
  // before returning accounts. Do not grant the same override to ordinary
  // ledger endpoints or write requests.
  if (canReadAccountMigrationSource(req.method, req.path, role)) return true;

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

/** Role lists attached to `requireRole` guards so the route access manifest can verify them. */
export const REQUIRED_ROLES_METADATA = "requiredRoles";

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
