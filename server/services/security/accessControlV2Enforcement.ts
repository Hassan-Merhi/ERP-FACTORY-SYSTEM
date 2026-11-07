/**
 * Phase 3 business-action gate. This is deliberately NOT globally mounted.
 *
 * A route owner must verify its handler, resource lifecycle and all automatic
 * ledger/stock side effects before installing this middleware on that route.
 * Candidate mappings from the Phase 1 inventory are never enforcement grants.
 */
import type { Request, Response, NextFunction } from "express";
import {
  CREATE_ONLY_ROLE,
  evaluateAccessControl,
  type AccessControlAction,
  type AccessControlResource,
} from "@shared/accessControlV2";
import {
  getActiveCompanyPermissionContext,
  ActiveCompanyPermissionContextError,
} from "./activeCompanyPermissionContext";

export interface VerifiedBusinessAction {
  resource: AccessControlResource;
  action: AccessControlAction;
  /** Must be literal true after documented handler review, not a dynamic guess. */
  handlerVerified: true;
  /** Returns true if a supposed create attempts to modify an existing document. */
  editsExistingRecord?: (req: Request) => boolean | Promise<boolean>;
  /** Existing period/state/company/approval restrictions always take precedence. */
  hardDenied?: (req: Request) => boolean | Promise<boolean>;
}

/**
 * Apply AFTER requireAuth and existing resource-specific authorization guards.
 * Legacy roles continue through the existing authorization chain untouched.
 * Create Only needs a verified action and a canonical active-company assignment.
 * This gate cannot grant access otherwise denied by a preceding handler.
 */
export function requireVerifiedBusinessAction(spec: VerifiedBusinessAction) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const context = await getActiveCompanyPermissionContext(req);
      if (context.role !== CREATE_ONLY_ROLE) {
        next();
        return;
      }
      const [isExistingRecordEdit, hardDenied] = await Promise.all([
        spec.editsExistingRecord?.(req) ?? false,
        spec.hardDenied?.(req) ?? false,
      ]);
      const decision = evaluateAccessControl({
        role: context.role,
        companyId: context.companyId,
        isAssignedToCompany: !context.developerBypass,
        resource: spec.resource,
        action: spec.action,
        routeVerified: spec.handlerVerified === true,
        isExistingRecordEdit,
        hardDenied,
      });
      if (!decision.allowed) {
        res.status(403).json({
          code: "BUSINESS_ACTION_DENIED",
          message: "This business action is not permitted.",
        });
        return;
      }
      next();
    } catch (error) {
      if (error instanceof ActiveCompanyPermissionContextError) {
        res.status(error.status).json({ code: error.code, message: "Active company access is required." });
        return;
      }
      // Fail closed instead of passing a failed company lookup into a write handler.
      next(error);
    }
  };
}
