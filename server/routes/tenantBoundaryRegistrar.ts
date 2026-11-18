import type { Express } from "express";

import { auditRequestContextMiddleware } from "../middleware/auditRequestContext";
import { poImportDatabaseScopeContinuityBoundary } from "../middleware/poImportDatabaseScopeContinuity";
import { browserMutationFailClosedBoundary } from "../security/browserMutationBoundary";
import { createManifestAccessBoundary } from "../security/access/manifestAccessBoundary";

/**
 * Installs the access boundary (security headers are mounted app-wide in
 * server/index.ts) ahead of every API registrar and before the SPA/static
 * handlers that are mounted afterward.
 *
 * The access boundary is the single middleware that authorizes API requests:
 * it reads each route's declared rule from config/route-access-manifest.json
 * and enforces company scope, role, permission keys and named policies. No
 * other registrar mounts a scope or permission middleware of its own; a route
 * that needs different access changes its declaration.
 *
 * This lives beside the registrars rather than in server/routes.ts because that
 * entry point is a bounded file: it may name registrars but may not mount
 * middleware itself. Registration order is still the caller's — the boundary
 * only guards routes registered after this call, so it runs first.
 */
export function registerTenantIsolationBoundary(app: Express): void {
  // Phase 21 (A): the audit actor and request metadata for every API request
  // (read by the database audit triggers through the lease settings).
  app.use(auditRequestContextMiddleware);
  app.use(browserMutationFailClosedBoundary);
  app.use(createManifestAccessBoundary());
  app.use("/api/po-import/parse", poImportDatabaseScopeContinuityBoundary);
}
