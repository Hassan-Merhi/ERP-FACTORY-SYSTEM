/**
 * Permissions Control Center V2 — deny-only enforcement for active companies.
 *
 * Off by default. While PERMISSIONS_V2_ENFORCEMENT is not "enabled" this
 * middleware returns immediately and performs no database work, so every role
 * behaves exactly as before.
 *
 * When the switch is on, a business write whose route has a reviewed
 * business-action mapping (config/access-control-v2-route-review.json) is
 * checked against the person's effective permissions. Only a company whose V2
 * policy mode is "active" is affected, and V2 is restrict-only: it can refuse
 * a request the legacy system would allow, never allow one the legacy system
 * refuses. Every existing guard still runs after this one.
 *
 * Failure handling is fail-closed for active companies: if the policy cannot
 * be read, the write is refused with 503 instead of running unchecked.
 */
import type { NextFunction, Request, Response } from "express";
import { matchCandidateAccessControlRoute } from "@shared/accessControlV2RouteReview";
import { effectiveDecisionFor } from "@shared/effectivePermissions";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { readEffectivePermissions } from "../services/security/effectivePermissionStore";
import { isV2EnforcementEnabled } from "../services/security/permissionsV2Activation";
import { recordPermissionSignal } from "../services/security/permissionMonitor";

const PASSIVE = new Set(["GET", "HEAD", "OPTIONS"]);

export function createPermissionsV2Enforcement(env: NodeJS.ProcessEnv = process.env) {
  return async function permissionsV2Enforcement(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!isV2EnforcementEnabled(env)) return next();
    if (PASSIVE.has(req.method.toUpperCase()) || !req.path.startsWith("/api/") || !req.session?.userId) {
      return next();
    }
    const candidate = matchCandidateAccessControlRoute(req.method, req.path);
    if (!candidate) return next();

    let companyId: number | null = req.session.currentCompanyId ?? null;
    try {
      const context = await getActiveCompanyPermissionContext(req);
      companyId = context.companyId;
      if (context.role === "Admin" || context.role === "Developer") return next();
      const matrix = await readEffectivePermissions(context.companyId, context.userId, env);
      if (!matrix.enforced) return next();
      const decision = effectiveDecisionFor(matrix, candidate.resource, candidate.action);
      if (decision?.allowed) return next();
      recordPermissionSignal({
        kind: "v2_enforcement_denied",
        code: "PERMISSION_V2_DENIED",
        companyId: context.companyId,
        userId: context.userId,
        role: context.role,
        method: req.method,
        path: req.path,
        detail: { resource: candidate.resource, action: candidate.action, revision: matrix.revision },
      });
      res.status(403).json({
        code: "PERMISSION_V2_DENIED",
        message: "Your company's permission settings do not allow this action.",
      });
    } catch (error) {
      if (error instanceof ActiveCompanyPermissionContextError) {
        // The tenant boundary already decides missing-company requests.
        return next();
      }
      recordPermissionSignal({
        kind: "permission_service_error",
        code: "PERMISSION_V2_UNAVAILABLE",
        companyId,
        userId: req.session.userId ?? null,
        method: req.method,
        path: req.path,
      });
      res.status(503).json({
        code: "PERMISSION_SERVICE_UNAVAILABLE",
        message: "Permissions could not be verified. Try again shortly.",
      });
    }
  };
}

export const permissionsV2Enforcement = createPermissionsV2Enforcement();
