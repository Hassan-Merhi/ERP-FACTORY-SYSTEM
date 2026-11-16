/**
 * The access boundary: one middleware that authorizes every API request from
 * the rule its route declares in config/route-access-manifest.json.
 *
 * For each request it
 *   1. resolves the declared rule (no rule -> 404; nothing undeclared is served),
 *   2. binds the request to its company and opens the tenant database scope,
 *   3. checks the caller's role in that company,
 *   4. checks every required permission key,
 *   5. runs the named policy resolvers the rule lists,
 * and only then lets the route's own handler chain run.
 *
 * It replaces the per-prefix module/action/export permission mounts, the
 * operational-permission, privileged-maintenance and tenant-isolation
 * middlewares, and the scattered scope guards that each re-derived "what does
 * this URL need" from their own path tables.
 *
 * What it deliberately leaves in place:
 *   - Authentication. Signed-out requests pass through so the route's
 *     requireAuth returns the canonical 401 and session-validity checks run
 *     exactly once.
 *   - CSRF, rate limits, row-level security, transaction company assertions and
 *     business invariants. Those are independent controls, not access rules.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

import routeAccessManifestJson from "../../../config/route-access-manifest.json";
import { logger } from "../../lib/logger";
import { enforcePermissionKey } from "../../lib/permissionMiddleware";
import type { ActiveCompanyPermissionContext } from "../../services/security/activeCompanyPermissionContext";
import { ACCESS_POLICIES, type AccessPolicy } from "./accessPolicies";
import { establishCompanyScope } from "./companyScopeStage";
import {
  POLICIES_AFTER_PERMISSIONS,
  POLICIES_BEFORE_MODULE_PERMISSIONS,
  RouteAccessResolver,
  type AccessPolicyName,
  type EffectiveRouteAccess,
  type RouteAccessManifest,
} from "./routeAccessManifest";

declare global {
  namespace Express {
    interface Request {
      /** The declared access rule this request was authorized against. */
      routeAccess?: EffectiveRouteAccess;
    }
  }
}

export interface ManifestAccessBoundaryOptions {
  /** Defaults to config/route-access-manifest.json. */
  manifest?: RouteAccessManifest;
  /** Defaults to the production policy resolvers. */
  policies?: Readonly<Record<AccessPolicyName, AccessPolicy>>;
}

function isApiPath(path: string): boolean {
  // Compared without case so a differently-cased URL can never skip the
  // boundary; rules themselves match case-sensitively, like the router.
  const lower = path.toLowerCase();
  return lower === "/api" || lower.startsWith("/api/");
}

function logDenial(
  req: Request,
  access: EffectiveRouteAccess | null,
  context: ActiveCompanyPermissionContext | null,
  event: string,
  code: string
): void {
  logger.error(
    JSON.stringify({
      event,
      ts: new Date().toISOString(),
      userId: context?.userId ?? req.session?.userId ?? null,
      role: context?.role ?? req.session?.currentRole ?? null,
      companyId: context?.companyId ?? req.session?.currentCompanyId ?? null,
      method: req.method,
      path: req.path,
      rules: access?.ruleIds ?? null,
      code,
    })
  );
}

/** Company-role rule declared by the route, checked against the database role. */
function enforceCompanyRoles(
  req: Request,
  res: Response,
  access: EffectiveRouteAccess,
  context: ActiveCompanyPermissionContext
): boolean {
  for (const rule of access.companyRoles) {
    if (rule.allow && !rule.allow.includes(context.role)) {
      if (rule.reason === "global-export-center") {
        logDenial(req, access, context, "operational_permission_denied", "GLOBAL_EXPORT_DEVELOPER_REQUIRED");
        res.status(403).json({
          message: "Developer access is required for the all-company export center.",
          code: "GLOBAL_EXPORT_DEVELOPER_REQUIRED",
        });
        return false;
      }
      logDenial(req, access, context, "operational_permission_denied", "OPERATIONAL_ROLE_DENIED");
      res.status(403).json({
        message: "Your role is not allowed to perform this operational task.",
        code: "OPERATIONAL_ROLE_DENIED",
      });
      return false;
    }
    if (rule.deny?.includes(context.role)) {
      logDenial(req, access, context, "operational_permission_denied", "OPERATIONAL_ROLE_DENIED");
      res.status(403).json({
        message: "Your role is not allowed to perform this operational task.",
        code: "OPERATIONAL_ROLE_DENIED",
      });
      return false;
    }
  }
  return true;
}

async function enforcePermissions(
  req: Request,
  res: Response,
  access: EffectiveRouteAccess,
  context: ActiveCompanyPermissionContext,
  modules: boolean
): Promise<boolean> {
  for (const permission of access.permissions) {
    if ((permission.type === "module") !== modules) continue;
    if (permission.bypassRoles.includes(context.role)) continue;
    if (!(await enforcePermissionKey(req, res, permission.key, permission.type))) return false;
  }
  return true;
}

export function createManifestAccessBoundary(options: ManifestAccessBoundaryOptions = {}): RequestHandler {
  // Compiled once. An invalid manifest throws here, so a server with a broken
  // access declaration never starts serving requests.
  const resolver = new RouteAccessResolver(
    options.manifest ?? (routeAccessManifestJson as unknown as RouteAccessManifest)
  );
  const policies = options.policies ?? ACCESS_POLICIES;

  async function runPolicies(
    req: Request,
    res: Response,
    access: EffectiveRouteAccess,
    include: (name: AccessPolicyName) => boolean
  ): Promise<boolean> {
    for (const name of access.policies) {
      if (!include(name)) continue;
      const policy = policies[name];
      // Unreachable for a validated manifest; refuse rather than skip a check.
      if (!policy) throw new Error(`Access policy "${name}" has no resolver`);
      if (!(await policy(req, res))) return false;
    }
    return true;
  }

  return function manifestAccessBoundary(req: Request, res: Response, next: NextFunction): void {
    if (!isApiPath(req.path)) {
      next();
      return;
    }

    const access = resolver.resolve(req.method, req.path);
    if (!access) {
      // No declared route: refuse before any handler or later middleware can
      // answer. Same response as the application's API 404 handler.
      logger.warn(
        JSON.stringify({
          event: "route_access_undeclared",
          ts: new Date().toISOString(),
          userId: req.session?.userId ?? null,
          method: req.method,
          path: req.path,
        })
      );
      res.status(404).json({ code: "API_ROUTE_NOT_FOUND", message: "API endpoint not found" });
      return;
    }
    req.routeAccess = access;

    // Signed-out requests carry no company or role to check. The route's own
    // authentication guard answers them (401), or the route is public.
    if (!req.session?.userId) {
      next();
      return;
    }
    if (access.companyScope === "none" || access.companyScope === "context-optional") {
      next();
      return;
    }

    let finished = false;
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      // A resolver that throws must never fall through to the handler.
      next(error ?? new Error("Access boundary failed"));
    };

    void establishCompanyScope(
      req,
      res,
      access,
      async (context) => {
        try {
          if (!(await runPolicies(req, res, access, (name) => POLICIES_BEFORE_MODULE_PERMISSIONS.has(name)))) return;
          if (!(await enforcePermissions(req, res, access, context, true))) return;
          if (
            !(await runPolicies(
              req,
              res,
              access,
              (name) => !POLICIES_BEFORE_MODULE_PERMISSIONS.has(name) && !POLICIES_AFTER_PERMISSIONS.has(name)
            ))
          ) {
            return;
          }
          if (!enforceCompanyRoles(req, res, access, context)) return;
          if (!(await enforcePermissions(req, res, access, context, false))) return;
          if (!(await runPolicies(req, res, access, (name) => POLICIES_AFTER_PERMISSIONS.has(name)))) return;
          if (finished) return;
          finished = true;
          next();
        } catch (error) {
          fail(error);
        }
      },
      fail
    ).catch(fail);
  };
}
