/**
 * Ordered startup preloads: the one place that says what runs before
 * dist/index.js (or server/index.ts in development), and in which order.
 *
 * Every entry is awaited before the next starts. The production runtime guards
 * (server/runtimeMemoryGuard.mjs and the guards it loads) stay a separate
 * --import in the start script, after this file.
 *
 * Nothing here changes the database schema. The schema is owned by numbered
 * migrations (migrations/, applied explicitly with `npm run db:migrate`); the
 * server only verifies it and refuses to start on a mismatch.
 */

// Environment validation first, so a misconfigured deployment fails before any
// database work. Pure configuration checks; development only warns.
await import("./deploymentPreflight.mjs");

// Read-only: migration history, catalog and tenant-isolation probes must match
// this release, or startup aborts and the previous deployment keeps serving.
const { runStartupSchemaGateOnce } = await import("./schema/startupSchemaGate.mjs");
await runStartupSchemaGateOnce();

// Business-data startup operations (security permission grants, container
// tracking kill switch, env-gated wave-6 repair). DML only.
const { runStartupDataOperations } = await import("./startup/startupDataOperations.mjs");
await runStartupDataOperations();

// Runtime behaviour patches (no database access):
// bounds outbound FX-rate fetches so a slow provider cannot stall requests;
await import("./runtime/fxFetchTimeout.mjs");
// Express response behaviour for large exports, scheduled attachments and
// paginated list endpoints.
await import("./runtime/exportBuffer.mjs");
await import("./runtime/scheduledAttachment.mjs");
await import("./runtime/apiPagination.mjs");
