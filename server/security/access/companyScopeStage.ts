/**
 * Company-scope stage of the manifest access boundary.
 *
 * Binds a signed-in request to its company before any handler runs: resolves
 * the caller's role in that company from the database, refuses caller-supplied
 * company IDs the route's declaration does not allow, and opens the tenant
 * runtime context and database scope that row-level security reads.
 *
 * Which requests may reach beyond their bound company is not decided here. It
 * is declared per route in config/route-access-manifest.json (`companyScope`
 * and `crossCompany`) and arrives as the resolved EffectiveRouteAccess.
 */
import type { Request, Response } from "express";
import { isCreateOnlyWriteBlocked } from "../../services/security/createOnlyWritePolicy";
import { isViewOnlyWriteBlocked } from "../../services/security/viewOnlyWritePolicy";
import { isErpTesterForbiddenApiPath } from "@shared/erpTestCompanyAccess";
import { and, eq, or } from "drizzle-orm";
import { companies, userCompanyRoles } from "@shared/schema";

import { db } from "../../db";
import { logger } from "../../lib/logger";
import {
  assertCompaniesAccess,
  CompanyAccessError,
  getAccessibleCompanyIds,
  isPrivilegedRole,
  sendCompanyAccessError,
} from "../companyAccessBoundary";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
  type ActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";
import {
  assertRequestCompanyMatchesSession,
  CompanyIsolationError,
} from "../../services/security/companyIsolationPolicy";
import { decideExplicitCompanyScope } from "../../services/security/companyRequestScopePolicy";
import { isPinnedCompanyRoute } from "../../services/security/activeCompanyPermissionPolicy";
import { chooseAuthorizedFactoryCompany } from "../../services/security/factoryCompanyScopePolicy";
import { classifyUserLocationConfigurationRoute } from "../../services/security/userLocationConfigurationPolicy";
import { runWithCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
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

function requestPathOf(req: Request): string {
  return req.originalUrl.split("?", 1)[0] || req.path;
}

/**
 * Whether the request is bound to the pinned Factory/Properties company.
 *
 * The declaration is authoritative. resolvePermissionCompanyId, which handlers
 * share, still derives the same answer from the URL; if the two ever disagree
 * the request is refused rather than served under the wrong company.
 */
function resolvePinned(req: Request, access: EffectiveRouteAccess): boolean {
  const pinnedByUrl = isPinnedCompanyRoute(requestPathOf(req));
  if (access.companyScope === "request-resolved") return pinnedByUrl;
  const declaredPinned = access.companyScope === "pinned-company";
  if (declaredPinned !== pinnedByUrl) {
    throw new CompanyAccessError(
      403,
      "Request company scope does not match its declaration",
      "ROUTE_ACCESS_SCOPE_MISMATCH"
    );
  }
  return declaredPinned;
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

async function resolveCanonicalContext(req: Request, pinned: boolean): Promise<ActiveCompanyPermissionContext> {
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
 * Refuse a `:companyId` URL parameter that names a company the declaration
 * does not allow. Parameters are matched from the manifest, so this also
 * covers routes mounted on lazily loaded routers.
 */
async function authorizePathCompanyId(
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

/**
 * Bind the request to its company and run `proceed` inside the tenant runtime
 * context and database scope. Sends the refusal itself when the request is not
 * allowed; unexpected failures go to `fail`.
 *
 * Caller-supplied companyId values never grant authorization. Unless the
 * route declares a `crossCompany` allowance, a companyId in the query, body or
 * URL must equal the bound company. Intercompany source/target fields are
 * membership checked as well.
 */
export async function establishCompanyScope(
  req: Request,
  res: Response,
  access: EffectiveRouteAccess,
  proceed: (context: ActiveCompanyPermissionContext) => void | Promise<void>,
  fail: (error: unknown) => void
): Promise<void> {
  let context: ActiveCompanyPermissionContext | null = null;
  try {
    context = await resolveCanonicalContext(req, resolvePinned(req, access));
    const boundContext = context;

    // Second, canonical Create Only write check. The global guard reads the
    // session role; this one reads the current company membership, so a role
    // changed to Create Only after login cannot carry an older session's writes.
    //
    // Stale-session checks for View Only and ERP Tester: their global guards
    // read the session's copy of the role. When the canonical role has since
    // become View Only or ERP Tester (and the person's sessions could not be
    // removed), refuse here what the global guard would refuse. A session
    // whose role is current is left to the global guard and the route's own
    // checks, exactly as before.
    const sessionRoleIsStale = req.session?.currentRole !== context.role;
    if (sessionRoleIsStale && context.role === "ERP Tester" && isErpTesterForbiddenApiPath(req.path)) {
      logIsolationDenial(req, context, "ERP_TESTER_SETTINGS_DENIED");
      res.status(403).json({
        code: "ERP_TESTER_SETTINGS_DENIED",
        message: "ERP Tester accounts cannot access system settings or user administration",
      });
      return;
    }
    if (sessionRoleIsStale && isViewOnlyWriteBlocked(context.role, req.method, req.path)) {
      logIsolationDenial(req, context, "VIEW_ONLY_WRITE_DENIED");
      res.status(403).json({
        code: "VIEW_ONLY_WRITE_DENIED",
        message: "View Only accounts cannot make changes",
      });
      return;
    }
    if (isCreateOnlyWriteBlocked(context.role, req.method, req.path)) {
      logIsolationDenial(req, context, "CREATE_ONLY_WRITE_NOT_VERIFIED");
      res.status(403).json({
        code: "BUSINESS_ACTION_NOT_VERIFIED",
        message: "This action is not available to Create Only users.",
      });
      return;
    }

    const decision = decideExplicitCompanyScope({
      queryCompanyId: req.query?.companyId,
      bodyCompanyId: (req.body as Record<string, unknown> | undefined)?.companyId,
    });

    if (decision.kind === "invalid") {
      res.status(400).json({
        code: "COMPANY_ID_INVALID",
        message: `Invalid companyId in request ${decision.source}.`,
      });
      return;
    }
    if (decision.kind === "conflict") {
      res.status(400).json({
        code: "COMPANY_ID_CONFLICT",
        message: "All companyId values in the request must match.",
      });
      return;
    }

    let explicitAuthorizedCompanyId: number | null = null;
    if (decision.kind === "company") {
      const otherCompany = decision.companyId !== context.companyId;
      // Legacy admin/configuration pickers that intentionally read reference
      // data from another assigned company.
      const crossCompanyReference = otherCompany && access.crossCompany.has("reference-read");
      // Settings -> Users is intentionally a global Developer administration
      // surface, narrowly limited to company-role assignments.
      const developerRoleAdministration =
        otherCompany && context.role === "Developer" && access.crossCompany.has("developer-role-administration");
      if (crossCompanyReference) {
        if (!isPrivilegedRole(context.role)) {
          throw new CompanyAccessError(
            403,
            "Cross-company reference access requires Admin, Owner, or Developer",
            "CROSS_COMPANY_REFERENCE_FORBIDDEN"
          );
        }
        await assertCompaniesAccess(context.userId, [decision.companyId]);
        explicitAuthorizedCompanyId = decision.companyId;
      } else if (developerRoleAdministration) {
        await assertCompaniesAccess(context.userId, [decision.companyId]);
        explicitAuthorizedCompanyId = decision.companyId;
      } else {
        assertRequestCompanyMatchesSession(
          { userId: context.userId, role: context.role, companyId: context.companyId },
          decision.companyId
        );
      }
    }

    // POS role setup performs follow-up reads/writes whose target company is in
    // the route path rather than query/body. Authorize only that explicit
    // company for Developer; the route-level user/location ownership guards
    // still validate the target user, locations, and cash accounts.
    const userLocationRoute =
      context.role === "Developer" && access.crossCompany.has("developer-user-location")
        ? classifyUserLocationConfigurationRoute(req.path)
        : null;
    if (userLocationRoute && userLocationRoute.companyId !== context.companyId) {
      await assertCompaniesAccess(context.userId, [userLocationRoute.companyId]);
      explicitAuthorizedCompanyId = userLocationRoute.companyId;
    }

    for (const raw of access.pathCompanyIds) {
      if (!(await authorizePathCompanyId(req, res, access, context, raw))) return;
    }

    const secondaryCompanyIds = collectSecondaryCompanyIds(req);
    if (secondaryCompanyIds.length > 0) {
      await assertCompaniesAccess(context.userId, secondaryCompanyIds);
    }

    // Server-trusted cross-company surfaces stay bounded by the user's own
    // memberships, never by a client-supplied company ID.
    const useGlobalAuthorizedCompanyScope = access.crossCompany.has("authorized-companies");
    const useExplicitAuthorizedCompanyScope = explicitAuthorizedCompanyId !== null;
    const useAuthorizedCompanyScope = useGlobalAuthorizedCompanyScope || useExplicitAuthorizedCompanyScope;
    const databaseAuthorizedCompanyIds = useGlobalAuthorizedCompanyScope
      ? [...(await getAccessibleCompanyIds(context.userId))]
      : useExplicitAuthorizedCompanyScope
        ? [explicitAuthorizedCompanyId!, ...secondaryCompanyIds]
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
      () => runWithDatabaseScopeRuntimeContext(databaseScope, () => proceed(boundContext))
    );
  } catch (error) {
    if (error instanceof CompanyIsolationError) {
      logIsolationDenial(req, context, error.code);
      res.status(403).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof ActiveCompanyPermissionContextError) {
      logIsolationDenial(req, context, error.code);
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof CompanyAccessError) {
      logIsolationDenial(req, context, error.code);
      sendCompanyAccessError(res, error);
      return;
    }
    fail(error);
  }
}
