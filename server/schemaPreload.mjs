/**
 * Database schema and repair bridges, in the order they must run.
 *
 * Each import is awaited before the next starts: several bridges run DDL and
 * repairs with top-level await, and parallel evaluation would let them race
 * each other's advisory locks. Loaded by server/startupPreload.mjs and by the
 * backend test setup (vitest setupFiles, scripts/run-backend-verification.mjs).
 */

// Factory catalog columns (English, then French/Arabic snapshots).
await import("./factoryBilingualSchemaBridge.mjs");
await import("./factoryTrilingualSchemaBridge.mjs");
// Row-level-security functions and policies. Must precede every bridge that
// opens a tenant- or maintenance-scoped transaction; it then runs the worker
// bonus, factory charge voucher and wave-6 inventory repairs itself, in order.
await import("./companyScopeRlsBridge.mjs");
// Company-scoped supplier tables (needs the RLS helpers above).
await import("./supplierCompanyScopeBridge.mjs");
