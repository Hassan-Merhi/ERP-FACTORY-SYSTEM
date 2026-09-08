import type { NextFunction, Request, Response } from "express";
import { and, eq, or } from "drizzle-orm";
import { companies, userCompanyRoles } from "@shared/schema";

import { db } from "../db";
import { logger } from "../lib/logger";
import {
  assertCompaniesAccess,
  CompanyAccessError,
  getAccessibleCompanyIds,
  isPrivilegedRole,
  sendCompanyAccessError,
} from "../security/companyAccessBoundary";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
  type ActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { assertRequestCompanyMatchesSession, CompanyIsolationError } from "../services/security/companyIsolationPolicy";
import { decideExplicitCompanyScope } from "../services/security/companyRequestScopePolicy";
import { isPinnedCompanyRoute } from "../services/security/activeCompanyPermissionPolicy";
import { chooseAuthorizedFactoryCompany } from "../services/security/factoryCompanyScopePolicy";
import { runWithCompanyRequestRuntimeContext } from "../services/security/companyRequestRuntimeContext";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../services/security/databaseScopeRuntimeContext";

const CONTEXT_OPTIONAL_PATHS = new Set([
  "/api/csrf-token",
  "/api/build-info",
  "/api/boot",
  "/api/user/companies",
  "/api/auth/session-company",
  "/api/auth/set-company",
]);

const SECONDARY_COMPANY_FIELDS = [
  "sourceCompanyId",
  "destinationCompanyId",
  "targetCompanyId",
  "fromCompanyId",
  "toCompanyId",
  "sellerCompanyId",
  "buyerCompanyId",
] as const;

const CROSS_COMPANY_REFERENCE_READ_PATHS = new Set(["/api/locations", "/api/ledger-accounts"]);

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isContextOptionalPath(path: string): boolean {
  if (CONTEXT_OPTIONAL_PATHS.has(path)) return true;
  if (path === "/api/health" || path.startsWith("/api/health/")) return true;
  if (path === "/api/auth" || path.startsWith("/api/auth/")) {
    return path !== "/api/auth/set-company";
  }
  return false;
}

/**
 * Server-trusted cross-company read surfaces.
 *
 * Payroll bonuses are configured per source company: an employee of one company
 * earns on sales a sister company posted (GC-LSHI sells at locations owned by
 * another company). Those reads stay bounded by getAccessibleCompanyIds, never
 * by a client-supplied company ID, exactly like the global transactions view.
 */
const AUTHORIZED_CROSS_COMPANY_PATHS = new Set(["/api/payroll/bonus-locations", "/api/payroll/auto-calculate-bonuses"]);

function isAuthorizedCrossCompanyPath(path: string): boolean {
  if (AUTHORIZED_CROSS_COMPANY_PATHS.has(path)) return true;
  if (/^\/api\/purchase-orders\/\d+\/sync-parent-voucher$/.test(path)) return true;
  return path === "/api/global/transactions" || path.startsWith("/api/global/transactions/");
}

/**
 * A small compatibility surface for legacy admin/configuration pickers that
 * intentionally read reference data from another assigned company. The actual
 * privileged-role and membership checks happen in tenantIsolationBoundary.
 */
export function isCrossCompanyReferenceRead(method: string, path: string): boolean {
  return method.toUpperCase() === "GET" && CROSS_COMPANY_REFERENCE_READ_PATHS.has(path);
}

async function ensurePinnedFactoryCompany(req: Request): Promise<void> {
  const path = req.originalUrl.split("?", 1)[0] || req.path;
  const normalizedPath = path.toLowerCase();
  if (
    !isPinnedCompanyRoute(path) ||
    !(normalizedPath === "/api/factory" || normalizedPath.startsWith("/api/factory/"))
  ) {
    return;
  }

  const session = req.session;
  if (positiveId(session.factoryCompanyId)) return;
  if (!session.userId) return;

  const assignedFactories = await db
    .select({ id: companies.id, companyType: companies.companyType, active: companies.active })
    .from(userCompanyRoles)
    .innerJoin(companies, eq(companies.id, userCompanyRoles.companyId))
    .where(
      and(
        eq(userCompanyRoles.userId, session.userId),
        eq(companies.active, true),
        or(eq(companies.companyType, "factory"), eq(companies.companyType, "factory_v2"))
      )
    )
    .orderBy(companies.id);

  let currentCompany = assignedFactories.find((company) => company.id === session.currentCompanyId) ?? null;
  const developerCurrentCompanyId = positiveId(session.currentCompanyId);
  if (!currentCompany && session.currentRole === "Developer" && developerCurrentCompanyId) {
    const [developerCurrent] = await db
      .select({ id: companies.id, companyType: companies.companyType, active: companies.active })
      .from(companies)
      .where(eq(companies.id, developerCurrentCompanyId))
      .limit(1);
    if (
      developerCurrent?.active &&
      (developerCurrent.companyType === "factory" || developerCurrent.companyType === "factory_v2")
    ) {
      currentCompany = developerCurrent;
      assignedFactories.unshift(developerCurrent);
    }
  }

  const factoryCompanyId = chooseAuthorizedFactoryCompany({
    pinnedFactoryId: session.factoryCompanyId,
    currentCompany,
    assignedFactoryIds: assignedFactories.map((company) => company.id),
  });

  if (!factoryCompanyId) {
    if (session.currentRole === "Developer" && developerCurrentCompanyId) {
      return;
    }

    throw new ActiveCompanyPermissionContextError(
      "You do not have access to a Factory company.",
      403,
      "ACTIVE_COMPANY_ROLE_REQUIRED"
    );
  }

  session.factoryCompanyId = factoryCompanyId;
}

async function resolveCanonicalContext(req: Request): Promise<ActiveCompanyPermissionContext> {
  await ensurePinnedFactoryCompany(req);

  try {
    return await getActiveCompanyPermissionContext(req);
  } catch (error) {
    if (
      error instanceof ActiveCompanyPermissionContextError &&
      error.code === "ACTIVE_COMPANY_ROLE_REQUIRED" &&
      req.session.currentRole === "Developer" &&
      req.session.userId
    ) {
      const path = req.originalUrl.split("?", 1)[0] || req.path;
      const companyId = isPinnedCompanyRoute(path)
        ? (positiveId(req.session.factoryCompanyId) ?? positiveId(req.session.currentCompanyId))
        : positiveId(req.session.currentCompanyId);
      if (companyId) {
        return {
          userId: req.session.userId,
          companyId,
          role: "Developer",
          developerBypass: true,
          assignedLocationId: null,
          cashAccountId: null,
          posStation: null,
          canSellNegativeStock: true,
          posViewOnly: false,
          daybookEditDays: 9999,
          canAccessCustomers: true,
          canDeleteRecords: true,
        };
      }
    }
    throw error;
  }
}

function collectSecondaryCompanyIds(req: Request): number[] {
  const sources: Array<Record<string, unknown> | undefined> = [
    req.query as Record<string, unknown> | undefined,
    req.body as Record<string, unknown> | undefined,
  ];
  const result = new Set<number>();

  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const field of SECONDARY_COMPANY_FIELDS) {
      const raw = source[field];
      if (raw === undefined || raw === null || raw === "") continue;
      const companyId = positiveId(raw);
      if (!companyId) {
        throw new CompanyAccessError(400, `${field} must be a positive integer`, "INVALID_COMPANY_ID");
      }
      result.add(companyId);
    }
  }

  return [...result];
}

function logIsolationDenial(req: Request, context: ActiveCompanyPermissionContext | null, code: string) {
  logger.error(
    JSON.stringify({
      event: "tenant_request_scope_denied",
      ts: new Date().toISOString(),
      userId: context?.userId ?? req.session.userId ?? null,
      role: context?.role ?? req.session.currentRole ?? null,
      activeCompanyId: context?.companyId ?? req.session.currentCompanyId ?? null,
      method: req.method,
      path: req.path,
      code,
    })
  );
}

/**
 * Global tenant boundary installed before application routes.
 *
 * Caller-supplied companyId values never grant authorization. Ordinary tenant
 * routes still require primary companyId to equal the active company. The two
 * legacy reference pickers (locations and ledger accounts) may target another
 * assigned company only for Admin/Owner/Developer callers and only after
 * canonical membership verification. Intercompany source/target fields remain
 * membership checked as well.
 */
export async function tenantIsolationBoundary(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api")) return next();
  if (!req.session?.userId) return next();
  if (isContextOptionalPath(req.path)) return next();

  let context: ActiveCompanyPermissionContext | null = null;
  try {
    context = await resolveCanonicalContext(req);

    const decision = decideExplicitCompanyScope({
      queryCompanyId: req.query?.companyId,
      bodyCompanyId: (req.body as Record<string, unknown> | undefined)?.companyId,
    });

    if (decision.kind === "invalid") {
      return res.status(400).json({
        code: "COMPANY_ID_INVALID",
        message: `Invalid companyId in request ${decision.source}.`,
      });
    }
    if (decision.kind === "conflict") {
      return res.status(400).json({
        code: "COMPANY_ID_CONFLICT",
        message: "All companyId values in the request must match.",
      });
    }

    let referenceCompanyId: number | null = null;
    if (decision.kind === "company") {
      const crossCompanyReference =
        decision.companyId !== context.companyId && isCrossCompanyReferenceRead(req.method, req.path);
      if (crossCompanyReference) {
        if (!isPrivilegedRole(context.role)) {
          throw new CompanyAccessError(
            403,
            "Cross-company reference access requires Admin, Owner, or Developer",
            "CROSS_COMPANY_REFERENCE_FORBIDDEN"
          );
        }
        await assertCompaniesAccess(context.userId, [decision.companyId]);
        referenceCompanyId = decision.companyId;
      } else {
        assertRequestCompanyMatchesSession(
          { userId: context.userId, role: context.role, companyId: context.companyId },
          decision.companyId
        );
      }
    }

    const secondaryCompanyIds = collectSecondaryCompanyIds(req);
    if (secondaryCompanyIds.length > 0) {
      await assertCompaniesAccess(context.userId, secondaryCompanyIds);
    }

    const useGlobalAuthorizedCompanyScope = isAuthorizedCrossCompanyPath(req.path);
    const useReferenceAuthorizedCompanyScope = referenceCompanyId !== null;
    const useAuthorizedCompanyScope = useGlobalAuthorizedCompanyScope || useReferenceAuthorizedCompanyScope;
    const databaseAuthorizedCompanyIds = useGlobalAuthorizedCompanyScope
      ? [...(await getAccessibleCompanyIds(context.userId))]
      : useReferenceAuthorizedCompanyScope
        ? [referenceCompanyId!, ...secondaryCompanyIds]
        : secondaryCompanyIds;
    const databaseScope = createTenantDatabaseScope(
      context.companyId,
      databaseAuthorizedCompanyIds,
      useAuthorizedCompanyScope ? "authorized-companies" : "active-company"
    );

    return runWithCompanyRequestRuntimeContext(
      {
        userId: context.userId,
        companyId: context.companyId,
        authorizedCompanyIds: databaseScope.authorizedCompanyIds,
        role: context.role,
        developerBypass: context.developerBypass,
        method: req.method,
        path: req.path,
      },
      () => runWithDatabaseScopeRuntimeContext(databaseScope, () => next())
    );
  } catch (error) {
    if (error instanceof CompanyIsolationError) {
      logIsolationDenial(req, context, error.code);
      return res.status(403).json({ code: error.code, message: error.message });
    }
    if (error instanceof ActiveCompanyPermissionContextError) {
      logIsolationDenial(req, context, error.code);
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    if (error instanceof CompanyAccessError) {
      logIsolationDenial(req, context, error.code);
      return sendCompanyAccessError(res, error);
    }
    return next(error);
  }
}

/**
 * Express parameter hook for routes that explicitly name `:companyId`.
 * Params are not populated yet when the global app middleware runs, so this
 * closes the remaining path-parameter gap after route matching.
 */
export async function tenantCompanyParamBoundary(req: Request, res: Response, next: NextFunction, raw: string) {
  if (!req.session?.userId) return next();
  if (req.method === "POST" && req.path === "/api/auth/set-company") return next();

  try {
    const context = await resolveCanonicalContext(req);
    const companyId = positiveId(raw);
    if (!companyId) {
      return res.status(400).json({ code: "COMPANY_ID_INVALID", message: "Invalid companyId in request path." });
    }
    assertRequestCompanyMatchesSession(
      { userId: context.userId, role: context.role, companyId: context.companyId },
      companyId
    );
    return next();
  } catch (error) {
    if (error instanceof CompanyIsolationError) {
      logIsolationDenial(req, null, error.code);
      return res.status(403).json({ code: error.code, message: error.message });
    }
    if (error instanceof ActiveCompanyPermissionContextError) {
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    return next(error);
  }
}
