# Phase 2: both authorized PostgreSQL schema-only dumps received (2026-11-16)

## Authentic input evidence

The operator supplied two PostgreSQL 18 plain-text schema-only dumps using TablePlus/pg_dump. Local inspection verified completed pg_dump headers and footers and no exported rows or restored sequence values. Each dump includes a non-public legacy currency backup schema (8 tables) as well as the `public` ERP schema. Their `\\restrict` and `\\unrestrict` psql client meta-commands are not executable by Node PostgreSQL drivers and must be removed before conversion.

**Do not commit raw customer data or credentials. The input SQL dumps are schema-only and should be retained in a controlled project workspace rather than this repository until deployment/security review.**

| Measure | HMD SYSTEM | Factory copy |
|---|---:|---:|
| Input filename | `HMD_SCHEMA.sql` | `FACTORY_COPY_SCHEMA.sql` |
| Source PostgreSQL | 18.3 | 18.6 |
| pg_dump | 18.1 | 18.1 |
| Source SHA-256 | `f3058108e8a10276ab04112fdf1efd8010d420478984cdd0e421675904c84d98` | `880bacafe90a4f241d5463e714e7532a8bb52510d8a98dfed97c4bc0836c070a` |
| Public tables | 459 | 466 |
| Total table definitions (incl. backups) | 467 | 474 |
| Sequences | 414 | 415 |
| Explicit indexes (excluding PK/UNIQUE implicit indexes) | 705 | 719 |
| Explicit triggers | 151 | 162 |
| Functions | 94 | 120 |
| RLS policies | 46 | 38 |

The public table names overlap on 444 objects, with **23 HMD-only** and **30 Factory-only**. This matches the earlier read-only Render catalog comparison of 459 vs 466 tables and confirms the dumps belong to the intended environments.

## Produced reference candidates and generator

`scripts/prepare-deployed-schema-baseline.mjs` now prepares a **separate** `0001_deployed_schema_snapshot.sql` for each environment from the schema-only input. It is a read-only file transformer, checks core tables and pg_dump provenance, removes matching psql-only restrictions, writes SHA-256 evidence, and deliberately does **not** register or execute any migration.

The current working-session artifact `ERP_FACTORY_Phase2_Baseline_Candidates.zip` contains:

- `migrations/baselines/hmd/0001_deployed_schema_snapshot.sql`
- `migrations/baselines/factory_copy/0001_deployed_schema_snapshot.sql`
- `manifest.json` with input/baseline fingerprints and name comparisons
- `scripts/test-disposable-baseline.sh` with explicit opt-in, database-name check, empty-public-schema preflight, and transactional `psql` execution
- `README.md` with safety gates

**These two variant baselines are source snapshots, not fully reconciled migration history. They are NOT combined, not registered in the current controlled runner and not deployed.**

## Verification status

- **PASS:** Both schema source files have pg_dump headers and completion markers and core `CREATE TABLE` definitions; no COPY/INSERT/UPDATE/DELETE data dump statements or setval sequence-state restore.
- **PASS:** Static counts and schema difference lists for both sources; files transformed locally and zip artifact created.
- **PASS:** `bash -n` shell syntax check of disposable test harness.
- **NOT RUN:** Real PostgreSQL clean-install restore: the local container has no `psql`, PostgreSQL server, or Docker. Do NOT claim it passed.
- **NOT RUN:** Production-like upgrade/compatibility migration on a restored separate database: requires a safely isolated snapshot and reconciled adoption/ledger, which a schema-only source cannot replace.
- **NOT RUN:** Application startup no-DDL verification.
- **NOT DONE:** Complete dependency-checked historical numbered migrations only, replacement of 43 startup modules plus bridge schema writers, and removal of boot DDL.

## Critical work before production release

1. Restore *each alternative* into its own PostgreSQL 18.3/18.6-compatible disposable database. Validate extension `pg_stat_statements` permissions, triggers, non-public backup schema, and source catalog fingerprints.
2. Reconstruct/reconcile migration order, ensuring any new baseline does not conflict with legacy migration journals or `migrations/controlled`. Never run a fresh-install baseline on a populated database.
3. Review whether historical backup and archive tables belong in installation baselines (preserve existing data; do not silently drop tables from live databases).
4. Restore an approved sanitized full test copy, or use a dedicated staging environment, then verify adopting existing databases without data loss.
5. Verify server boot has no DDL before deleting old writers and switching to verify-only.

The Phase 2 baseline **preparation** is completed from both provided sources; **Phase 2 exit gates remain blocked by PostgreSQL integration tests and migration-ledger reconciliation**.
