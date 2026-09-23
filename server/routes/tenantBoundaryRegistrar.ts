import type { Express } from "express";

import { poImportDatabaseScopeContinuityBoundary } from "../middleware/poImportDatabaseScopeContinuity";
import { tenantCompanyParamBoundary, tenantIsolationBoundary } from "../middleware/tenantIsolationBoundary";
import { enforcePrivilegedMaintenanceScope } from "../middleware/privilegedMaintenanceScope";
import { browserMutationFailClosedBoundary } from "../security/browserMutationBoundary";
import { securityHeadersMiddleware } from "../security/securityHeaders";

/**
 * Installs the canonical security and tenant boundaries ahead of every API
 * registrar and before the SPA/static handlers that are mounted afterward.
 *
 * This lives beside the registrars rather than in server/routes.ts because that
 * entry point is a bounded file: it may name registrars but may not mount
 * middleware itself. Registration order is still the caller's — these
 * boundaries only guard routes registered after this call, so they run first.
 */
export function registerTenantIsolationBoundary(app: Express): void {
  app.use(securityHeadersMiddleware());
  app.use(browserMutationFailClosedBoundary);
  app.use(tenantIsolationBoundary);
  app.use(enforcePrivilegedMaintenanceScope);
  app.use("/api/po-import/parse", poImportDatabaseScopeContinuityBoundary);
  app.param("companyId", tenantCompanyParamBoundary);
}
