/** Role write/access boundaries moved from auth.ts without changing behavior. */
import type { Request, Response, NextFunction } from "express";
import { isErpTesterForbiddenApiPath } from "@shared/erpTestCompanyAccess";
import { isViewOnlyWriteBlocked } from "./services/security/viewOnlyWritePolicy";
import { isCreateOnlyWriteBlocked } from "./services/security/createOnlyWritePolicy";
import { logDenied } from "./authDenialLog";

/**
 * Sandbox testers can post ordinary ERP test data, but must never reach
 * configuration, maintenance, user management, or non-ERP APIs.
 * This is a server enforcement boundary, not only a hidden Settings link.
 */
export function blockErpTesterSettings(req: Request, res: Response, next: NextFunction) {
  if (req.session?.currentRole !== "ERP Tester" || !req.path.startsWith("/api/")) return next();
  if (isErpTesterForbiddenApiPath(req.path)) {
    return res
      .status(403)
      .json({ message: "ERP Tester accounts cannot access system settings or user administration" });
  }
  return next();
}

export function blockViewOnlyWrites(req: Request, res: Response, next: NextFunction) {
  const role = req.session?.currentRole;
  if (isViewOnlyWriteBlocked(role, req.method, req.path)) {
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

/**
 * Create Only protection is additive to the existing global View Only guard.
 * The new role is not yet selectable. Unknown business writes are denied
 * before they can reach routes, including bulk actions and direct API calls.
 */
export function blockUnverifiedCreateOnlyWrites(req: Request, res: Response, next: NextFunction) {
  const role = req.session?.currentRole;
  if (isCreateOnlyWriteBlocked(role, req.method, req.path)) {
    logDenied({
      userId: req.session.userId ?? null,
      username: req.session.username ?? null,
      role,
      companyId: req.session.currentCompanyId ?? null,
      method: req.method,
      path: req.path,
      reason: "Create Only attempted an unverified business write",
    });
    return res.status(403).json({
      code: "BUSINESS_ACTION_NOT_VERIFIED",
      message: "This action is not available to Create Only users.",
    });
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
