// Extracted from ./companyScopeStage.ts
import type { Request, Response } from "express";
import { and, eq, or } from "drizzle-orm";
import { companies, userCompanyRoles } from "@shared/schema";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { assertCompaniesAccess, CompanyAccessError } from "../companyAccessBoundary";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
  type ActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";
import { assertRequestCompanyMatchesSession } from "../../services/security/companyIsolationPolicy";
import { chooseAuthorizedFactoryCompany } from "../../services/security/factoryCompanyScopePolicy";
import { classifyUserLocationConfigurationRoute } from "../../services/security/userLocationConfigurationPolicy";
import type { EffectiveRouteAccess } from "./routeAccessManifest";

// The abbreviated srcCompanyId/destCompanyId spellings belong to the
// account-migration admin routes. Without them the destination company is
// never membership-checked here and never reaches the request runtime
// context, so a migration that has to post into the destination company is
// refused by assertTransactionCompanyScope. Those routes check both companies
// themselves as well; recognising the names adds the boundary check rather
// than replacing theirs.
const SECONDARY_COMPANY_FIELDS = [
  "sourceCompanyId",
  "destinationCompanyId",
  "srcCompanyId",
  "destCompanyId",
  "targetCompanyId",
  "fromCompanyId",
  "toCompanyId",
  "sellerCompanyId",
  "buyerCompanyId",
] as const;

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function requestPathOf(req: Request): string {
  return req.originalUrl.split("?", 1)[0] || req.path;
}

async function ensurePinnedFactoryCompany(req: Request, pinned: boolean): Promise<void> {
  const path = requestPathOf(req);
  const normalizedPath = path.toLowerCase();
  if (!pinned || !(normalizedPath === "/api/factory" || normalizedPath.startsWith("/api/factory/"))) {
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

export async function resolveCanonicalContext(req: Request, pinned: boolean): Promise<ActiveCompanyPermissionContext> {
  await ensurePinnedFactoryCompany(req, pinned);

  try {
    return await getActiveCompanyPermissionContext(req);
  } catch (error) {
    if (
      error instanceof ActiveCompanyPermissionContextError &&
      error.code === "ACTIVE_COMPANY_ROLE_REQUIRED" &&
      req.session.currentRole === "Developer" &&
      req.session.userId
    ) {
      const companyId = pinned
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

export function collectSecondaryCompanyIds(req: Request): number[] {
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

export function logIsolationDenial(req: Request, context: ActiveCompanyPermissionContext | null, code: string) {
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
 * Refuse a `:companyId` URL parameter that names a company the declaration
 * does not allow. Parameters are matched from the manifest, so this also
 * covers routes mounted on lazily loaded routers.
 */
export async function authorizePathCompanyId(
  req: Request,
  res: Response,
  access: EffectiveRouteAccess,
  context: ActiveCompanyPermissionContext,
  raw: string
): Promise<boolean> {
  const companyId = positiveId(raw);
  if (!companyId) {
    res.status(400).json({ code: "COMPANY_ID_INVALID", message: "Invalid companyId in request path." });
    return false;
  }
  // This read-only Admin tool intentionally chooses a *different* company
  // before starting a migration. The route itself independently checks role
  // and membership and binds an explicit transaction-local RLS scope.
  if (access.crossCompany.has("account-migration-source")) {
    if (context.role !== "Admin" && context.role !== "Developer") {
      res.status(403).json({
        code: "ACCOUNT_MIGRATION_ROLE_REQUIRED",
        message: "Admin or Developer access required for account migration.",
      });
      return false;
    }
    await assertCompaniesAccess(context.userId, [companyId]);
    return true;
  }
  if (access.crossCompany.has("developer-user-location") && context.role === "Developer") {
    const userLocationRoute = classifyUserLocationConfigurationRoute(req.path);
    if (userLocationRoute?.companyId === companyId) {
      await assertCompaniesAccess(context.userId, [companyId]);
      return true;
    }
  }
  assertRequestCompanyMatchesSession(
    { userId: context.userId, role: context.role, companyId: context.companyId },
    companyId
  );
  return true;
}
