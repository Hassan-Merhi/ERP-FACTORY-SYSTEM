# Phase 3 continued — Startup mutation inventory and safe extraction

## What is now versioned in the controlled runner

| Controlled migration | Origin | Behavior |
|---|---|---|
| 20261111_001_factory_fixed_production_plans.sql | Fixed Production Planner bridge | Additive table with constraints |
| 20261111_002_startup_warning_schema.sql | Startup warning repair | Additive columns and uniqueness index, no duplicate deletion |
| 20261111_003_security_permissions_schema.sql | Critical Security bridge | Additive permission table/columns/indexes, **no duplicate deletion and no automatic role grants** |
| 20261111_004_factory_container_columns.sql | Factory Container bridge | Adds missing columns, **no tracking-data update** |
| 20261111_005_factory_multilingual_catalog.sql | French catalog and language preferences | Adds multilingual text columns, user language table and optional recode field |
| 20261111_006_factory_bilingual_catalog.sql | Arabic catalog compatibility bridge | Additive Arabic text snapshots and normalized article index |
| 20261111_007_bale_scan_timestamp_audit.sql | Customer order bale scan audit bridge | Live/history scanned_at, timestamp trigger functions and existence-guarded triggers |

Each source bridge retains its legacy compatibility startup behavior by default. Optional `FIXED_PRODUCTION_PLANNER_SCHEMA_MODE=verify-only`, `STARTUP_WARNING_SCHEMA_MODE=verify-only`, `CRITICAL_SECURITY_SCHEMA_MODE=verify-only`, and `FACTORY_CONTAINER_SCHEMA_MODE=verify-only`, `FACTORY_MULTILINGUAL_SCHEMA_MODE=verify-only`, `FACTORY_BILINGUAL_SCHEMA_MODE=verify-only`, `BALE_SCAN_AUDIT_SCHEMA_MODE=verify-only`, `COMPANY_SCOPE_RLS_MODE=verify-only`, and `SUPPLIER_SCOPE_SCHEMA_MODE=verify-only` permit read-only catalog verification after *manual staging migration* and validation. These flags are **not configured on Render**.

## Critical startup mutations still outstanding — DO NOT enable a global cutover

| Source | Writes / risk | Blocker |
|---|---|---|
| `server/factoryBilingualSchemaBridge.mjs` | Factory catalog columns and expression indexes | Migration 006 extracted, read-only verification added; staging activation outstanding |
| `server/factoryTrilingualSchemaBridge.mjs` | Legacy French catalog/language SQL and bale recode column | Additive SQL extracted as migration 005; opt-in verification available, pending staging cutover |
| `server/companyScopeRlsBridge.mjs` | Tenant RLS policies, functions, triggers, voucher-entry company backfill | Read-only verification option added; migrate historical backfill and reconcile legacy migration separately |
| `server/supplierCompanyScopeBridge.mjs` | Legacy supplier scope migration SQL on every startup | Read-only verification option added; historical supplier reassignment must remain independently approved |
| `server/customerOrderBaleScanAuditBridge.mjs` | Scan-history table, functions/triggers/columns | Migration 007 extracted, read-only verification added; full scan-history parity outstanding |
| `server/wave3SalesHotpathIndexBridge.mjs` | Conditionally creates indexes concurrently | Non-transactional, separately authorized online migration required |
| `server/inventoryValuationWave6RepairBridge.mjs` | Conditional repair of inventory data | Explicit financial/stock approval required |
| `server/startup/runServerStartupMigrations.ts` | Large legacy DDL loop, insurance-member insertion, sequence updates | Strict mode now blocks unversioned statements and refuses healthy readiness; all statements and operational DML still require extraction |
| Other `ensureRuntimeSchema` / lazily invoked service schema creators | Dynamic DDL and historical repairs | Full import/call-graph inventory and staged integration |

## Safety conditions for full Phase 3

1. Import graph and startup migrations exhaustively inventoried; no unapproved boot-time DDL/DML.
2. Legacy Drizzle, production, 0016 and other SQL migration ledgers reconciled before controlled migration replay; do not apply new SQL over existing records without plan.
3. Each remaining legacy bridge replaced by read-only strict validation, not silently skipped.
4. Historical repair DML moved to separately approved operations, with per-company audit and prior/post totals.
5. Factory scan timestamps, rental balances, vouchers, payroll, stock and tenant RLS proven unchanged on a restored production-like staging snapshot.
6. Backups restored and release gate verified against exact commit before promotion.

## Further extraction: controlled migrations 008–009

- `20261111_008_scheduled_whatsapp_delivery.sql`: durable scheduled WhatsApp occurrence/attachment tables, unique constraints and indexes. The always-on `ensureScheduledWhatsAppDeliveryTrackingSchema` now supports `SCHEDULED_WHATSAPP_SCHEMA_MODE=verify-only` for post-migration validation without CREATE TABLE/INDEX.
- `20261111_009_insurance_monthly_amounts.sql`: additive insurance-member monthly amount table and indexes. **It does not** populate members, alter vouchers, or perform the existing insurance backfill.
- Both migrations are included in the isolated nine-migration PostgreSQL lifecycle suite. Do not apply them to production until historical startup migration history is reconciled.
- The startup mutation report now also includes the complete `server/startup-schema/*.ts` SQL module directory. This report flags historical orphan cleanup, tenant permission deduplication, the legacy migration runner and always-on runtime schema as high-risk non-schema operations requiring separate approval.

### More additive schema extracted: controlled migrations 010–012

- `20261111_010_stock_item_columns.sql`: eleven idempotent `stock_items` columns required by PO Import and full-row stock readers.
- `20261111_011_sp_invoice_charges.sql`: three Supplier Partner freight/surcharge-related invoice charge columns; no existing freight or landed-cost vouchers are adjusted.
- `20261111_012_pos_port_departure.sql`: nullable POS container port departure date.
- All three files are deliberately **schema-only** and included in the 12-migration scratch PostgreSQL lifecycle. They must not be applied to production until old history and startup dependencies have been reconciled.

### Unresolved cutover distinction

Even where these additive schemas have controlled equivalents, the default legacy boot paths **still execute**. Switching the entire server to read-only startup cannot be considered complete until all ordered modules and service-level schema initializers are transitioned, historical cleanup and sequence correction are explicitly owned, and the new runner is reconciled with existing ledgers. The global read-only cutover remains intentionally blocked. This is *not* a green light to merge/deploy or bypass startup safeguards.

## Extended remaining-surface audit

Run `npm run audit:startup-mutations` for a read-only report of startup mutation candidates, including `server/index.ts`, `server/startup/ensureRuntimeSchema.ts` and the legacy runner. `npm run audit:startup-mutations:strict` deliberately exits nonzero until remaining mutation candidates are reviewed and converted. Static candidates can include commented code, and a `verify-only` string alone does not prove there are no writes.

`server/startupPreload.mjs` now explicitly blocks a **global** read-only startup activation before importing schema bridges while unversioned runtime writers remain. This protects against a partial cutover being incorrectly marked healthy. The old default startup behavior remains unchanged until independently authorized staged cutover.

## Status

**Partially complete**. These new extraction paths are not yet authorized for production application. The branch must remain a draft and not be merged/deployed until the outstanding inventory is removed and end-to-end certification passes.
