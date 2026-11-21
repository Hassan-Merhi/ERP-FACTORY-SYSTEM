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

import {
  assertCompaniesAccess,
  CompanyAccessError,
  getAccessibleCompanyIds,
  sendCompanyAccessError,
} from "../companyAccessBoundary";
import {
  ActiveCompanyPermissionContextError,
  type ActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";
import {
  assertRequestCompanyMatchesSession,
  CompanyIsolationError,
} from "../../services/security/companyIsolationPolicy";
import { decideExplicitCompanyScope } from "../../services/security/companyRequestScopePolicy";
import { isPinnedCompanyRoute } from "../../services/security/activeCompanyPermissionPolicy";
import { classifyUserLocationConfigurationRoute } from "../../services/security/userLocationConfigurationPolicy";
import { runWithCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import type { EffectiveRouteAccess } from "./routeAccessManifest";
import {
  requestPathOf,
  resolveCanonicalContext,
  collectSecondaryCompanyIds,
  logIsolationDenial,
  authorizePathCompanyId,
} from "./companyScopeStageHelpers";

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

/**
 * Authorize every `:companyId` URL parameter of the matched route. Returns
 * true when the request may continue; otherwise the refusal has been sent.
 *
 * The boundary calls this last, after the route's policies, which is where
 * the Express parameter hook it replaces used to run: a policy that hides a
 * foreign record with 404 still answers before this check's 403.
 */
export async function authorizePathCompanyIds(
  req: Request,
  res: Response,
  access: EffectiveRouteAccess,
  context: ActiveCompanyPermissionContext
): Promise<boolean> {
  try {
    for (const raw of access.pathCompanyIds) {
      if (!(await authorizePathCompanyId(req, res, access, context, raw))) return false;
    }
    return true;
  } catch (error) {
    if (error instanceof CompanyIsolationError) {
      logIsolationDenial(req, context, error.code);
      res.status(403).json({ code: error.code, message: error.message });
      return false;
    }
    if (error instanceof CompanyAccessError) {
      logIsolationDenial(req, context, error.code);
      sendCompanyAccessError(res, error);
      return false;
    }
    throw error;
  }
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
  fail: (error: unknown) => void,
  /**
   * Called instead of sending the 401/403 when the session has no usable
   * company. Used for URLs that name no route, which answer 404 either way.
   */
  onCompanyUnavailable?: () => void
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
      // Settings -> Users is intentionally a global Developer administration
      // surface, narrowly limited to company-role assignments.
      const developerRoleAdministration =
        otherCompany && context.role === "Developer" && access.crossCompany.has("developer-role-administration");
      if (developerRoleAdministration) {
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
      if (onCompanyUnavailable) {
        onCompanyUnavailable();
        return;
      }
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
