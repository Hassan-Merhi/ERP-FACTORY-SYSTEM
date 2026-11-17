# Database and migrations modernization — baseline and rollout

Status: **Phase 1, inventory and non-destructive safety controls**. This is NOT a declaration of migration or production readiness.

## What the first change does

- `npm run audit:database-migrations`: read-only static inventory of journal/files and startup mutation candidates.
- `npm run audit:database-migrations:strict`: exits non-zero while any legacy gap, unregistered SQL, or startup mutation candidate exists. This is an aspirational gate; do not enable it in production CI before the backlog is reviewed.
- `npm run db:push`: refuses to run when `NODE_ENV=production` or `RENDER=true`. For a nonproduction populated database, a deliberate override requires both `DB_PUSH_ALLOW_NONEMPTY=1` and `DB_PUSH_ACK_DATA_LOSS=I_UNDERSTAND`. Use the override only on a disposable copy, never real financial data.

The inventory scans source text and flags *candidates*, not proven runtime DDL. A maintainer must inspect findings before remediation. It does not connect to PostgreSQL, run any migration, or edit financial records.

## Known architectural debt to eliminate

1. The migration journal contains three grandfathered entries without matching committed SQL files. Do not fabricate replacements or alter history. Establish a documented clean-database baseline and preserve applied-journal lineage.
2. Many runtime bridges do schema creation/repair at app boot. Extract reviewed, idempotent changes into versioned migrations, and make normal startup **read-only** with respect to schema.
3. Keep schema-changing jobs on a **single controlled migration runner**, not each web replica. Acquire a PostgreSQL advisory lock with a bounded timeout; record version, checksum, who applied it, duration, and error.
4. Prevent silent drift: check migration checksums and the required object catalog before enabling readiness. Treat missing critical indexes, constraints, tenant isolation and currency fields as deployment blockers.
5. Test fresh-install, upgrade-from-current-prod-snapshot, rerun/idempotency, partial-failure recovery, and concurrent-deployment cases on an isolated staging database.
6. Inventory runtime-only tables against the declared ORM schema. Do not switch to `drizzle-kit push` as a migration mechanism.

## Required production rollout sequence

1. Capture a consistent backup and **test a restore** into an isolated environment.
2. Record production schema, installed extensions/functions/triggers/policies, migration ledger, and outstanding drift. Redact database credentials and customer data in the report.
3. Convert one tightly scoped startup bridge at a time. Provide forward migration, safe preflight, verification SQL and a recovery playbook; avoid claiming arbitrary DDL can be rolled back.
4. Test migration under a production-like dataset with concurrent application readers and writers, monitoring locks and query latency.
5. Deploy the migration runner in a controlled stage, then deploy app code that requires the new schema. Use expand/contract for non-backward-compatible changes.
6. Switch application startup bridges into verify-only mode only **after** production migrations have been applied and confirmed. Switching them off prematurely could break startup.
7. After each step, compare journal counts, currency/account integrity, tenant isolation, rental/dispatch posting invariants, and performance indicators. Do not edit posted voucher history as a migration side effect.

## Exit criteria for high migration maturity

- No unexplained or unregistered migrations; legacy journal gaps documented with verified provenance.
- No unreviewed startup DDL or startup data deletion.
- No schema push against any production database.
- Migration run results, checksums and deployment provenance are available and auditable.
- First boot and repeated boot pass without mutation or errors.
- Successful restore drill and observed staging tests of concurrency/failure handling.
- Release gates block missing schema, unapproved drift or failed migration.
- No changes to production balances, existing vouchers, or inventory from modernization itself unless separately approved and reconciled.

The score should be reassessed after these conditions are independently verified. Do not assign 100/100 merely because code and docs exist.
