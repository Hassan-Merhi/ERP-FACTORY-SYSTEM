# Migration-only schema truth — Phase 2 baseline preparation

Date: 2026-11-16  
Branch: `refactor/migrations-only-schema-truth`  
Status: **Partially implemented; authoritative baseline blocked pending trusted database schema and PostgreSQL rehearsal.**

## Existing migration topology (confirmed from repository)

- `migrations/meta/_journal.json` contains **46** historical entries, including three grandfathered missing files. Preserve all historical records.
- `migrations/` contains **75** top-level SQL files; the journal does not register all of them. Those SQL files are not executed by the controlled runner.
- `migrations/controlled/` contains **17** already numbered migrations as of this branch. They are managed by `scripts/run-controlled-migrations.mjs`.
- The controlled runner is explicit/opt-in, checksum-verified, applies one file per transaction with an advisory lock and records provenance in `erp_controlled_migration_history`.
- Its first existing migrations assume a populated legacy schema; an empty database lacks `companies`, `users`, `vouchers`, `voucher_entries`, `stock_items`, and `locations`.
- A baseline cannot simply be inserted before the current 17 migrations and automatically replayed against a live populated database. The runner enforces prefix history and the baseline could collide with existing tables. **A distinct, verified adoption path is required for installed databases.**

## Committed in this phase

1. `scripts/verify-authoritative-schema-dump.mjs`: read-only, no database connection, checks a locally supplied schema-only `pg_dump` for provenance header/footer, presence of original core tables, lack of direct data modifications and sequence-state replay, and disallowed cluster-provisioning or psql commands. Outputs SHA-256 and object counts. **A passing preflight is NOT proof of schema completeness or authenticity.**
2. `tests/authoritative-schema-dump.node.test.mjs`: deterministic synthetic-fixture contract tests for basic acceptance, missing core objects, accidental data/sequence copy, unsafe cluster statements and incomplete/handwritten dumps.

### How to prepare the authoritative source (do not upload customer data)

Only an authorized operator with access to the appropriate deployed database should generate a schema-only, sanitized capture in a secure environment:

```bash
pg_dump --schema-only --no-owner --no-privileges --format=plain --file=schema-source.sql "$DATABASE_URL"
node scripts/verify-authoritative-schema-dump.mjs --input schema-source.sql --json
node --test tests/authoritative-schema-dump.node.test.mjs
```

A pure `pg_dump` is a source artifact **not an executable Node/pg migration**: it may include psql meta-commands and database-state assumptions. Review and translate it before creating a numbered migration. Capture grants and privileges separately (the sample intentionally strips them from baseline preparation); restore requisite grants in a controlled, reviewed migration. Inspect and pin all public and non-public schemas, extensions, views, functions, RLS, triggers, indexes, defaults, FKs, enum definitions and ownership against a read-only catalog fingerprint.

## Required baseline migration design

1. Produce a reviewed, immutable, schema-only baseline SQL derived from the **deployed authoritative catalog**; record its capture date, PostgreSQL major version and SHA-256. Do not substitute a `drizzle-kit push` scratch schema for real production evidence.
2. Build a **clean-install-only** migration path for the full original core schema, followed by legacy feature migrations and all subsequent controlled migrations **in dependency order**. Avoid numeric filename sorting when it violates dependencies or existing historical migration order.
3. Build a **separate existing-installation adoption procedure**, proving the resulting schema matches exactly before recording the equivalent baseline as adopted. Never blindly replay `CREATE TABLE` over live production or fabricate historical checksums.
4. Make the migration SQL immutable, transactional where possible, and reject schema drift. Explicitly separately schedule any nontransactional index creation.
5. Keep migration execution separate from the app/runtime user, with a restricted runtime account that cannot execute DDL.
6. Compare normalized schema/catalog fingerprints against both (a) fresh database after migrations-only and (b) restored production-like snapshot after upgrade. Test idempotency, failure rollback, race behavior and financial/tenant invariants.
7. **Only after these pass**, switch startup to verify-only and delete legacy schema writers in phases 3–5.

## Blockers and safety state

- **BLOCKED:** There is no authorized production schema-only dump or equivalent complete catalog evidence supplied for this task.
- **BLOCKED:** No isolated, fresh PostgreSQL bootstrap and upgrade-from-snapshot test has been executed in this session.
- **BLOCKED:** The SQL in the 43 startup-schema modules and additional `ensure*Schema` paths is not yet wholly migrated. The 17 existing controlled files do not represent the full schema.
- **NOT ATTEMPTED:** No schema or business data was modified; no production migration/deployment was initiated; no legacy files were deleted; no server startup behavior changed.

Run `node scripts/verify-authoritative-schema-dump.mjs --input <path> --json` against the approved schema snapshot when available. The exact scope of Phase 2 cannot truthfully be marked done before both clean-install and existing-installation baselines pass real PostgreSQL verification.
