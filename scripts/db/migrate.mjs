#!/usr/bin/env node
/**
 * The ERP database migration runner: the only tool that changes the schema.
 *
 *   node scripts/db/migrate.mjs plan              list migrations + checksums (no database access)
 *   node scripts/db/migrate.mjs status            read-only: applied / pending / problems
 *   node scripts/db/migrate.mjs apply             apply pending migrations
 *                                                 (MIGRATION_CONFIRMATION=APPLY_SCHEMA_MIGRATIONS)
 *   node scripts/db/migrate.mjs adopt             read-only adoption plan for an existing ERP database
 *   node scripts/db/migrate.mjs adopt --dry-run   execute the adoption in a transaction, verify, ALWAYS roll back
 *                                                 (finds data blockers; takes table locks while it runs, so use
 *                                                 an isolated restore or a maintenance window)
 *   node scripts/db/migrate.mjs adopt --apply     adopt it (MIGRATION_CONFIRMATION=ADOPT_EXISTING_DATABASE)
 *   node scripts/db/migrate.mjs verify            read-only: history + catalog + tenant probes
 *   node scripts/db/migrate.mjs manifest --disposable [--check]
 *                                                 build an EMPTY database from migrations and write
 *                                                 (or --check) migrations/manifest/*.tsv
 *
 * The application never runs this. Server startup only verifies (see
 * server/schema/startupSchemaGate.mjs) and refuses to start on a database that
 * is behind, ahead, modified or never migrated.
 *
 * Guarantees:
 *   - one advisory lock: concurrent runners wait, then fail; never interleave;
 *   - each migration runs in its own transaction with its history row, so a
 *     failure leaves the database exactly as it was before that migration;
 *   - checksums are verified before any write; unknown, modified or
 *     out-of-order history aborts before any write;
 *   - an existing database without history is never migrated from scratch:
 *     `apply` refuses and points to `adopt`;
 *   - connection strings are never logged.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";

import { resolveDatabaseSsl } from "../../server/lib/databaseSsl.mjs";
import {
  BASELINE_MANIFEST,
  BASELINE_MIGRATION,
  MANIFEST_DIR,
  MIGRATION_HISTORY_TABLE,
  SCHEMA_MANIFEST,
  loadMigrations,
  readHistory,
  readManifest,
  reconcileHistory,
  sha256,
} from "../../server/schema/migrationRegistry.mjs";
import { compareSnapshots, summariseComparison, takeCatalogSnapshot } from "../../server/schema/schemaCatalog.mjs";
import { verifyDatabaseSchema } from "../../server/schema/verifyDatabaseSchema.mjs";
import { adoptionDataChecks, planAdoption } from "./lib/schemaDdl.mjs";

const LOCK_KEY = 748_392_107;
const APPLY_CONFIRMATION = "APPLY_SCHEMA_MIGRATIONS";
const ADOPT_CONFIRMATION = "ADOPT_EXISTING_DATABASE";
/** Tables whose presence identifies an existing ERP database. */
const ERP_CORE_TABLES = ["companies", "users", "vouchers", "voucher_entries", "ledger_accounts"];

const log = (message, detail) =>
  console.log(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);

class UsageError extends Error {}

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // Factory-edge LAN servers configure PostgreSQL with PG* variables only.
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
  if (PGHOST && PGUSER && PGPASSWORD && PGDATABASE) {
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT || "5432"}/${PGDATABASE}`;
  }
  throw new UsageError("DATABASE_URL (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE) is required for this command");
}

async function connect() {
  const url = connectionString();
  const client = new pg.Client({
    connectionString: url,
    ssl: resolveDatabaseSsl(url),
    connectionTimeoutMillis: 15_000,
    application_name: "erp-migrate",
  });
  await client.connect();
  return client;
}

async function withLock(client, fn) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
    if (rows[0].ok) break;
    if (Date.now() > deadline) throw new Error("Another migration runner holds the migration lock; try again later");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  try {
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
  }
}

async function userRelationCount(client) {
  const { rows } = await client.query(`
    SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND n.nspname NOT LIKE 'pg_temp_%' AND c.relkind IN ('r','p','v','m','S','f')`);
  return rows[0].n;
}

async function missingCoreTables(client) {
  const { rows } = await client.query(
    "SELECT t FROM unnest($1::text[]) AS t WHERE to_regclass('public.' || t) IS NULL",
    [ERP_CORE_TABLES]
  );
  return rows.map((row) => row.t);
}

const HISTORY_DDL = `
  CREATE TABLE IF NOT EXISTS public.${MIGRATION_HISTORY_TABLE} (
    id            text PRIMARY KEY,
    checksum      char(64) NOT NULL,
    mode          text NOT NULL CHECK (mode IN ('applied', 'adopted')),
    applied_at    timestamptz NOT NULL DEFAULT now(),
    execution_ms  integer NOT NULL,
    applied_by    text NOT NULL DEFAULT current_user,
    app_version   text,
    details       jsonb
  )`;

const appVersion = () => process.env.APP_VERSION ?? process.env.RENDER_GIT_COMMIT ?? null;

async function recordHistory(client, migration, mode, executionMs, details = null) {
  await client.query(
    `INSERT INTO public.${MIGRATION_HISTORY_TABLE} (id, checksum, mode, execution_ms, app_version, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [migration.id, migration.checksum, mode, executionMs, appVersion(), details]
  );
}

async function applyOne(client, migration) {
  const started = Date.now();
  if (!migration.transactional) {
    // Reviewed non-transactional migrations (e.g. CREATE INDEX CONCURRENTLY)
    // must be idempotent: a failure part-way is re-run after the fix.
    await client.query("SET lock_timeout = '15s'");
    await client.query("SET statement_timeout = 0");
    await client.query(migration.sql);
    await recordHistory(client, migration, "applied", Date.now() - started, { transactional: false });
    return Date.now() - started;
  }
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '30min'");
    await client.query(migration.sql);
    await recordHistory(client, migration, "applied", Date.now() - started);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(`Migration ${migration.id} failed and was rolled back: ${error instanceof Error ? error.message : error}`);
  }
  return Date.now() - started;
}

// ---------------------------------------------------------------------------

function cmdPlan() {
  const migrations = loadMigrations();
  log(
    JSON.stringify(
      {
        mode: "plan",
        databaseAccess: false,
        migrations: migrations.map(({ id, checksum, transactional }) => ({ id, checksum, transactional })),
      },
      null,
      2
    )
  );
}

async function cmdStatus() {
  const migrations = loadMigrations();
  const client = await connect();
  try {
    const history = await readHistory(client);
    const relations = await userRelationCount(client);
    let state;
    let pending = migrations;
    let problem = null;
    if (!history.exists && relations === 0) state = "empty: run `npm run db:migrate`";
    else if (!history.exists) state = "existing database without migration history: run `npm run db:adopt`";
    else {
      try {
        pending = reconcileHistory(migrations, history.rows).pending;
        state = pending.length ? "behind: run `npm run db:migrate`" : "up to date";
      } catch (error) {
        state = "blocked";
        problem = error.message;
      }
    }
    log(
      JSON.stringify(
        {
          mode: "status",
          state,
          problem,
          applied: history.rows.map((row) => ({ id: row.id, mode: row.mode })),
          pending: pending.map((m) => m.id),
        },
        null,
        2
      )
    );
    if (problem) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function cmdApply() {
  if (process.env.MIGRATION_CONFIRMATION !== APPLY_CONFIRMATION) {
    throw new UsageError(`Refusing to apply: set MIGRATION_CONFIRMATION=${APPLY_CONFIRMATION} for this command`);
  }
  const migrations = loadMigrations();
  const client = await connect();
  try {
    await withLock(client, async () => {
      const history = await readHistory(client);
      if (!history.exists && (await userRelationCount(client)) > 0) {
        throw new Error(
          "This database already has tables but no migration history. It is an existing database and must be " +
            "adopted, never rebuilt: run `npm run db:adopt` (read-only plan) and follow docs/database-migrations.md."
        );
      }
      const { pending } = reconcileHistory(migrations, history.rows);
      if (!pending.length) {
        log("Migrations: up to date; nothing applied.");
        return;
      }
      await client.query(HISTORY_DDL);
      for (const migration of pending) {
        const ms = await applyOne(client, migration);
        log(`Applied ${migration.id} (${ms} ms)`);
      }
    });
  } finally {
    await client.end();
  }
}

async function cmdAdopt(apply, dryRun = false) {
  if (apply && process.env.MIGRATION_CONFIRMATION !== ADOPT_CONFIRMATION) {
    throw new UsageError(`Refusing to adopt: set MIGRATION_CONFIRMATION=${ADOPT_CONFIRMATION} for this command`);
  }
  const migrations = loadMigrations();
  const baseline = migrations.find((m) => m.id === BASELINE_MIGRATION);
  if (!baseline) throw new Error(`Registry has no ${BASELINE_MIGRATION}`);
  const expected = readManifest(BASELINE_MANIFEST);
  const client = await connect();
  try {
    const run = async () => {
      const history = await readHistory(client);
      if (history.exists && history.rows.length) {
        throw new Error("This database already has migration history; adoption is only for legacy databases. Use `status`/`apply`.");
      }
      if ((await userRelationCount(client)) === 0) {
        throw new Error("This database is empty: use `npm run db:migrate` to build it from the migrations.");
      }
      const missingCore = await missingCoreTables(client);
      if (missingCore.length) {
        throw new Error(`Not an ERP database (missing ${missingCore.join(", ")}); refusing to adopt.`);
      }
      const before = compareSnapshots(expected, await takeCatalogSnapshot(client));
      const plan = planAdoption(before);
      const report = {
        mode: apply ? "adopt" : "adopt-plan",
        differences: summariseComparison(before),
        statements: plan.statements.length,
        blockers: plan.blockers,
        notes: plan.notes,
        planSha256: sha256(plan.statements.join("\n")),
      };
      if (!apply && !dryRun) {
        // Read-only: the data-dependent statements, checked against the rows.
        const all = adoptionDataChecks(plan.statements);
        const checks = all.filter((check) => check.sql);
        const deferred = all.filter((check) => !check.sql);
        report.dataChecks = { run: checks.length, failed: [], deferred };
        if (deferred.length) {
          plan.notes.push(
            `${deferred.length} data check(s) depend on columns this plan adds; run \`npm run db:adopt -- --dry-run\` to validate them against the rows`
          );
        }
        await client.query("BEGIN READ ONLY");
        try {
          await client.query("SET LOCAL search_path = public");
          await client.query("SET LOCAL statement_timeout = '5min'");
          for (const check of checks) {
            const { rows } = await client.query(check.sql);
            if (rows[0].n > 0) {
              report.dataChecks.failed.push({ rows: rows[0].n, statement: check.statement, check: check.sql });
              plan.blockers.push(`data: ${rows[0].n} existing row(s)/group(s) block: ${check.statement}`);
            }
          }
        } finally {
          await client.query("ROLLBACK").catch(() => {});
        }
        log(JSON.stringify(report, null, 2));
        log("-- Adoption DDL (review; nothing has been executed) --");
        for (const statement of plan.statements) log(statement);
        if (plan.blockers.length) process.exitCode = 1;
        return;
      }
      if (plan.blockers.length && !dryRun) {
        throw new Error(`Adoption blocked; resolve with reviewed migrations first:\n  - ${plan.blockers.join("\n  - ")}`);
      }
      const started = Date.now();
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '15s'");
        await client.query("SET LOCAL statement_timeout = '30min'");
        await client.query("SET LOCAL search_path = public");
        for (const statement of plan.statements) await client.query(statement);
        const after = compareSnapshots(expected, await takeCatalogSnapshot(client, { inTransaction: true }));
        if (after.missing.length || after.changed.length) {
          throw new Error(
            `Adoption did not converge: ${JSON.stringify(summariseComparison(after))}; ` +
              after.missing.slice(0, 10).map((e) => `missing ${e.kind} ${e.identity}`).concat(
                after.changed.slice(0, 10).map((c) => `changed ${c.expected.kind} ${c.expected.identity}`)
              ).join("; ")
          );
        }
        if (dryRun) {
          await client.query("ROLLBACK");
          log(JSON.stringify({ ...report, mode: "adopt-dry-run", converged: true, rolledBack: true }, null, 2));
          log("Dry run: every adoption statement succeeded against this data and the result verified; all changes were rolled back.");
          if (plan.blockers.length) process.exitCode = 1;
          return;
        }
        await client.query(HISTORY_DDL);
        await recordHistory(client, baseline, "adopted", Date.now() - started, {
          planSha256: report.planSha256,
          statements: plan.statements.length,
          differencesBefore: report.differences,
          notes: plan.notes,
          legacyObjectsKept: after.extra.length,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(
          `Adoption ${dryRun ? "dry run " : ""}failed and was rolled back; nothing changed: ${error instanceof Error ? error.message : error}`
        );
      }
      log("Adopted baseline", { statements: plan.statements.length, ms: Date.now() - started, notes: plan.notes.length });
      log("Next: run `npm run db:migrate` to apply the migrations after the baseline.");
    };
    if (apply || dryRun) await withLock(client, run);
    else await run();
  } finally {
    await client.end();
  }
}

async function cmdVerify() {
  const client = await connect();
  try {
    const result = await verifyDatabaseSchema(client);
    log(JSON.stringify({ mode: "verify", ok: result.ok, summary: result.summary }, null, 2));
    for (const problem of result.problems) log(`PROBLEM: ${problem}`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function cmdManifest(args) {
  if (!args.includes("--disposable")) {
    throw new UsageError("manifest builds a schema in DATABASE_URL; pass --disposable to confirm it is an empty throwaway database");
  }
  const check = args.includes("--check");
  const migrations = loadMigrations();
  const client = await connect();
  try {
    if ((await userRelationCount(client)) !== 0) throw new Error("manifest requires an EMPTY database");
    await client.query(HISTORY_DDL);
    const outputs = [];
    for (const migration of migrations) {
      await applyOne(client, migration);
      if (migration.id === BASELINE_MIGRATION) outputs.push([BASELINE_MANIFEST, await takeCatalogSnapshot(client)]);
    }
    outputs.push([SCHEMA_MANIFEST, await takeCatalogSnapshot(client)]);
    let stale = 0;
    for (const [file, lines] of outputs) {
      const content = `${lines.join("\n")}\n`;
      if (check) {
        const current = readManifest(file).join("\n");
        if (current !== content) {
          stale += 1;
          const diff = compareSnapshots(readManifest(file), lines);
          log(`STALE ${path.relative(process.cwd(), file)}`, summariseComparison(diff));
        } else log(`OK ${path.relative(process.cwd(), file)} (${lines.length} objects)`);
      } else {
        mkdirSync(MANIFEST_DIR, { recursive: true });
        writeFileSync(file, content);
        log(`Wrote ${path.relative(process.cwd(), file)} (${lines.length} objects)`);
      }
    }
    if (stale) {
      process.exitCode = 1;
      log("Manifests are stale: run `npm run db:manifest` against an empty disposable database and commit the result.");
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "plan":
      return cmdPlan();
    case "status":
      return cmdStatus();
    case "apply":
      return cmdApply();
    case "adopt":
      if (args.includes("--apply") && args.includes("--dry-run")) throw new UsageError("Use either --dry-run or --apply");
      return cmdAdopt(args.includes("--apply"), args.includes("--dry-run"));
    case "verify":
      return cmdVerify();
    case "manifest":
      return cmdManifest(args);
    default:
      throw new UsageError("Usage: migrate.mjs plan|status|apply|adopt [--dry-run|--apply]|verify|manifest --disposable [--check]");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
