# Database migrations

The ERP + Factory database schema has exactly one source of truth: the numbered
SQL files in [`migrations/`](../migrations), applied by one tool,
[`scripts/db/migrate.mjs`](../scripts/db/migrate.mjs).

- The application **never** changes the schema. Server startup only *verifies*
  it (read-only) and refuses to start when the database does not match the
  release. No request handler creates or repairs a table, column, index,
  function, trigger or policy.
- Every schema change is a new, reviewed, numbered migration.
- `drizzle-kit push`, startup "ensure" functions, preload schema bridges and
  `server/startup-schema/` no longer exist. `shared/schema` (Drizzle) is a
  typed query layer only; it does not create anything.

```
migrations/
  0001_baseline_schema.sql             complete schema, fresh installs only
  0002_reference_data.sql              idempotent reference rows
  0003_retail_selling_legacy_backfill.sql
  0004_widen_columns_to_declared_types.sql
  0005_employee_opening_side_default_credit.sql
  0006_retire_retail_catalog_cost_snapshot_trigger.sql
  0007_intercompany_container_trading.sql
  0008_restore_defaults_the_code_relies_on.sql
  NNNN_short_description.sql           every later change
  manifest/0001_baseline_schema.tsv    catalog right after the baseline (adoption target)
  manifest/schema.tsv                  catalog after all migrations (startup + CI contract)
  archive/                             historical SQL from the old mechanisms (never executed)
scripts/db/migrate.mjs                 the runner (plan/status/apply/adopt/verify/manifest)
server/schema/                         read-only catalog snapshot, registry, verifier, startup gate
```

## Commands

| Command | Database access | What it does |
| --- | --- | --- |
| `npm run db:migrate:plan` | none | Lists migrations and SHA-256 checksums. |
| `npm run db:migrate:status` | read-only | Applied / pending / blocked; says when a database needs adoption. |
| `MIGRATION_CONFIRMATION=APPLY_SCHEMA_MIGRATIONS npm run db:migrate` | writes | Applies pending migrations. |
| `npm run db:adopt` | read-only | Adoption plan for an existing (legacy) database, with read-only data checks. |
| `npm run db:adopt -- --dry-run` | writes, always rolled back | Executes the whole adoption in one transaction, verifies it, rolls back. Takes table locks while it runs. |
| `MIGRATION_CONFIRMATION=ADOPT_EXISTING_DATABASE npm run db:adopt:apply` | writes | Adopts an existing database. |
| `npm run db:verify` | read-only | Migration history + full catalog comparison + tenant-isolation probes. |
| `npm run db:manifest` / `db:manifest:check` | writes to an **empty, disposable** database | Regenerates / checks `migrations/manifest/*.tsv`. |
| `npm run audit:runtime-ddl` | none | Fails if any runtime code under `server/` or `shared/` contains schema-changing SQL. |
| `npm run verify:boot-no-ddl` | disposable database | Boots the built server under a PostgreSQL event trigger and proves no DDL ran. |

`DATABASE_URL` selects the database. The runner never logs connection strings.

## Guarantees of the runner

- **Order:** files are `NNNN_snake_case.sql`, contiguous from `0001`, applied in
  numeric order. A gap, duplicate or badly named file stops the runner.
- **Immutability:** each applied migration's SHA-256 is stored in
  `public.schema_migrations`. A changed file, an unknown applied migration (a
  newer release's schema) or out-of-order history aborts **before any write**.
  Migration files are marked `-text` in `.gitattributes`, so line endings are
  never rewritten.
- **Atomicity:** each migration runs in its own transaction together with its
  history row. A failure rolls that migration back completely; earlier ones stay
  applied; rerun after fixing.
- **Concurrency:** a PostgreSQL advisory lock serialises runners. A second
  runner waits up to 60 s, then sees the work done.
- **Non-transactional DDL** (e.g. `CREATE INDEX CONCURRENTLY`) is allowed only
  in a file whose first line is `-- migrate:no-transaction`. It must be
  idempotent (`IF NOT EXISTS`), because a failure part-way cannot roll back.
- **Explicit:** applying or adopting requires `MIGRATION_CONFIRMATION`. The
  server never invokes the runner.
- **No accidental rebuild:** `apply` refuses a database that has tables but no
  history. Such a database must be adopted.

## Fresh installation

1. Create an empty PostgreSQL 18 database. The application role owns the
   objects it creates.
2. Run `MIGRATION_CONFIRMATION=APPLY_SCHEMA_MIGRATIONS DATABASE_URL=… npm run db:migrate`.
3. Run `npm run db:verify`. It must report `"ok": true`.
4. Start the application.

The result is identical, object for object, to `migrations/manifest/schema.tsv`.
CI proves this on every pull request.

The Factory-edge LAN server builds its local database the same way. The LAN
deployment additionally runs `deploy/lan/phase7-prepare-restricted-role.sql` to
grant the restricted runtime role.

## Existing installation (adoption)

A database created by the old mechanisms has no `schema_migrations` table.
Adoption checks its **real catalog**, not table names, against
`manifest/0001_baseline_schema.tsv`. It then records the baseline as `adopted`.
**The baseline SQL is never replayed against a populated database.**

What adoption does, in one transaction:

- creates objects that are missing (tables, columns, indexes, constraints,
  functions, triggers, RLS, policies, sequences, `REVOKE … FROM PUBLIC`);
- replaces function and trigger bodies that differ with the reviewed baseline
  version;
- widens column types only when the change is lossless or fails loudly
  (numeric scale increases, `varchar` to `text`, `integer` to `bigint`/text);
- adds `FOREIGN KEY` and `CHECK` constraints to populated tables **`NOT VALID`**.
  Every new or changed row is enforced immediately, and historical rows are
  never scanned, rejected or rewritten. `db:verify` reports how many constraints
  are not validated. Validating one is a separate, data-reviewed step
  (`ALTER TABLE … VALIDATE CONSTRAINT …`).

What adoption never does:

- drop or rename any table, column, constraint, index, policy or archive;
- weaken security: RLS stays on where it is on, and a stricter state
  (`NOT NULL`, PUBLIC denied `EXECUTE`, a validated constraint) is kept;
- change data (no `INSERT`/`UPDATE`/`DELETE`);
- run anything it cannot prove safe. Narrowing types, scale decreases,
  identity or collation changes and constraint-name collisions are **blockers**:
  nothing is changed until a reviewed migration resolves them.

Procedure:

1. Take and verify a backup (see [operations/database-backup-rollback-recovery.md](operations/database-backup-rollback-recovery.md)).
2. On an **isolated restore** of that backup:
   1. Run `npm run db:adopt`. Review the plan. `blockers` must be empty, and
      `dataChecks.failed` lists any rows (duplicates, `NULL`s, overflow, CHECK
      violations) that would make a statement fail.
   2. Run `npm run db:adopt -- --dry-run`. It must end with "all changes were
      rolled back" and `converged: true`.
   3. Run `npm run db:adopt:apply` with the confirmation, then `npm run db:migrate`,
      `npm run db:verify`, and start the release against the restore to smoke
      test it.
3. On production, in a maintenance window, before deploying the release that
   contains this system:
   1. Run `npm run db:adopt` (read-only). Compare its plan with the reviewed one.
      It must match, apart from any objects changed since the backup.
   2. Run `MIGRATION_CONFIRMATION=ADOPT_EXISTING_DATABASE npm run db:adopt:apply`.
   3. Run `MIGRATION_CONFIRMATION=APPLY_SCHEMA_MIGRATIONS npm run db:migrate`.
   4. Run `npm run db:verify`.
   5. Deploy.

A failed adoption rolls back completely ("nothing changed"). The previous
release keeps working, because the old code ran its own boot-time DDL.

### Known state of the two deployed databases (2026-11-16)

Both schemas were adopted on isolated PostgreSQL 18 restores of the
`pg_dump --schema-only` exports, and then verified (missing 0, changed 0):

| | HMD SYSTEM (`main`) | ERP-FACTORY-SYSTEM copy (`feature/intercompany-container-trading`) |
| --- | --- | --- |
| Adoption statements | 328 | 565 |
| Changes to existing objects | 16 lossless column changes (precision increases from startup module 010, integer user ids to varchar from 019/020, tracking default), 3 function bodies | none |
| Legacy objects kept | 13 archive/backup tables, 269 columns | 41 tables (intercompany branch), 37 functions, 45 triggers, … |
| Blockers | none | none |

Every data-dependent statement in both plans was also checked **read-only
against the live production data**: duplicates, `NULL`s, numeric overflow and
CHECK violations. All counts were 0. See
[archive/database-migrations-only-cutover-2026-11-16.md](archive/database-migrations-only-cutover-2026-11-16.md).

## Corrections found by testing against the deployed schema

Before this change, CI built its database with `drizzle-kit push`. That
produced Drizzle's *declared* schema, which production never had, so several
production defects went unnoticed. Running the test suite against the deployed
schema exposed them. The fixes ship as reviewed migrations:

| Migration | What | Why |
| --- | --- | --- |
| 0004 | Widens 44 columns in 22 tables to the declared precision, length or type (numeric scale/precision, `varchar` lengths, integer user-id columns to `varchar`). Strictly lossless; the opening-balance lock trigger is recreated in the same transaction. | Production rejected or rounded values the code writes. Daybook entry edits failed (`edited_by` was `integer`; the code writes user ids). One Golden Coast POS sale path failed (`sp_stock_movements.source_type` was `varchar(20)`). Supplier opening balances were rounded to 2 decimals. |
| 0005 | `employees.opening_balance_side` defaults to `'Cr'` for new rows. Existing rows are untouched. | The code treats employees as credit-normal and never sets the side. Production defaulted to `'Dr'`, so new employees' openings were booked on the wrong side; owner-approved repairs had to flip them. **81 of 92 production employees currently carry `'Dr'`.** Reviewing those is a separate, business-approved data task. |
| 0006 | Drops the legacy `retail_pos_sale_items_snapshot_cost` trigger and its function. | It overwrote retail sale-line costs with the catalog cost, contradicting the value-exact retail accounting. Production has 1 retail sale line. **Requires owner sign-off before release.** |

### Column defaults (resolved 2026-11-17)

Drizzle inserts omit columns that are not given, so the database's default is
the one that applies; a default declared only in Drizzle is never used. Every
column default was compared between the Drizzle declarations and the migrated
schema, ignoring cast and spelling differences. 26 disagreed:

- **24, declarations corrected.** The Drizzle files now state the deployed
  default, so nothing changes in any database. That includes
  `users.chatbot_enabled` (false: new users start with the chatbot off, and an
  administrator enables it in Chatbot Settings; owner decision),
  `factory_mix_batches.status` (`'OPEN'`), `production_bales.status`
  (`'PENDING'`), `factory_bales.pressed_at` (`now()`) and
  `support_tickets.due_at` (`now() + 24h`). The code sets the two status
  columns explicitly on every insert.
- **2, databases corrected by `0008`.** The code relies on these defaults and
  the databases never had them:
  - `factory_bales.cost_per_kg` gets `DEFAULT 0`;
  - `pressing_batches.id` gets its serial sequence. Without it, every insert
    from the legacy production-bale route failed; the table has 0 rows in
    production.

`tests/drizzle-column-defaults-match-migrations.test.ts` keeps the two in step.
A default changed on only one side fails the test. Narrowing type differences
(`text` vs `varchar(n)`, `timestamptz` vs `timestamp`) are still left as they
are.

## Intercompany container trading (0007)

Intercompany container trading reached `main` (#2870) with its schema in the
old form:
- six date-named Drizzle-journal files (`20261105_001`–`005`, `20261113_001`);
- two statements appended to startup-schema `010`;
- a boot-time catch-up (`ensureLinkedPhysicalDeleteGuard`).

`0007` folds all of it into one migration, in the original order. The six
files are kept verbatim under `migrations/archive/legacy`.
`tests/db/migration-runner.node.test.mjs` proves that `0007` contains each one
unchanged, apart from re-run guards: `IF [NOT] EXISTS`, and a
`DROP TRIGGER IF EXISTS` before each trigger. `CREATE OR REPLACE TRIGGER`
cannot replace constraint triggers, hence the explicit drop.

Those guards let the Factory copy, which already ran the feature-branch
migrations, converge on the same definitions. The boot-time catch-up is gone:
the startup gate compares the `ic_guard_trade_line_link()` body with the
manifest, so a database without the physical-delete guard refuses to start.

## Equivalent expression forms

PostgreSQL stores `col IN ('a', 'b')` on a `varchar` column as an array cast,
and restoring a `pg_dump` re-parses it into a different but equivalent tree:

```
created from source SQL (production):  ARRAY['a'::character varying, 'b'::character varying]::text[]
restored from a dump (baseline, backups): ARRAY['a'::character varying::text, 'b'::character varying::text]
```

Catalog comparison (`canonicalExpressions` in `server/schema/schemaCatalog.mjs`)
treats the two forms as equal. It applies to constraint, index, policy,
trigger, column and table definitions, but never to function bodies, and it
never changes the text that manifests or adoption DDL use.

Without it, the live HMD database would fail verification on 56 baseline CHECK
constraints. That was confirmed read-only against the live catalog on
2026-11-17. The dump-restored copies used for the adoption rehearsals hid the
problem. Any new adoption rehearsal should include a source-form database: the
runner suite redefines a CHECK from source SQL before adopting.

## Writing a new migration

1. Create `migrations/NNNN_what_it_does.sql` with the next number. Never edit or
   renumber an applied file; fix mistakes with a new migration.
2. Write plain PostgreSQL. Do not use `BEGIN`/`COMMIT`; the runner owns the
   transaction. Prefer:
   - additive changes, such as new tables or nullable columns with defaults;
   - `NOT VALID` constraints plus a separate `VALIDATE`;
   - `CREATE INDEX CONCURRENTLY IF NOT EXISTS` in its own
     `-- migrate:no-transaction` file for large tables.
3. Data changes are allowed only when they are part of the schema change
   (backfilling a new column). They must be idempotent and scoped. **Never**
   rewrite posted vouchers, voucher entries, opening balances, historical costs,
   stock movements, payroll payments, intercompany evidence or audit logs in a
   migration without separate business approval.
4. If the change alters the catalog, update `shared/schema` (types only) and
   regenerate the manifests against an empty disposable database:
   `DATABASE_URL=postgresql://…/scratch npm run db:manifest`. Commit both `.tsv` files.
5. Test locally against an empty database (`db:migrate`, `db:verify`) and
   against a restore of production (`db:migrate`, then smoke tests).
6. CI ("Database Migrations" workflow) re-runs all of this.

## Deployment

1. Back up (see the operational checklist below).
2. With the new release's code, run `npm run db:migrate:status` against
   production (read-only) and review the pending list.
3. Run `MIGRATION_CONFIRMATION=APPLY_SCHEMA_MIGRATIONS npm run db:migrate`. Use
   the Render shell or a one-off job with the release's commit; this is
   deliberately not part of `npm start` or the build command.
4. Run `npm run db:verify`.
5. Deploy the release. At startup the schema gate re-verifies; if anything is
   missing it exits, and Render keeps the previous instance serving.

Migrations must be backward compatible with the previous release, because the
old instance keeps running until the new one is healthy. Use expand → migrate →
contract across releases for renames and removals.

## Startup verification and failure modes

`server/startupPreload.mjs` runs `server/schema/startupSchemaGate.mjs` before
anything else touches the database:

- **no `schema_migrations`**: refuse ("never migrated or adopted");
- **pending migrations**: refuse ("run db:migrate first");
- **unknown or modified history**: refuse (newer release's schema, or edited
  file);
- **missing or changed objects** compared with `manifest/schema.tsv`: refuse,
  listing them. Extra legacy objects are allowed and counted;
- **tenant isolation**: company-scope RLS must fail closed without a tenant
  identity, and voucher entries must carry their voucher's company.

`SCHEMA_STARTUP_VERIFY=history` limits the gate to migration history, as an
emergency escape hatch if the catalog comparison misfires on an environment.
It never enables DDL.

## Failure recovery

| Situation | What to do |
| --- | --- |
| A migration failed during `db:migrate` | It was rolled back; earlier migrations stay applied. Fix the cause (data or SQL), add a corrective **new** migration if the file was already applied elsewhere, and rerun. |
| "Checksum mismatch" | An applied file was edited. Restore the original bytes from git. Put the change in a new migration. |
| "does not exist in this release" | The database was migrated by a newer release. Deploy that release (or newer); never roll back code across a migration. |
| "Out-of-order migration history" | History was edited manually. Restore it from backup or reconstruct it under review; never insert rows to "make it pass". |
| Startup refuses: missing/changed objects | Schema drift (manual DDL, partial restore). Run `db:verify` to list differences, then fix them with a reviewed migration or by restoring. |
| Adoption blocked | Read the blockers. Each needs a reviewed decision, usually a data fix approved by the data owner, then rerun `db:adopt`. |

## Rollback

There are no automatic down-migrations: undoing a destructive change cannot
restore data. To undo:

- **Code only:** redeploy the previous release. This works when the migration was
  backward compatible, which is the rule above.
- **Schema change:** write a forward migration that reverses it safely, for
  example dropping a new unused column or restoring a function body.
- **Data loss or corruption:** restore from backup (see the recovery runbook).
  Always take and verify a backup before applying migrations to production.

## Operational checklist (production)

- [ ] Fresh backup taken and verified (size, checksum, restore rehearsal for major changes).
- [ ] PostgreSQL version is 18.x on source and rehearsal targets.
- [ ] `npm run db:migrate:status` reviewed (pending list and no blocked state).
- [ ] For adoption: plan reviewed on a restore; `--dry-run` converged; read-only data checks are all 0.
- [ ] No long-running transactions holding locks on the tables being changed (`pg_stat_activity`). The runner uses `lock_timeout = 15s`.
- [ ] Migrations applied with the explicit confirmation; `npm run db:verify` is `"ok": true`.
- [ ] Release deployed; `/api/health/ready` and `/api/health/db` are healthy; startup log shows "Database schema verified".
- [ ] Post-deploy: watch error rates, slow queries and lock waits for the changed tables.

## How the baseline was built

The 0001 baseline is the canonical union of:

1. the **deployed HMD SYSTEM production schema** (main branch);
2. every object the repository defines: Drizzle `shared/schema`, all 43 former
   `server/startup-schema` modules, the 11 schema bridges, every boot-time and
   request-time `ensure*` function (including Factory-edge LAN mode), and the
   archived SQL migrations;
3. objects common to both deployed databases.

Minus:

- backup and archive debris (`currency_fix_backup_20260722_all_erp_usd`,
  `backup_*`, `_orphan_archive_*`);
- objects that exist only in the Factory copy's feature branch
  (`intercompany_*`, `ic_*`).

Where definitions disagreed, the deployed one wins over the repository's. A
Drizzle declaration that never matched production is not imposed.

Proofs, all on PostgreSQL 18:

- an empty database built from the migrations is identical to the canonical
  catalog;
- running every old mechanism (full production boot plus every `ensure*`, in
  cloud and in LAN mode) against the baseline changes nothing;
- both deployed schemas adopt cleanly.

Details and counts: [archive/database-migrations-only-cutover-2026-11-16.md](archive/database-migrations-only-cutover-2026-11-16.md).

## Data operations that still run at startup

These are business-data behaviours, not schema. They were preserved unchanged
when their DDL was removed:

- `server/startup/startupDataOperations.mjs`:
  - Admin and Developer roles always hold the six critical security permissions;
  - automated container tracking stays disabled;
  - the env-gated Wave 6 inventory valuation repair (off unless configured).
- `server/startup/repairCompletedOrderBaleStatuses.ts`: completed-order bales
  wrongly left `IN_STOCK` become `SOLD`, with an audit row.
- `ensureRequiredSystemAccountsForAllCompanies`, the opt-in
  `runApproved*`/`applyApproved*` owner-approved corrections (each guarded by
  exact Render service id, run key and audit), and read-only inspections.

The destructive historical repairs that lived inside the old startup-schema
list (orphan archiving/deletion, duplicate removal, legacy backfills) are
**not** carried forward. They had already run where they were going to run (the
Factory copy, 2026-10-29), and they have not run on HMD production since
2026-07-06. They are preserved only as history in `migrations/archive/` and git.
