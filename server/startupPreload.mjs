/**
 * Ordered startup preloads: the one place that says what runs before
 * dist/index.js (or server/index.ts in development), and in which order.
 *
 * Every entry is awaited before the next starts. Node already runs separate
 * --import flags that way; keeping it explicit here means a bridge with
 * top-level await can never overlap the next one's DDL or repair work.
 *
 * The order is the one production has used - the list reproduces what the
 * previous chain of --import flags and side-effect imports between unrelated
 * bridges evaluated - except that the deployment preflight now runs first
 * instead of fifteenth. The production runtime guards
 * (server/runtimeMemoryGuard.mjs and the guards it loads) stay a separate
 * --import in the start script, after this file.
 */

// Environment validation first, so a misconfigured deployment fails before any
// database work. Pure configuration checks; development only warns.
await import("./deploymentPreflight.mjs");

// The central startup migration list and always-on runtime/schema repair
// services still write DDL and operational data during boot. A global
// "read-only schema cutover" must NEVER silently skip those writers or
// advertise readiness until their migration histories are fully reconciled.
// Fail before any startup schema bridge is imported, preserving the previous
// healthy deployment. Individual bridge verify-only modes can be rehearsed
// on isolated staging independently.
if (
  process.env.DATABASE_STARTUP_SCHEMA_MODE === "verify-only" ||
  process.env.LEGACY_STARTUP_MIGRATION_MODE === "verify-only"
) {
  throw new Error(
    "Full read-only database startup cutover is blocked: startup-schema, " +
      "ensureRuntimeSchema, and service boot-time writers remain unversioned. " +
      "Complete their controlled migration and recovery validation before activation."
  );
}
// Indexes and audit tables used by hot request paths.
await import("./customerOrderBaleScanAuditBridge.mjs");
await import("./wave3SalesHotpathIndexBridge.mjs");
// Bounds outbound FX-rate fetches so a slow provider cannot stall requests.
await import("./fxFetchTimeoutBridge.mjs");
// Columns the factory container routes read through full-row selects.
await import("./factoryContainerSchemaBridge.mjs");
// Catalog, row-level security, repairs and supplier scope.
await import("./schemaPreload.mjs");
// Express response behaviour for large exports, scheduled attachments and
// paginated list endpoints.
await import("./exportBufferBridge.mjs");
await import("./scheduledAttachmentBridge.mjs");
await import("./apiPaginationBridge.mjs");
// Security tables required before any authenticated request.
await import("./criticalSecuritySchemaBridge.mjs");
