# Phase 3 continued — Startup mutation inventory and safe extraction

## What is now versioned in the controlled runner

| Controlled migration | Origin | Behavior |
|---|---|---|
| 20261111_001_factory_fixed_production_plans.sql | Fixed Production Planner bridge | Additive table with constraints |
| 20261111_002_startup_warning_schema.sql | Startup warning repair | Additive columns and uniqueness index, no duplicate deletion |
| 20261111_003_security_permissions_schema.sql | Critical Security bridge | Additive permission table/columns/indexes, **no duplicate deletion and no automatic role grants** |
| 20261111_004_factory_container_columns.sql | Factory Container bridge | Adds missing columns, **no tracking-data update** |
| 20261111_005_factory_multilingual_catalog.sql | French catalog and language preferences | Adds multilingual text columns, user language table and optional recode field |

Each source bridge retains its legacy compatibility startup behavior by default. Optional `FIXED_PRODUCTION_PLANNER_SCHEMA_MODE=verify-only`, `STARTUP_WARNING_SCHEMA_MODE=verify-only`, `CRITICAL_SECURITY_SCHEMA_MODE=verify-only`, and `FACTORY_CONTAINER_SCHEMA_MODE=verify-only`, `FACTORY_MULTILINGUAL_SCHEMA_MODE=verify-only`, `COMPANY_SCOPE_RLS_MODE=verify-only`, and `SUPPLIER_SCOPE_SCHEMA_MODE=verify-only` permit read-only catalog verification after *manual staging migration* and validation. These flags are **not configured on Render**.

## Critical startup mutations still outstanding — DO NOT enable a global cutover

| Source | Writes / risk | Blocker |
|---|---|---|
| `server/factoryBilingualSchemaBridge.mjs` | Factory catalog columns and expression indexes | Map and version all column/index changes; verify active optional tables |
| `server/factoryTrilingualSchemaBridge.mjs` | Legacy French catalog/language SQL and bale recode column | Additive SQL extracted as migration 005; opt-in verification available, pending staging cutover |
| `server/companyScopeRlsBridge.mjs` | Tenant RLS policies, functions, triggers, voucher-entry company backfill | Read-only verification option added; migrate historical backfill and reconcile legacy migration separately |
| `server/supplierCompanyScopeBridge.mjs` | Legacy supplier scope migration SQL on every startup | Read-only verification option added; historical supplier reassignment must remain independently approved |
| `server/customerOrderBaleScanAuditBridge.mjs` | Scan-history table, functions/triggers/columns | Ensure scan evidence remains complete and timestamps unchanged |
| `server/wave3SalesHotpathIndexBridge.mjs` | Conditionally creates indexes concurrently | Non-transactional, separately authorized online migration required |
| `server/inventoryValuationWave6RepairBridge.mjs` | Conditional repair of inventory data | Explicit financial/stock approval required |
| `server/startup/runServerStartupMigrations.ts` | Large legacy DDL loop, insurance-member insertion, sequence updates | Separate all remaining DDL and operational DML into controlled and reviewed migrations |
| Other `ensureRuntimeSchema` / lazily invoked service schema creators | Dynamic DDL and historical repairs | Full import/call-graph inventory and staged integration |

## Safety conditions for full Phase 3

1. Import graph and startup migrations exhaustively inventoried; no unapproved boot-time DDL/DML.
2. Legacy Drizzle, production, 0016 and other SQL migration ledgers reconciled before controlled migration replay; do not apply new SQL over existing records without plan.
3. Each remaining legacy bridge replaced by read-only strict validation, not silently skipped.
4. Historical repair DML moved to separately approved operations, with per-company audit and prior/post totals.
5. Factory scan timestamps, rental balances, vouchers, payroll, stock and tenant RLS proven unchanged on a restored production-like staging snapshot.
6. Backups restored and release gate verified against exact commit before promotion.

## Status

**Partially complete**. These new extraction paths are not yet authorized for production application. The branch must remain a draft and not be merged/deployed until the outstanding inventory is removed and end-to-end certification passes.
