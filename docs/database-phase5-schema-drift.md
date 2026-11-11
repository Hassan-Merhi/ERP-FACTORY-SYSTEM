# Phase 5 — Schema drift detection

## What has been implemented

- `npm run db:drift`: **read-only** inspection of the current PostgreSQL catalog for critical tables, columns, index valid/ready flags, named constraints, and required enabled triggers, plus comparison of the controlled migration ledger to the checked-in SHA-256 migration files.
- `npm run db:drift:strict`: also requires the two Phase 3 controlled schema migrations, every expected controlled column/constraint, a present controlled history table, and no pending controlled migrations.
- Pure schema/history comparator in `scripts/database-schema-drift-core.mjs` with Node regression tests.
- All database reads run in `BEGIN READ ONLY` with timeouts. Neither command performs DDL, data updates, or automatic repair.
- Both commands exit nonzero for detected blockers. Unvalidated legacy constraints are surfaced separately as **warnings** because NOT VALID constraints still enforce new rows; they must not be validated blindly.

## Important limitations

The manifest intentionally represents a **critical subset**, NOT a verified full-database canonical schema. It currently builds on `server/criticalSchemaReadiness.mjs`, specific voucher checks/triggers, and the two new controlled migrations. Existing runtime-only tables and dynamically generated structures across Factory, POS, Properties, permissions, rentals and payroll are not fully captured. Additional objects need owner-reviewed contracts or a catalog snapshot from a *trusted, verified* reference DB before this can become a full fleet-wide drift gate.

The detector confirms named object presence and some statuses, not exact column data types/defaults, index definitions, full trigger function bodies, RLS policies, or all constraints. Unexpected extra tables/columns are not automatically treated as invalid because numerous legitimate runtime objects remain outside versioned migrations. The old Drizzle and `schema_migration_history` ledgers remain separate and are NOT reconciled by this tool.

The strict command should only be enabled after Phase 3 staging migration cutover. Applying it prematurely to live Render, where controlled migrations are not yet installed, would intentionally return failure.

## Review / safe rollout

1. Run `npm run test:db:migrations` and `npm run db:drift` on an isolated restored staging database.
2. Compare the report against `npm run audit:database-integrity`, `npm run audit:database-migrations`, and production catalog snapshots gathered read-only by an appropriately authorized operator.
3. Investigate each missing object, invalid index, disabled trigger, modified migration checksum, and history anomaly. Never auto-drop, recreate, or edit historical migrations.
4. After independent approval and restored-snapshot testing of the controlled SQL, run `npm run db:drift:strict` in staging.
5. Expand the drift manifest to all critical modules and verify definitions, RLS, foreign keys, ownership, defaults and managed migrations before adding deployment-blocking CI enforcement.
6. If the report is clean, perform a test reboot and repeat. Confirm no background startup bridge modifies schema or history during verification.

## Exit criteria for complete Phase 5 certification

- Full production schema scope inventoried and mapped to versioned migration ownership.
- All migration ledgers reconciled or formally retired, with checksum/history integrity.
- Full structural comparison for indexes/constraints/functions/triggers/policies and critical column definitions.
- Drift checks pass against a restored production-like DB and two repeated startups.
- Intentional legacy differences have documented time-limited waivers and owners.
- Release pipeline has a tested fail-closed gate and safe rollback plan.

This branch **does not** meet those production certification conditions yet, and no production database access or migration application has occurred.
