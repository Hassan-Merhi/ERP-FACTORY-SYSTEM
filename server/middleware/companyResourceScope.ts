import type { Request, Response } from "express";
import { db } from "../db";
import { logger } from "../lib/logger";
import { resolveActiveCompanyId } from "../routes/helpers/resolveActiveCompanyId";
import { CompanyIsolationError, authorizeCompanyScopedResourceTx } from "../services/security/companyIsolationPolicy";
import { createDatabaseCompanyIsolationAdapter } from "../services/security/databaseCompanyIsolationAdapter";
import { classifyCompanyOwnedRoute } from "../services/security/companyResourceRoutePolicy";

const AUTHENTICATED_ROLES = [
  "Developer",
  "Admin",
  "Owner",
  "Manager",
  "POS",
  "Normal User",
  "View Only",
  "ERP Tester",
] as const;

const adapter = createDatabaseCompanyIsolationAdapter();

export async function enforceCompanyResourceScope(req: Request, res: Response): Promise<boolean> {
  const match = classifyCompanyOwnedRoute(req.path);
  if (!match) return true;

  const userId = req.session.userId;
  const role = req.session.currentRole;

  // For non-factory domains (accounting, inventory, administration, …) always
  // use currentCompanyId — the ERP company.  resolveActiveCompanyId() prefers
  // factoryCompanyId when it is set, which leaks the factory company into ERP
  // resource checks after an admin has visited the factory module, causing
  // spurious CROSS_COMPANY_ACCESS_DENIED denials.  Only factory-domain routes
  // (e.g. /api/factory/containers/:id) should use the factory company.
  // This mirrors the approach already used in auth.ts → authorizeExplicitCompanyScope.
  const companyId = match.domain === "factory" ? resolveActiveCompanyId(req) : (req.session.currentCompanyId ?? null);

  if (!userId || !role || !companyId) return true;

  try {
    await authorizeCompanyScopedResourceTx(
      {
        tx: db,
        actor: { userId, role, companyId },
        domain: match.domain,
        action: `${req.method.toLowerCase()}.${match.resourceType}`,
        resourceType: match.resourceType,
        resourceId: match.resourceId,
        allowedRoles: AUTHENTICATED_ROLES,
      },
      adapter
    );
    return true;
  } catch (error) {
    if (!(error instanceof CompanyIsolationError)) throw error;

    logger.error(
      JSON.stringify({
        event: "company_resource_scope_denied",
        ts: new Date().toISOString(),
        userId,
        role,
        companyId,
        method: req.method,
        path: req.path,
        resourceType: match.resourceType,
        resourceId: match.resourceId,
        code: error.code,
      })
    );

    const notFound = error.code === "RESOURCE_NOT_FOUND" || error.code === "CROSS_COMPANY_ACCESS_DENIED";
    res.status(notFound ? 404 : 403).json({
      message: notFound ? "Record not found" : "Forbidden",
      code: error.code,
    });
    return false;
  }
}
