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

export async function enforceCostCenterErpPageAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const ctx = await getActiveCompanyPermissionContext(req);
    // Mirrors /api/my-erp-pages: Admin/Developer have full ERP access,
    // Owner/Manager need an explicit accounts feature assignment.
    if (ctx.role !== "Admin" && ctx.role !== "Developer") {
      const pages = await getErpUserPageAccess(ctx.companyId, ctx.userId);
      if (!pages.includes("accounts")) {
        res.status(403).json({ message: "ERP Accounts page access is required for Cost Centers" });
        return;
      }
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
