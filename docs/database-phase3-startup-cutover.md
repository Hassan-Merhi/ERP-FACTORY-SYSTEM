# Phase 3 — Startup DDL extraction and verification-only cutover

## Implementation status

**Two bridges converted**, not a completed full-repository migration. Default behavior is unchanged and Render is not switched over. The remaining bridges are explicitly blocked from automatic cutover until isolated staging validation proves equivalence.

### Controlled forward migrations

- `migrations/controlled/20261111_001_factory_fixed_production_plans.sql`: creates the isolated planner configuration table with its columns and checks.
- `migrations/controlled/20261111_002_startup_warning_schema.sql`: creates legacy supplier-related columns and exchange-rate uniqueness index **without deduplicating or deleting financial records**.

Both are opt-in and executed only by `scripts/run-controlled-migrations.mjs --apply` with confirmation.

### Opt-in startup verification (do not enable before migration)

- `FIXED_PRODUCTION_PLANNER_SCHEMA_MODE=verify-only`: uses `BEGIN READ ONLY`; checks the expected table, all six columns and expected constraints; fails closed if missing; no planner DDL.
- `STARTUP_WARNING_SCHEMA_MODE=verify-only`: uses `BEGIN READ ONLY`; verifies expected columns and a valid/ready exchange-rate uniqueness index; fails closed if missing; no supplier DDL, exchange-rate deduplication or data change.

Neither setting is in `render.yaml` and neither is enabled by default.

### Required staging procedure

1. Capture the exact current staging schema and a verified restore of a production snapshot. Never place customer records in public CI logs.
2. Run `npm run db:migrations:plan` and `npm run db:migrations:status`. Check existing Drizzle history and `schema_migration_history` separately: the new runner does not supersede them.
3. Check for duplicate `exchange_rates(company_id,effective_date,from_currency,to_currency)` values and invalid/mismatched indexes before applying. Do **not** auto-delete duplicate rates; require a separate reviewed remediation if present.
4. Run the explicit controlled migration apply command against **staging only**, with verified backup and authorization.
5. Run both verify-only modes in staging, check complete cold-start, readiness, user permissions, factory planner read/write, supplier screens, and exchange-rate import and lookup.
6. Prove repeated startup makes no schema changes for those two bridges. Compare PostgreSQL schema before/after and check application logs.
7. Only then approve environment cutover, with a documented reversal to legacy compatibility mode if a previously overlooked required object is missing.
8. For production, obtain a fresh production backup, apply migration in controlled release window, verify reports and approvals, then enable flags in a **separate** deployment.

### Outstanding high-risk runtime DDL (must NOT be globally switched off)

- `server/customerOrderBaleScanAuditBridge.mjs`: barcode scan history tables / triggers / indexes.
- `server/factoryContainerSchemaBridge.mjs`: extensive container columns and **updates existing carrier tracking state**.
- `server/factoryBilingualSchemaBridge.mjs` and `server/factoryTrilingualSchemaBridge.mjs`: multilingual factory columns and supporting indexes.
- `server/companyScopeRlsBridge.mjs`: RLS policies, triggers, tenant security, data backfills; especially sensitive.
- `server/supplierCompanyScopeBridge.mjs`: schema SQL executed at boot.
- `server/criticalSecuritySchemaBridge.mjs`: permissions table/indexes, duplicate deletion and default grants.
- `server/startup/runServerStartupMigrations.ts`: legacy SQL runner plus rental allocation and historical data repairs.
- Additional `ensure*` service functions imported during app startup; must be inventoried and assigned owners.
- `server/wave3SalesHotpathIndexBridge.mjs`: already env-gated; `CREATE INDEX CONCURRENTLY` requires a specially designed nontransactional migration step and must not be placed in the transaction-per-file runner.

## Hard requirements before calling Phase 3 complete

- Inventory **all** startup paths including dynamically imported `ensure*` services.
- Produce versioned migrations and full schema checks for every currently active bridge.
- For data-mutating historical repairs, isolate from schema migration and require independent owner review.
- Make normal server startup read-only for schema and historical repair writes, with no silent failure.
- Reconcile legacy migration ledgers so no already-applied migration is replayed.
- Execute cold-start/repeated-start test and restored production-sized staging validation.
- Maintain security: RLS, tenant isolation, accounting entries, posted vouchers, rental payable/prepaid figures, factory stock, and barcode audit evidence.
- Run release and rollback drills; keep app up with zero unauthorized data changes.

No SQL has been executed in production by this branch. The unconverted bridges continue to run their existing behavior for backward compatibility.
