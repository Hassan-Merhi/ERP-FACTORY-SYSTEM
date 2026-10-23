/**
 * Enforce the same ERP Accounts page assignment as /api/my-erp-pages.
 * Frontend route hiding is not a security boundary: all ERP Cost Center APIs
 * (including reporting, exports, historical writes and readiness) pass here.
 * Factory has its own page-access boundary and is intentionally untouched.
 */
import type { NextFunction, Request, Response } from "express";
import { getErpUserPageAccess } from "../storage/auth";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { logger } from "../lib/logger";

/** ERP page grant that owns Cost Centers (see ERP_COMPOSITE_ROUTE_FEATURES). */
export const COST_CENTER_ERP_PAGE_KEY = "accounts";

/**
 * Mirrors /api/my-erp-pages for one company: Admin/Developer have full ERP
 * access, every other role needs an explicit accounts assignment there.
 */
export async function hasCostCenterErpPageAccess(companyId: number, userId: string, role: string): Promise<boolean> {
  if (role === "Admin" || role === "Developer") return true;
  const pages = await getErpUserPageAccess(companyId, userId);
  return pages.includes(COST_CENTER_ERP_PAGE_KEY);
}

export async function enforceCostCenterErpPageAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = await getActiveCompanyPermissionContext(req);
    if (!(await hasCostCenterErpPageAccess(ctx.companyId, ctx.userId, ctx.role))) {
      res.status(403).json({ message: "ERP Accounts page access is required for Cost Centers" });
      return;
    }
    next();
  } catch (error) {
    if (error instanceof ActiveCompanyPermissionContextError) {
      res.status(error.status).json({ message: error.message, code: error.code });
      return;
    }
    logger.error("Cost Center ERP permission check failed", {
      module: "cost-centers",
      action: "page-access",
      error,
    });
    res.status(500).json({ message: "Unable to verify Cost Center page access" });
  }
}
