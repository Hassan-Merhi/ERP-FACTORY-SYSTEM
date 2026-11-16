/**
 * Migration runner and schema-authority tests.
 *
 * Registry tests need no database. PostgreSQL tests need a DISPOSABLE server:
 * MIGRATION_TEST_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres
 * Each test creates and drops its own uniquely named databases; nothing else on
 * the server is touched. Never point this at a production server.
 *
 *   node --test tests/db/migration-runner.node.test.mjs
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  MIGRATIONS_DIR,
  BASELINE_MANIFEST,
  SCHEMA_MANIFEST,
  loadMigrations,
  reconcileHistory,
  sha256,
} from "../../server/schema/migrationRegistry.mjs";
import { compareSnapshots, takeCatalogSnapshot, parseSnapshot } from "../../server/schema/schemaCatalog.mjs";
import { isLosslessTypeChange } from "../../scripts/db/lib/schemaDdl.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = path.join(ROOT, "scripts/db/migrate.mjs");
const ADMIN_URL = process.env.MIGRATION_TEST_ADMIN_URL;
const pgSkip = ADMIN_URL ? false : "MIGRATION_TEST_ADMIN_URL not set (disposable PostgreSQL required)";
// The disposable test server is local; in-process clients use the same TLS policy as the CLI runs.
process.env.PGSSLMODE ??= "disable";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dbUrl(name) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

const created = new Set();
async function createDatabase(prefix = "mig", template = null) {
  const name = `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(template ? `CREATE DATABASE ${name} TEMPLATE ${template}` : `CREATE DATABASE ${name}`);
  await admin.end();
  created.add(name);
  return name;
}

async function dropDatabases() {
  if (!ADMIN_URL || created.size === 0) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

async function withClient(name, fn) {
  const client = new pg.Client({ connectionString: dbUrl(name) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Run the real runner CLI. */
function runner(args, { db, env = {} } = {}) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PGSSLMODE: "disable", DATABASE_URL: db ? dbUrl(db) : "", MIGRATION_CONFIRMATION: "", ...env },
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

const APPLY = { MIGRATION_CONFIRMATION: "APPLY_SCHEMA_MIGRATIONS" };
const ADOPT = { MIGRATION_CONFIRMATION: "ADOPT_EXISTING_DATABASE" };

/** A fixture registry directory (copied into a temp dir). */
function fixtureRegistry(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "erp-migrations-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

after(dropDatabases);

// ---------------------------------------------------------------------------
// Registry (no database)
// ---------------------------------------------------------------------------

describe("migration registry", () => {
  const migrations = loadMigrations();

  it("has contiguous, unique, well-formed migration files starting with the baseline", () => {
    assert.ok(migrations.length >= 2);
    assert.equal(migrations[0].id, "0001_baseline_schema");
    const ids = new Set(migrations.map((m) => m.id));
    assert.equal(ids.size, migrations.length);
    migrations.forEach((m, index) => {
      assert.equal(m.number, index + 1);
      assert.match(m.file, /^\d{4}_[a-z0-9_]+\.sql$/);
      assert.ok(m.sql.trim().length > 0);
    });
  });

  it("computes stable SHA-256 checksums of the exact bytes", () => {
    for (const m of migrations) {
      assert.equal(m.checksum, sha256(readFileSync(path.join(MIGRATIONS_DIR, m.file), "utf8")));
      assert.equal(m.checksum, loadMigrations().find((x) => x.id === m.id).checksum);
    }
  });

  it("baseline is a clean schema dump: no psql meta-commands, owners, roles or data", () => {
    const sql = migrations[0].sql;
    assert.doesNotMatch(sql, /^\\/m, "psql meta-commands (\\restrict etc.) must be stripped");
    assert.doesNotMatch(sql, /\bOWNER TO\b/);
    assert.doesNotMatch(sql, /^\s*GRANT\b/m);
    assert.doesNotMatch(sql, /^COPY \S+ .* FROM stdin;$/m, "schema-only: no table data");
    assert.doesNotMatch(sql, /^SELECT pg_catalog\.setval\(/m, "schema-only: no sequence positions");
    assert.doesNotMatch(sql, /^SET (?!LOCAL)/m, "session settings must be transaction-local");
    const code = sql.split("\n").filter((line) => !line.startsWith("--")).join("\n");
    for (const debris of ["currency_fix_backup_", "backup_customer_orders_166", "_orphan_archive_", "intercompany_trades"]) {
      assert.ok(!code.includes(debris), `baseline must not contain ${debris}`);
    }
  });

  it("manifests parse and the full manifest includes the baseline's security objects", () => {
    const baseline = parseSnapshot(readFileSync(BASELINE_MANIFEST, "utf8").split("\n"));
    const full = parseSnapshot(readFileSync(SCHEMA_MANIFEST, "utf8").split("\n"));
    assert.ok(baseline.length > 9000);
    assert.ok(full.length >= baseline.length);
    const find = (kind, identity) => full.find((e) => e.kind === kind && e.identity === identity);
    // Tenant isolation, financial integrity and audit controls that must exist.
    assert.equal(find("table", "public.vouchers").def.rls, true);
    assert.equal(find("table", "public.vouchers").def.forceRls, true);
    assert.ok(find("policy", "public.voucher_entries.voucher_entries_company_scope_policy"));
    assert.ok(find("function", "public.erp_current_company_id()"));
    assert.ok(full.some((e) => e.kind === "trigger" && e.identity.startsWith("public.vouchers.") && /closed_period/.test(e.identity)));
    assert.ok(full.some((e) => e.kind === "trigger" && e.identity.startsWith("public.audit_log.")));
    const secdef = full.filter((e) => e.kind === "function" && /SECURITY DEFINER/.test(e.def.def ?? ""));
    for (const fn of secdef) assert.equal(fn.def.publicExecute, false, `${fn.identity} must not be executable by PUBLIC`);
  });

  it("rejects bad names, gaps, empty files and unmanaged transaction control", () => {
    assert.throws(() => loadMigrations(fixtureRegistry({ "0001_ok.sql": "SELECT 1;", "2_bad.sql": "SELECT 1;" })), /Invalid migration file name/);
    assert.throws(() => loadMigrations(fixtureRegistry({ "0001_a.sql": "SELECT 1;", "0003_c.sql": "SELECT 1;" })), /contiguous/);
    assert.throws(() => loadMigrations(fixtureRegistry({ "0001_a.sql": "  \n" })), /Empty migration/);
    assert.throws(() => loadMigrations(fixtureRegistry({ "0001_a.sql": "BEGIN;\nSELECT 1;\nCOMMIT;" })), /transaction control/);
    assert.throws(
      () => loadMigrations(fixtureRegistry({ "0001_a.sql": "CREATE INDEX CONCURRENTLY i ON t (a);" })),
      /CONCURRENTLY/
    );
    const ok = loadMigrations(
      fixtureRegistry({ "0001_a.sql": "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a);" })
    );
    assert.equal(ok[0].transactional, false);
  });

  it("history reconciliation fails closed on unknown, modified, duplicate or out-of-order history", () => {
    const m = [
      { id: "0001_a", checksum: "a".repeat(64) },
      { id: "0002_b", checksum: "b".repeat(64) },
      { id: "0003_c", checksum: "c".repeat(64) },
    ];
    assert.deepEqual(reconcileHistory(m, [{ id: "0001_a", checksum: "a".repeat(64) }]).pending.map((x) => x.id), ["0002_b", "0003_c"]);
    assert.throws(() => reconcileHistory(m, [{ id: "0009_z", checksum: "z".repeat(64) }]), /does not exist in this release/);
    assert.throws(() => reconcileHistory(m, [{ id: "0001_a", checksum: "f".repeat(64) }]), /Checksum mismatch/);
    assert.throws(
      () => reconcileHistory(m, [{ id: "0001_a", checksum: "a".repeat(64) }, { id: "0001_a", checksum: "a".repeat(64) }]),
      /Duplicate/
    );
    assert.throws(() => reconcileHistory(m, [{ id: "0002_b", checksum: "b".repeat(64) }]), /Out-of-order/);
  });

  it("only applies provably safe column type changes during adoption", () => {
    assert.equal(isLosslessTypeChange("numeric(20,4)", "numeric(20,6)"), true);
    assert.equal(isLosslessTypeChange("numeric(20,6)", "numeric(20,4)"), false, "scale decrease rounds");
    assert.equal(isLosslessTypeChange("character varying(50)", "text"), true);
    assert.equal(isLosslessTypeChange("text", "character varying(50)"), false, "explicit cast truncates");
    assert.equal(isLosslessTypeChange("integer", "bigint"), true);
    assert.equal(isLosslessTypeChange("bigint", "integer"), false);
    assert.equal(isLosslessTypeChange("integer", "character varying"), true);
    assert.equal(isLosslessTypeChange("timestamp without time zone", "timestamp with time zone"), false);
  });

  it("plan mode needs no database", () => {
    const result = runner(["plan"]);
    assert.equal(result.status, 0, result.out);
    const plan = JSON.parse(result.out);
    assert.equal(plan.databaseAccess, false);
    assert.equal(plan.migrations[0].id, "0001_baseline_schema");
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

describe("fresh installation from migrations alone", { skip: pgSkip }, () => {
  let db;
  before(async () => {
    db = await createDatabase("fresh");
  });

  it("refuses to apply without explicit confirmation and writes nothing", async () => {
    const result = runner(["apply"], { db });
    assert.equal(result.status, 2, result.out);
    await withClient(db, async (c) => {
      const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace");
      assert.equal(rows[0].n, 0);
    });
  });

  it("builds the complete schema, identical to the committed manifest", async () => {
    const result = runner(["apply"], { db, env: APPLY });
    assert.equal(result.status, 0, result.out);
    const expected = readFileSync(SCHEMA_MANIFEST, "utf8").split("\n").filter(Boolean);
    const actual = await withClient(db, (c) => takeCatalogSnapshot(c));
    assert.deepEqual(actual, expected, "catalog after migrations must equal migrations/manifest/schema.tsv exactly");
  });

  it("records every migration with its checksum and passes full verification", async () => {
    const history = await withClient(db, (c) => c.query("SELECT id, checksum, mode FROM schema_migrations ORDER BY id"));
    assert.deepEqual(
      history.rows.map((r) => [r.id, r.checksum, r.mode]),
      loadMigrations().map((m) => [m.id, m.checksum, "applied"])
    );
    const verify = runner(["verify"], { db });
    assert.equal(verify.status, 0, verify.out);
    assert.match(verify.out, /"ok": true/);
  });

  it("is idempotent: a second apply changes nothing", async () => {
    const before = await withClient(db, (c) => takeCatalogSnapshot(c));
    const result = runner(["apply"], { db, env: APPLY });
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /up to date/);
    assert.deepEqual(await withClient(db, (c) => takeCatalogSnapshot(c)), before);
  });

  it("fails closed when an applied migration's checksum was changed", async () => {
    await withClient(db, (c) => c.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE id = '0002_reference_data'"));
    try {
      const apply = runner(["apply"], { db, env: APPLY });
      assert.notEqual(apply.status, 0);
      assert.match(apply.out, /Checksum mismatch/);
      assert.notEqual(runner(["verify"], { db }).status, 0);
    } finally {
      const real = loadMigrations().find((m) => m.id === "0002_reference_data").checksum;
      await withClient(db, (c) => c.query("UPDATE schema_migrations SET checksum = $1 WHERE id = '0002_reference_data'", [real]));
    }
  });

  it("fails closed on unknown (newer) and out-of-order history", async () => {
    await withClient(db, (c) =>
      c.query("INSERT INTO schema_migrations (id, checksum, mode, execution_ms) VALUES ('9999_from_the_future', repeat('9', 64), 'applied', 0)")
    );
    let result = runner(["apply"], { db, env: APPLY });
    assert.notEqual(result.status, 0);
    assert.match(result.out, /does not exist in this release/);
    await withClient(db, (c) => c.query("DELETE FROM schema_migrations WHERE id = '9999_from_the_future'"));

    const saved = await withClient(db, (c) => c.query("SELECT * FROM schema_migrations WHERE id = '0002_reference_data'"));
    await withClient(db, (c) => c.query("DELETE FROM schema_migrations WHERE id = '0002_reference_data'"));
    try {
      result = runner(["apply"], { db, env: APPLY });
      assert.notEqual(result.status, 0);
      assert.match(result.out, /Out-of-order/);
    } finally {
      const row = saved.rows[0];
      await withClient(db, (c) =>
        c.query("INSERT INTO schema_migrations (id, checksum, mode, execution_ms) VALUES ($1, $2, $3, $4)", [
          row.id,
          row.checksum,
          row.mode,
          row.execution_ms,
        ])
      );
    }
    assert.equal(runner(["verify"], { db }).status, 0);
  });

  it("verification detects schema drift (missing column, weakened RLS)", async () => {
    const clone = await createDatabase("drift", db);
    await withClient(clone, (c) => c.query("ALTER TABLE vouchers NO FORCE ROW LEVEL SECURITY; ALTER TABLE companies DROP COLUMN IF EXISTS currency CASCADE"));
    const verify = runner(["verify"], { db: clone });
    assert.notEqual(verify.status, 0);
    assert.match(verify.out, /public\.vouchers/);
    assert.match(verify.out, /public\.companies\.currency|companies/);
  });
});

describe("transactional application, partial failure and concurrency", { skip: pgSkip }, () => {
  it("rolls back a failing migration completely and resumes after the fix", async () => {
    const db = await createDatabase("partial");
    const dir = fixtureRegistry({
      "0001_one.sql": "CREATE TABLE one_t (id int);",
      "0002_two.sql": "CREATE TABLE two_t (id int);\nSELECT 1 / 0;",
    });
    const env = { ...APPLY, ERP_MIGRATIONS_DIR: dir };
    const failed = runner(["apply"], { db, env });
    assert.notEqual(failed.status, 0);
    assert.match(failed.out, /0002_two failed and was rolled back/);
    await withClient(db, async (c) => {
      const tables = await c.query("SELECT to_regclass('one_t') IS NOT NULL AS one, to_regclass('two_t') IS NOT NULL AS two");
      assert.deepEqual(tables.rows[0], { one: true, two: false });
      const history = await c.query("SELECT id FROM schema_migrations ORDER BY id");
      assert.deepEqual(history.rows.map((r) => r.id), ["0001_one"]);
    });
    writeFileSync(path.join(dir, "0002_two.sql"), "CREATE TABLE two_t (id int);");
    const fixed = runner(["apply"], { db, env });
    assert.equal(fixed.status, 0, fixed.out);
    await withClient(db, async (c) => {
      const history = await c.query("SELECT id FROM schema_migrations ORDER BY id");
      assert.deepEqual(history.rows.map((r) => r.id), ["0001_one", "0002_two"]);
    });
  });

  it("serialises concurrent runners: each migration is applied exactly once", async () => {
    const db = await createDatabase("concurrent");
    const dir = fixtureRegistry({
      "0001_slow.sql": "CREATE TABLE slow_t (id int);\nSELECT pg_sleep(2);",
      "0002_after.sql": "CREATE TABLE after_t (id int);",
    });
    const env = { ...process.env, PGSSLMODE: "disable", DATABASE_URL: dbUrl(db), ...APPLY, ERP_MIGRATIONS_DIR: dir };
    const runOnce = () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [RUNNER, "apply"], { cwd: ROOT, env });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (status) => resolve({ status, out }));
      });
    const results = await Promise.all([runOnce(), runOnce(), runOnce()]);
    for (const r of results) assert.equal(r.status, 0, r.out);
    await withClient(db, async (c) => {
      const history = await c.query("SELECT id, count(*)::int AS n FROM schema_migrations GROUP BY id ORDER BY id");
      assert.deepEqual(history.rows, [
        { id: "0001_slow", n: 1 },
        { id: "0002_after", n: 1 },
      ]);
    });
  });
});

describe("existing-database adoption", { skip: pgSkip }, () => {
  /** A legacy ERP database: the baseline schema without migration history, then drifted. */
  async function legacyDatabase() {
    const db = await createDatabase("legacy");
    await withClient(db, async (c) => {
      await c.query("BEGIN");
      await c.query(loadMigrations()[0].sql);
      await c.query("COMMIT");
    });
    return db;
  }

  it("apply refuses to rebuild an existing database without history", async () => {
    const db = await legacyDatabase();
    const result = runner(["apply"], { db, env: APPLY });
    assert.notEqual(result.status, 0);
    assert.match(result.out, /must be adopted, never rebuilt/);
    await withClient(db, async (c) => {
      const { rows } = await c.query("SELECT to_regclass('schema_migrations') IS NULL AS absent");
      assert.equal(rows[0].absent, true);
    });
  });

  it("adopts a drifted legacy database: restores missing objects, keeps legacy objects and data, never replays", async () => {
    const db = await legacyDatabase();
    await withClient(db, async (c) => {
      // Legacy state: missing column, missing index, missing policy, old function body,
      // narrower numeric scale, RLS not forced; plus legacy archive table with data.
      await c.query("ALTER TABLE companies DROP COLUMN IF EXISTS currency CASCADE");
      await c.query("DROP INDEX IF EXISTS sales_items_voucher_idx");
      await c.query("DROP POLICY IF EXISTS voucher_entries_company_scope_policy ON voucher_entries");
      await c.query("ALTER TABLE vouchers NO FORCE ROW LEVEL SECURITY");
      await c.query("CREATE OR REPLACE FUNCTION erp_current_company_id() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
      await c.query("ALTER TABLE factory_settings ALTER COLUMN labor_cost_per_kg TYPE numeric(10,4)");
      await c.query("CREATE TABLE legacy_archive_2026 (id int PRIMARY KEY, note text)");
      await c.query("INSERT INTO legacy_archive_2026 VALUES (1, 'kept')");
    });
    const plan = runner(["adopt"], { db });
    assert.equal(plan.status, 0, plan.out);
    assert.match(plan.out, /"mode": "adopt-plan"/);
    await withClient(db, async (c) => {
      const { rows } = await c.query("SELECT to_regclass('schema_migrations') IS NULL AS absent");
      assert.equal(rows[0].absent, true, "plan mode must not write");
    });

    const refused = runner(["adopt", "--apply"], { db });
    assert.equal(refused.status, 2, "adoption requires explicit confirmation");

    const adopted = runner(["adopt", "--apply"], { db, env: ADOPT });
    assert.equal(adopted.status, 0, adopted.out);
    const applied = runner(["apply"], { db, env: APPLY });
    assert.equal(applied.status, 0, applied.out);
    const verify = runner(["verify"], { db });
    assert.equal(verify.status, 0, verify.out);

    await withClient(db, async (c) => {
      const history = await c.query("SELECT id, mode FROM schema_migrations ORDER BY id");
      assert.equal(history.rows[0].id, "0001_baseline_schema");
      assert.equal(history.rows[0].mode, "adopted");
      assert.ok(history.rows.slice(1).every((r) => r.mode === "applied"));
      const kept = await c.query("SELECT note FROM legacy_archive_2026 WHERE id = 1");
      assert.equal(kept.rows[0].note, "kept");
    });
  });

  it("blocks adoption (changing nothing) when a difference cannot be fixed losslessly", async () => {
    const db = await legacyDatabase();
    await withClient(db, (c) => c.query("ALTER TABLE factory_settings ALTER COLUMN labor_cost_per_kg TYPE numeric(10,8)"));
    const before = await withClient(db, (c) => takeCatalogSnapshot(c));
    const plan = runner(["adopt"], { db });
    assert.notEqual(plan.status, 0);
    assert.match(plan.out, /not provably lossless/);
    const result = runner(["adopt", "--apply"], { db, env: ADOPT });
    assert.notEqual(result.status, 0);
    assert.match(result.out, /Adoption blocked/);
    assert.deepEqual(await withClient(db, (c) => takeCatalogSnapshot(c)), before);
  });

  it("rolls back the whole adoption when existing data violates the baseline", async () => {
    const db = await legacyDatabase();
    await withClient(db, async (c) => {
      await c.query("ALTER TABLE label_design_colors DROP CONSTRAINT IF EXISTS label_design_colors_slug_key");
      await c.query("INSERT INTO label_design_colors (slug, label, color_hex, sort_order) VALUES ('dup','a','#000000',1), ('dup','b','#000000',2)");
    });
    const before = await withClient(db, (c) => takeCatalogSnapshot(c));
    const result = runner(["adopt", "--apply"], { db, env: ADOPT });
    assert.notEqual(result.status, 0);
    assert.match(result.out, /rolled back; nothing changed/);
    assert.deepEqual(await withClient(db, (c) => takeCatalogSnapshot(c)), before);
    const rows = await withClient(db, (c) => c.query("SELECT count(*)::int AS n FROM label_design_colors WHERE slug = 'dup'"));
    assert.equal(rows.rows[0].n, 2, "data is untouched");
  });

  it("adds missing foreign keys to populated tables NOT VALID: historical orphans are kept, new rows are enforced", async () => {
    const db = await legacyDatabase();
    const fk = await withClient(db, async (c) => {
      const { rows } = await c.query(`
        SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
          FROM pg_constraint WHERE contype = 'f' AND conrelid = 'public.bale_sequences'::regclass LIMIT 1`);
      const row = rows[0];
      await c.query(`ALTER TABLE ${row.tbl} DROP CONSTRAINT ${row.conname}`);
      await c.query("INSERT INTO bale_sequences (company_id) VALUES (987654)"); // orphan: no such company
      return row;
    });
    const adopted = runner(["adopt", "--apply"], { db, env: ADOPT });
    assert.equal(adopted.status, 0, adopted.out);
    await withClient(db, async (c) => {
      const { rows } = await c.query(
        "SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass",
        [fk.conname, fk.tbl]
      );
      assert.equal(rows[0].convalidated, false, "added without scanning history");
      const orphan = await c.query("SELECT count(*)::int AS n FROM bale_sequences WHERE company_id = 987654");
      assert.equal(orphan.rows[0].n, 1, "historical row untouched");
      await assert.rejects(c.query("INSERT INTO bale_sequences (company_id) VALUES (987655)"), /foreign key/);
    });
    assert.equal(runner(["apply"], { db, env: APPLY }).status, 0);
    assert.equal(runner(["verify"], { db }).status, 0);
  });

  it("plan mode runs read-only data checks and reports rows that would block adoption", async () => {
    const db = await legacyDatabase();
    await withClient(db, async (c) => {
      await c.query("ALTER TABLE label_design_colors DROP CONSTRAINT IF EXISTS label_design_colors_slug_key");
      await c.query("INSERT INTO label_design_colors (slug, label, color_hex, sort_order) VALUES ('dup','a','#000000',1), ('dup','b','#000000',2)");
    });
    const plan = runner(["adopt"], { db });
    assert.notEqual(plan.status, 0);
    assert.match(plan.out, /data: 1 existing row\(s\)\/group\(s\) block/);
    const dryRun = runner(["adopt", "--dry-run"], { db });
    assert.notEqual(dryRun.status, 0);
    assert.match(dryRun.out, /dry run failed and was rolled back; nothing changed/);
    await withClient(db, async (c) => {
      const { rows } = await c.query("SELECT to_regclass('schema_migrations') IS NULL AS absent");
      assert.equal(rows[0].absent, true);
    });
  });

  it("refuses to adopt an empty database or one that already has history", async () => {
    const empty = await createDatabase("empty");
    let result = runner(["adopt"], { db: empty });
    assert.notEqual(result.status, 0);
    assert.match(result.out, /empty/);
    const fresh = await createDatabase("hist");
    assert.equal(runner(["apply"], { db: fresh, env: APPLY }).status, 0);
    result = runner(["adopt"], { db: fresh });
    assert.notEqual(result.status, 0);
    assert.match(result.out, /already has migration history/);
  });
});

describe("startup schema gate", { skip: pgSkip }, () => {
  it("passes on a migrated database and refuses on a missing, incomplete or behind database", async () => {
    const { verifyStartupSchema, DatabaseSchemaMismatchError } = await import("../../server/schema/startupSchemaGate.mjs");
    const db = await createDatabase("gate");
    await assert.rejects(verifyStartupSchema({ connectionString: dbUrl(db) }), DatabaseSchemaMismatchError);
    assert.equal(runner(["apply"], { db, env: APPLY }).status, 0);
    const result = await verifyStartupSchema({ connectionString: dbUrl(db) });
    assert.equal(result.ok, true);

    await withClient(db, (c) => c.query("ALTER TABLE vouchers DROP COLUMN IF EXISTS currency CASCADE"));
    await assert.rejects(verifyStartupSchema({ connectionString: dbUrl(db) }), /missing column public\.vouchers\.currency/);

    await withClient(db, (c) => c.query("DELETE FROM schema_migrations WHERE id = (SELECT max(id) FROM schema_migrations)"));
    await assert.rejects(verifyStartupSchema({ connectionString: dbUrl(db) }), /Pending migrations/);
  });
});
