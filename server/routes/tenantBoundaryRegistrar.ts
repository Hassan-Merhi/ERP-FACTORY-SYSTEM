import type { Express } from "express";

import { auditRequestContextMiddleware } from "../middleware/auditRequestContext";
import { poImportDatabaseScopeContinuityBoundary } from "../middleware/poImportDatabaseScopeContinuity";
import { tenantCompanyParamBoundary, tenantIsolationBoundary } from "../middleware/tenantIsolationBoundary";
import { enforcePrivilegedMaintenanceScope } from "../middleware/privilegedMaintenanceScope";
import { browserMutationFailClosedBoundary } from "../security/browserMutationBoundary";

/**
 * Installs the canonical tenant and mutation boundaries (security headers are
 * mounted app-wide in server/index.ts) ahead of every API
 * registrar and before the SPA/static handlers that are mounted afterward.
 *
 * This lives beside the registrars rather than in server/routes.ts because that
 * entry point is a bounded file: it may name registrars but may not mount
 * middleware itself. Registration order is still the caller's — these
 * boundaries only guard routes registered after this call, so they run first.
 */
export function registerTenantIsolationBoundary(app: Express): void {
  // Phase 21 (A): the audit actor and request metadata for every API request
  // (read by the database audit triggers through the lease settings).
  app.use(auditRequestContextMiddleware);
  app.use(browserMutationFailClosedBoundary);
  app.use(tenantIsolationBoundary);
  app.use(enforcePrivilegedMaintenanceScope);
  app.use("/api/po-import/parse", poImportDatabaseScopeContinuityBoundary);
  app.param("companyId", tenantCompanyParamBoundary);
}
