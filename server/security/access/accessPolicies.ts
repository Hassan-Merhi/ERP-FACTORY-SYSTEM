/**
 * Named policy resolvers of the manifest access boundary.
 *
 * A route lists a policy by name in config/route-access-manifest.json; the
 * boundary runs it for that route and nowhere else. Each resolver is an
 * existing, separately tested domain authorization function for decisions that
 * depend on more than the route itself: the owning company of the record in
 * the URL, values in the request body, Factory page/tab assignments.
 *
 * A resolver returns true when the request may continue. When it returns false
 * it has already sent the refusal.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { enforceAdminCompanyScope } from "../../middleware/adminCompanyScopeGuard";
import { enforceCompanyResourceScope } from "../../middleware/companyResourceScope";
import { enforceCompanyUserRoleScope } from "../../middleware/companyUserRoleScope";
import { enforceCostCenterErpPageAccess } from "../../middleware/costCenterErpPageAccess";
import { enforceDeletedItemCompanyScope } from "../../middleware/deletedItemCompanyScope";
import { enforceFactoryBackendAccess } from "../../middleware/factoryBackendAccessBoundary";
import { enforceGlobalMaintenanceScope } from "../../middleware/globalMaintenanceScope";
import { enforceGlobalTransactionCompanyScope } from "../../middleware/globalTransactionCompanyScope";
import { enforceIntercompanyConfigurationScope } from "../../middleware/intercompanyConfigurationScope";
import { permissionsV2Enforcement } from "../../middleware/permissionsV2Enforcement";
import { enforcePrivilegedMaintenanceScope } from "../../middleware/privilegedMaintenanceScope";
import { enforceSharedFactoryAccess } from "../../middleware/sharedFactoryAccessBoundary";
import { enforceUserLocationConfigurationScope } from "../../middleware/userLocationConfigurationScope";
import { pinFactoryCompany } from "./factoryCompanyPin";
import type { AccessPolicyName } from "./routeAccessManifest";

export type AccessPolicy = (req: Request, res: Response) => Promise<boolean>;

/**
 * Run an Express-style guard as a policy. Resolves true when the guard calls
 * next(), false when it ends the response instead, and rejects when it calls
 * next(error). Some guards hand off to another middleware (a rate limiter)
 * that calls next() later, so "returned without calling next" is not a
 * refusal by itself; only a finished response is.
 */
export function runGuard(guard: RequestHandler, req: Request, res: Response): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      res.off("finish", onResponseEnd);
      res.off("close", onResponseEnd);
      if (error !== undefined) reject(error);
      else resolve(outcome);
    };
    const onResponseEnd = () => finish(false);
    res.once("finish", onResponseEnd);
    res.once("close", onResponseEnd);
    const next: NextFunction = (error?: unknown) => {
      if (error !== undefined && error !== null && error !== "route" && error !== "router") finish(false, error);
      else finish(true);
    };
    try {
      Promise.resolve(guard(req, res, next)).catch((error: unknown) => finish(false, error));
    } catch (error) {
      finish(false, error);
    }
  });
}

const fromGuard =
  (guard: RequestHandler): AccessPolicy =>
  (req, res) =>
    runGuard(guard, req, res);

/**
 * Run a guard that was written for `app.use(prefix, guard)`: while it runs,
 * `req.path` is relative to the prefix and `req.baseUrl` is the prefix, exactly
 * as Express presents a mounted request. The request is restored afterwards.
 */
function fromMountedGuard(prefixes: readonly string[], guard: RequestHandler): AccessPolicy {
  return async (req, res) => {
    const path = req.path;
    const prefix = prefixes.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
    if (!prefix) return runGuard(guard, req, res);

    const originalUrl = req.url;
    const originalBaseUrl = req.baseUrl;
    req.url = originalUrl.slice(prefix.length) || "/";
    if (!req.url.startsWith("/")) req.url = `/${req.url}`;
    req.baseUrl = `${originalBaseUrl}${prefix}`;
    try {
      return await runGuard(guard, req, res);
    } finally {
      req.url = originalUrl;
      req.baseUrl = originalBaseUrl;
    }
  };
}

const FACTORY_PREFIX = ["/api/factory"] as const;
const ADMIN_COMPANY_SCOPE_PREFIXES = [
  "/api/admin",
  "/api/orphaned-records",
  "/api/location-summary",
  "/api/deleted-items",
  "/api/files",
] as const;

export const ACCESS_POLICIES: Readonly<Record<AccessPolicyName, AccessPolicy>> = {
  "permissions-v2": fromGuard(permissionsV2Enforcement),
  "privileged-maintenance": fromGuard(enforcePrivilegedMaintenanceScope),
  "shared-factory-access": fromGuard(enforceSharedFactoryAccess),
  "cost-center-page-access": fromMountedGuard(["/api/cost-centers"], enforceCostCenterErpPageAccess),
  "factory-company-pin": fromMountedGuard(FACTORY_PREFIX, pinFactoryCompany),
  "global-maintenance": async (req, res) => enforceGlobalMaintenanceScope(req, res),
  "intercompany-configuration": enforceIntercompanyConfigurationScope,
  "user-location-configuration": enforceUserLocationConfigurationScope,
  "company-user-administration": enforceCompanyUserRoleScope,
  "company-resource": enforceCompanyResourceScope,
  "deleted-item": enforceDeletedItemCompanyScope,
  "global-transaction": enforceGlobalTransactionCompanyScope,
  "factory-page-access": fromMountedGuard(FACTORY_PREFIX, enforceFactoryBackendAccess),
  "admin-company-scope": fromMountedGuard(ADMIN_COMPANY_SCOPE_PREFIXES, enforceAdminCompanyScope),
};
