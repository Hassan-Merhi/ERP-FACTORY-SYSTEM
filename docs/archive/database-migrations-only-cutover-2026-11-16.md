# Migrations-only schema cutover — engineering record (2026-11-16)

Record of how the migration-only architecture in
[../database-migrations.md](../database-migrations.md) was built and verified.
Branch `refactor/migrations-only-schema-truth`, PR #3243.

## Inputs

| Input | Detail |
| --- | --- |
| HMD SYSTEM schema | Render `dpg-d75mfh0ule4c73ctksfg-a` (service "HMD SYSTEM", branch `main`, manual deploys). TablePlus `pg_dump` 18.1 schema-only export, source 18.3, 2026-11-16 10:58. SHA-256 `1a6caaecad4286efa94cb023506e45cfab5bcced8b42673f6923060cfce5e7cf`. 459 public tables. |
| ERP-FACTORY-SYSTEM copy schema | Render `dpg-dbhg2l08v5cc738d6iv0-a` (service "ERP-FACTORY-SYSTEM", branch `feature/intercompany-container-trading`, copy created 2026-10-29). Export source 18.6, 2026-11-16 11:06. SHA-256 `dbca906e27782fc80a0f9d9beba7a5ef8125e1065867d8037a611668901c7d75`. 466 public tables. |
| Repository reference | Empty PG 18.7 database, then `drizzle-kit push`, a full production boot of the pre-cutover code (all 43 startup-schema modules, 15 preload bridges, boot `ensure*`), every request-time `ensure*` (48 functions), every Factory-edge `ensure*` in LAN mode (14), and the archived SQL migrations (2 of 94 files failed and were never deployable). |

Both exports are earlier than the SHA-256 values recorded by the earlier Phase 2
documents, which referred to an earlier export of the same databases. They
restore cleanly into PostgreSQL 18.7 with `ON_ERROR_STOP`.

Read-only facts established from production metadata:

- HMD `migrations_log` last advanced on **2026-07-06**. The startup-schema list,
  and the destructive orphan/backfill repairs inside it, have not run on HMD
  production since then (`RUN_STARTUP_MIGRATIONS=false`). Preload bridges and
  boot `ensure*` functions did run.
- The Factory copy ran the whole startup list on 2026-10-29, including the
  orphan archiving.
- Neither database had `schema_migrations`, `erp_controlled_migration_history`
  or Drizzle history tables. The new history table starts empty everywhere.
- Neither database had `SECURITY DEFINER` functions in `public`. Table ACLs are
  the owner role plus Render's read-only backup role (environment configuration,
  not schema).

## Canonical schema decision

The catalog of each source was snapshotted (`server/schema/schemaCatalog.mjs`,
one JSON line per object). Constraints and indexes were compared by table and
definition, not by name. Per object:

| Rule | Objects |
| --- | --- |
| Repository and both databases agree | 7,988 |
| Repository agrees with HMD | 406 |
| Repository agrees with the Factory copy (post-July startup changes HMD lacks) | 63 |
| Both databases agree, repository (Drizzle) differs: deployed definition wins | 388 |
| In both databases, not defined by the repository (e.g. `session`, legacy columns) | 298 |
| HMD only: production hardening applied by hand (dispatch financial guards, `NOT VALID` FKs, tickets) | 153 |
| HMD over repository | 31 |
| Repository only (features not yet deployed, Factory-edge LAN objects) | 658 |
| Factory over HMD (`factory_raw_stock.cost_per_kg` precision) | 1 |
| **Excluded:** backup/archive debris | 409 |
| **Excluded:** Factory copy feature-branch-only (`intercompany_*`, `ic_*`) | 650 |

A further 82 entries were deduplicated: the same name rendered differently by
different sources (production rendering kept). A constraint that is `NOT VALID`
in any source is expected `NOT VALID`.

## Proofs (PostgreSQL 18.7, isolated containers)

1. **Fresh install:** an empty database built by `migrate.mjs apply` has a
   catalog byte-identical to the canonical set (9,927 objects).
2. **Completeness:** on a copy of the canonical database, running the full
   pre-cutover production boot plus every request-time `ensure*` changed
   nothing. The only effect was the destructive orphan-repair archive tables,
   which are intentionally excluded. Running every Factory-edge `ensure*` in LAN
   mode also changed nothing.
3. **Adoption (schema-only restores):**

   | | HMD | Factory copy |
   | --- | --- | --- |
   | Statements | 328 | 565 |
   | Blockers | 0 | 0 |
   | Verify afterwards | ok (missing 0, changed 0, 284 legacy objects kept) | ok (missing 0, changed 0, 1,058 legacy objects kept) |

4. **Real-data checks (read-only SELECTs on live production):** for every
   data-dependent statement in both plans, the following counts were all 0:
   - 3 `NOT NULL` columns added without a default (`mix_batch_sources` has
     0 rows);
   - 11 numeric precision changes (no value would overflow);
   - 4 unique indexes on HMD and 4 on the Factory copy (no duplicate groups);
   - 2 `CHECK` constraints (no violating rows).

   Adoption adds FK/CHECK constraints to populated tables `NOT VALID`, so no
   historical row is scanned.

5. **Startup:** the built server, booted through the production preload under
   a PostgreSQL event trigger, executed no DDL. It refuses to start on a
   database missing a column, missing history or with pending migrations
   (`tests/db/migration-runner.node.test.mjs`,
   `scripts/db/verify-boot-no-ddl.mjs`).

## What was removed

- `server/startup-schema/` (43 modules and the index): their DDL is in the
  baseline. Their data repairs (orphan archive/delete, duplicate removal,
  legacy backfills, permission key renames) are not carried forward; see
  "Data operations" in the reference guide. The one repeating retail backfill
  still running on every boot became migration 0003.
- 11 schema bridges, `schemaPreload.mjs`, `startupWarningRepair.mjs` and
  `startupMigrationCoordinator.ts`. The 4 runtime bridges moved to
  `server/runtime/` unchanged. The test-only superagent XLSX parser moved to
  `tests/supertestXlsxParser.mjs`.
- Every boot-time and request-time schema `ensure*` across `server/startup`,
  `server/services`, `server/routes`, `server/edge` and `server/lib`.
  Business-data parts were kept as DML-only functions.
- Competing runners (controlled-v2, versioned, production), the startup
  migration ratchet, and drift/fingerprint tooling tied to the controlled
  history.
- The archived SQL files and the three Drizzle journal entries without SQL
  (`0000_conscious_william_stryker`, `0001_parallel_guardian`,
  `0002_married_loa`) are history only. Nothing was invented for them.
