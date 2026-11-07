#!/usr/bin/env node
/**
 * Staging run of the Permissions Control Center shadow migration.
 *
 * Run it from the STAGING service's shell (Render → ERP-FACTORY-SYSTEM → Shell),
 * where DATABASE_URL points at the staging copy:
 *
 *   STAGING_DATABASE_NAME=<staging database name> node scripts/permissions/staging-shadow-migration.mjs
 *
 * Steps, all reported to stdout and saved to permissions-staging-report-<time>.json:
 *   1. Safety: refuses unless current_database() equals STAGING_DATABASE_NAME, and
 *      always refuses the production database names listed below.
 *   2. Preflight: prerequisites (company-scope functions, base tables), current role.
 *   3. Business snapshot BEFORE: row count + md5 per business table.
 *   4. Rollback drill: applies the migration inside a transaction, verifies it,
 *      then ROLLBACK, and proves no access_* table remains and data is unchanged.
 *   5. Applies the migration for real (it has its own BEGIN/COMMIT).
 *   6. Verifies: 5 tables, FORCE RLS + 1 policy each, both triggers, audit append-only.
 *   7. Business snapshot AFTER and comparison. Any difference exits non-zero.
 *
 * It never touches vouchers, stock, accounts or role permissions; it only reads them.
 * Pass --dry-run to stop after the rollback drill.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const PRODUCTION_DATABASE_NAMES = new Set(["erp_db_qscj_64lv_e7rz_8744_2lm3"]);
const MIGRATION = path.resolve("migrations/20261024_001_permissions_control_center_shadow.sql");
const BUSINESS_TABLES = [
  "vouchers",
  "voucher_entries",
  "inventory",
  "stock_items",
  "suppliers",
  "customers",
  "ledger_accounts",
  "factory_containers",
  "role_feature_permissions",
  "user_company_roles",
];
const ACCESS_TABLES = [
  "access_role_templates",
  "access_role_rules",
  "access_user_overrides",
  "access_policy_versions",
  "access_policy_change_audit",
];

const dryRun = process.argv.includes("--dry-run");
const report = { startedAt: new Date().toISOString(), dryRun, steps: [] };
function step(name, ok, detail = {}) {
  report.steps.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${Object.keys(detail).length ? " " + JSON.stringify(detail) : ""}`);
  if (!ok) finish(1);
}
function finish(code) {
  report.finishedAt = new Date().toISOString();
  report.result = code === 0 ? "passed" : "failed";
  const file = `permissions-staging-report-${report.startedAt.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Report written to ${file}`);
  process.exit(code);
}

async function snapshot(client) {
  const out = {};
  for (const table of BUSINESS_TABLES) {
    const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${table}`]);
    if (!exists.rows[0].ok) continue;
    const r = await client.query(
      `SELECT count(*)::text AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS h FROM ${table} t`
    );
    out[table] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}

async function verifyInstalled(client) {
  const tables = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)", [
    ACCESS_TABLES,
  ]);
  const forced = await client.query(
    "SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity",
    [ACCESS_TABLES]
  );
  const policies = await client.query(
    "SELECT count(*)::int AS n FROM pg_policies WHERE policyname='access_company_scope' AND tablename = ANY($1)",
    [ACCESS_TABLES]
  );
  const triggers = await client.query(
    "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('access_override_company_guard_trg','access_policy_audit_append_only_trg')"
  );
  return {
    tables: tables.rows[0].n,
    forcedRls: forced.rows[0].n,
    policies: policies.rows[0].n,
    triggers: triggers.rows[0].n,
  };
}

const connectionString = process.env.DATABASE_URL;
const expectedName = process.env.STAGING_DATABASE_NAME;
if (!connectionString || !expectedName) {
  console.error("Set DATABASE_URL (staging) and STAGING_DATABASE_NAME (the staging database name).");
  process.exit(2);
}

const client = new pg.Client({
  connectionString,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  // The application's tables use FORCE row-level security; reading every company
  // for the snapshot uses the reviewed maintenance capability for this session.
  await client.query("SELECT set_config('app.company_scope_maintenance', 'on', false)");

  const identity = await client.query("SELECT current_database() AS db, current_user AS usr, version() AS v");
  const { db, usr, v } = identity.rows[0];
  report.database = db;
  report.role = usr;
  report.serverVersion = v;
  step("not a production database", !PRODUCTION_DATABASE_NAMES.has(db), { database: db });
  step("connected to the expected staging database", db === expectedName, { expected: expectedName, actual: db });

  const prereq = await client.query(`SELECT
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'erp_company_scope_matches') AS scope_fn,
      (SELECT count(*)::int FROM pg_tables WHERE tablename IN ('companies','users','user_company_roles')) AS base_tables,
      (SELECT count(*)::int FROM pg_tables WHERE tablename LIKE 'access\\_%') AS existing_access_tables`);
  const p = prereq.rows[0];
  step("company-scope function present", p.scope_fn >= 1, { found: p.scope_fn });
  step("base tables present", p.base_tables === 3, { found: p.base_tables });
  report.preexistingAccessTables = p.existing_access_tables;

  const migrationSql = fs.readFileSync(MIGRATION, "utf8");
  // The file wraps itself in BEGIN/COMMIT; strip them to run it inside the drill transaction.
  const innerSql = migrationSql.replace(/^\s*BEGIN;\s*$/m, "").replace(/^\s*COMMIT;\s*$/m, "");

  const before = await snapshot(client);
  report.snapshotBefore = before;
  step("business snapshot taken", Object.keys(before).length > 0, { tables: Object.keys(before).length });

  // Rollback drill.
  await client.query("BEGIN");
  await client.query(innerSql);
  const drill = await verifyInstalled(client);
  await client.query("ROLLBACK");
  step("drill: migration applies inside a transaction", drill.tables === 5 && drill.forcedRls === 5, drill);
  const afterDrill = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)", [
    ACCESS_TABLES,
  ]);
  step("drill: ROLLBACK leaves no new access_* table", afterDrill.rows[0].n === p.existing_access_tables, {
    remaining: afterDrill.rows[0].n,
  });
  await client.query("SELECT set_config('app.company_scope_maintenance', 'on', false)");
  step("drill: business data unchanged", JSON.stringify(await snapshot(client)) === JSON.stringify(before));

  if (dryRun) finish(0);

  await client.query(migrationSql);
  await client.query("SELECT set_config('app.company_scope_maintenance', 'on', false)");
  const installed = await verifyInstalled(client);
  step(
    "migration applied: 5 tables, FORCE RLS, 5 policies, 2 triggers",
    installed.tables === 5 && installed.forcedRls === 5 && installed.policies === 5 && installed.triggers === 2,
    installed
  );

  // Audit append-only check without leaving a row behind.
  await client.query("BEGIN");
  const company = await client.query("SELECT id FROM companies ORDER BY id LIMIT 1");
  const actor = await client.query("SELECT id FROM users ORDER BY id LIMIT 1");
  let appendOnly = false;
  if (company.rows[0] && actor.rows[0]) {
    await client.query(
      `INSERT INTO access_policy_change_audit (company_id, revision, actor_id, subject_type, subject_key, before_rules, after_rules, reason)
       VALUES ($1, 999999999, $2, 'role', 'Staging check', '[]', '[]', 'Staging append-only check')`,
      [company.rows[0].id, actor.rows[0].id]
    );
    try {
      await client.query("SAVEPOINT s");
      await client.query("UPDATE access_policy_change_audit SET reason='Rewritten history' WHERE revision=999999999");
    } catch (error) {
      appendOnly = String(error.message).includes("ACCESS_POLICY_AUDIT_APPEND_ONLY");
      await client.query("ROLLBACK TO SAVEPOINT s");
    }
  }
  await client.query("ROLLBACK");
  step("audit refuses UPDATE (append-only)", appendOnly);

  await client.query("SELECT set_config('app.company_scope_maintenance', 'on', false)");
  const after = await snapshot(client);
  report.snapshotAfter = after;
  const changed = Object.keys(before).filter((table) => before[table] !== after[table]);
  step("business data unchanged after the migration", changed.length === 0, { changed });

  finish(0);
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {}
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL  ${report.error}`);
  finish(1);
} finally {
  await client.end().catch(() => {});
}
