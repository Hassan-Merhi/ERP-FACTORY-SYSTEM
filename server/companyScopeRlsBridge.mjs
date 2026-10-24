import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;
const INSTALL_KEY = Symbol.for("erp.company-scope-rls-readiness.applied");
const STARTUP_LOCK_KEY = 741_220_261;
const REQUIRED_DIRECT_TABLES = [
  "vouchers",
  "customers",
  "ledger_accounts",
  "bank_accounts",
  "fixed_assets",
  "stock_groups",
  "stock_items",
  "inventory",
];

function resolveConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE) {
    return `postgresql://${encodeURIComponent(process.env.PGUSER)}:${encodeURIComponent(process.env.PGPASSWORD)}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE}`;
  }
  return "";
}

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "company-scope-rls",
      action: "startup-ensure",
      ...extra,
    })
  );
}

const SCOPE_EXPRESSION = "erp_company_scope_matches(company_id)";
const EXPECTED_TRIGGERS = {
  voucher_entries_sync_company_id:
    "CREATE TRIGGER voucher_entries_sync_company_id BEFORE INSERT OR UPDATE OF voucher_id, company_id ON public.voucher_entries FOR EACH ROW EXECUTE FUNCTION erp_sync_voucher_entry_company_id()",
  vouchers_sync_entry_company_id:
    "CREATE TRIGGER vouchers_sync_entry_company_id AFTER UPDATE OF company_id ON public.vouchers FOR EACH ROW EXECUTE FUNCTION erp_sync_voucher_entry_company_from_voucher()",
};

// Each function 0016 defines, as PostgreSQL reports it once installed.
function migrationFunctions(migrationSql) {
  const functions = new Map();
  const pattern =
    /CREATE OR REPLACE FUNCTION (\w+)\(([^)]*)\)\s+RETURNS (\S+)\s+LANGUAGE (\w+)\s+(?:(STABLE|IMMUTABLE|VOLATILE)\s+)?AS \$(\w*)\$([\s\S]*?)\$\6\$/g;
  for (const [, name, args, result, language, volatility = "VOLATILE", , body] of migrationSql.matchAll(pattern)) {
    functions.set(name, { args, result, language, volatility: volatility[0].toLowerCase(), body });
  }
  return functions;
}

// Read-only: what migration 0016 would still change. Its policy, trigger and
// RLS statements take ACCESS EXCLUSIVE locks on vouchers and voucher_entries;
// replaying it on every boot deadlocked against the instance still serving
// traffic during a deploy (40P01, 2026-10-23). Anything unrecognised counts as
// missing, so the migration still runs whenever in doubt.
async function missingRlsReadiness(client, migrationSql) {
  const missing = [];
  const expected = migrationFunctions(migrationSql);
  const functions = await client.query(
    `SELECT p.proname, p.prosrc, pg_get_function_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
            l.lanname AS language, p.provolatile AS volatility,
            (NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND p.proconfig IS NULL) AS plain
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [[...expected.keys()]]
  );
  for (const [name, want] of expected) {
    const installed = functions.rows.filter((row) => row.proname === name);
    const row = installed[0];
    if (
      installed.length !== 1 ||
      row.prosrc !== want.body ||
      row.args !== want.args ||
      row.result !== want.result ||
      row.language !== want.language ||
      row.volatility !== want.volatility ||
      row.plain !== true
    ) {
      missing.push(`function ${name}`);
    }
  }

  const tables = await client.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.permissive, p.roles::text AS roles,
            p.cmd, p.qual, p.with_check
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
        AND p.policyname = c.relname || '_company_scope_policy'
      WHERE c.relkind = 'r' AND c.relname = ANY($1::text[])`,
    [[...REQUIRED_DIRECT_TABLES, "voucher_entries"]]
  );
  for (const row of tables.rows) {
    if (
      !row.relrowsecurity ||
      !row.relforcerowsecurity ||
      row.permissive !== "PERMISSIVE" ||
      row.roles !== "{public}" ||
      row.cmd !== "ALL" ||
      row.qual !== SCOPE_EXPRESSION ||
      row.with_check !== SCOPE_EXPRESSION
    ) {
      missing.push(`table ${row.relname}`);
    }
  }
  if (!tables.rows.some((row) => row.relname === "voucher_entries")) return missing;

  const entries = await client.query(
    `
    SELECT
      (SELECT column_default = '0' AND is_nullable = 'NO' FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'voucher_entries' AND column_name = 'company_id') AS column_ready,
      to_regclass('public.voucher_entries_company_idx') IS NOT NULL AS index_ready,
      (SELECT json_object_agg(t.tgname, pg_get_triggerdef(t.oid)) FROM pg_trigger t
        WHERE t.tgname = ANY($1::text[]) AND NOT t.tgisinternal AND t.tgenabled = 'O') AS triggers
  `,
    [Object.keys(EXPECTED_TRIGGERS)]
  );
  const state = entries.rows[0] || {};
  if (state.column_ready !== true) missing.push("voucher_entries.company_id");
  if (state.index_ready !== true) missing.push("voucher_entries_company_idx");
  for (const [name, definition] of Object.entries(EXPECTED_TRIGGERS)) {
    if (state.triggers?.[name] !== definition) missing.push(`trigger ${name}`);
  }

  // The backfill probe reads voucher_entries.company_id, which a fresh or
  // partly migrated database may not have yet; the migration runs regardless.
  if (missing.length > 0) return missing;

  await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
  const unsynced = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
       WHERE ve.company_id IS DISTINCT FROM v.company_id
    ) AS unsynced
  `);
  await client.query("SELECT set_config('app.company_scope_maintenance', 'off', true)");
  if (unsynced.rows[0]?.unsynced) missing.push("voucher_entries company backfill");
  return missing;
}

export async function ensureCompanyScopeRlsReadiness() {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    log("WARN", "Company-scope RLS migration check skipped because no database configuration is available");
    return;
  }

  const migrationSql = await readFile(
    new URL("../migrations/0016_company_scope_rls_readiness.sql", import.meta.url),
    "utf8"
  );
  const client = new Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 15_000,
  });

  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '90s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [STARTUP_LOCK_KEY]);
    const missing = await missingRlsReadiness(client, migrationSql);
    if (missing.length > 0) {
      log("INFO", "Applying company-scope RLS readiness migration", { missing });
      await client.query(migrationSql);
    }

    const functionCheck = await client.query(`
      SELECT
        to_regprocedure('erp_company_scope_maintenance_enabled()') IS NOT NULL AS maintenance_function,
        to_regprocedure('erp_current_company_id()') IS NOT NULL AS current_company_function,
        to_regprocedure('erp_authorized_company_ids()') IS NOT NULL AS authorized_companies_function,
        to_regprocedure('erp_company_scope_matches(integer)') IS NOT NULL AS scope_match_function
    `);
    const functionState = functionCheck.rows[0] || {};
    if (
      !functionState.maintenance_function ||
      !functionState.current_company_function ||
      !functionState.authorized_companies_function ||
      !functionState.scope_match_function
    ) {
      throw new Error("Company-scope RLS helper functions were not installed.");
    }

    // Missing tenant scope must be an error, not the former all-company
    // compatibility state. Use a nested exception block so the expected 22023
    // does not poison the surrounding startup transaction.
    await client.query(`
      DO $fail_closed_probe$
      BEGIN
        PERFORM set_config('app.company_scope_maintenance', 'off', true);
        PERFORM set_config('app.current_company_id', '', true);
        PERFORM set_config('app.authorized_company_ids', '', true);
        BEGIN
          PERFORM erp_current_company_id();
        EXCEPTION WHEN SQLSTATE '22023' THEN
          RETURN;
        END;
        RAISE EXCEPTION 'Company-scope RLS did not fail closed without a tenant identity';
      END
      $fail_closed_probe$;
    `);

    const relationCheck = await client.query(
      `
        SELECT
          c.relname AS table_name,
          c.relrowsecurity AS rls_enabled,
          c.relforcerowsecurity AS rls_forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY($1::text[])
      `,
      [[...REQUIRED_DIRECT_TABLES, "voucher_entries"]]
    );
    const relationState = new Map(
      relationCheck.rows.map((row) => [
        row.table_name,
        { enabled: row.rls_enabled === true, forced: row.rls_forced === true },
      ])
    );
    const existingTables = relationCheck.rows.map((row) => row.table_name);
    const rlsDisabled = existingTables.filter((tableName) => relationState.get(tableName)?.enabled !== true);
    if (rlsDisabled.length > 0) {
      throw new Error(`RLS was not enabled on: ${rlsDisabled.join(", ")}`);
    }

    const rlsNotForced = existingTables.filter((tableName) => relationState.get(tableName)?.forced !== true);
    if (rlsNotForced.length > 0) {
      throw new Error(`RLS was not forced on: ${rlsNotForced.join(", ")}`);
    }

    const policyCheck = await client.query(
      `
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND (
            (tablename = ANY($1::text[]) AND policyname = tablename || '_company_scope_policy')
            OR (tablename = 'voucher_entries' AND policyname = 'voucher_entries_company_scope_policy')
          )
      `,
      [REQUIRED_DIRECT_TABLES]
    );
    const policyTables = new Set(policyCheck.rows.map((row) => row.tablename));
    const missingPolicies = existingTables.filter((tableName) => !policyTables.has(tableName));
    if (missingPolicies.length > 0) {
      throw new Error(`Company-scope policy was not installed on: ${missingPolicies.join(", ")}`);
    }

    const voucherEntryScopeCheck = await client.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'voucher_entries'
            AND column_name = 'company_id'
            AND is_nullable = 'NO'
        ) AS company_column_ready,
        to_regclass('public.voucher_entries_company_idx') IS NOT NULL AS company_index_ready,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'public.voucher_entries'::regclass
            AND tgname = 'voucher_entries_sync_company_id'
            AND NOT tgisinternal
        ) AS entry_sync_trigger_ready,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'public.vouchers'::regclass
            AND tgname = 'vouchers_sync_entry_company_id'
            AND NOT tgisinternal
        ) AS voucher_sync_trigger_ready,
        (
          SELECT qual::text
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'voucher_entries'
            AND policyname = 'voucher_entries_company_scope_policy'
        ) AS policy_qual
    `);
    const voucherEntryScope = voucherEntryScopeCheck.rows[0] || {};
    if (
      !voucherEntryScope.company_column_ready ||
      !voucherEntryScope.company_index_ready ||
      !voucherEntryScope.entry_sync_trigger_ready ||
      !voucherEntryScope.voucher_sync_trigger_ready ||
      !String(voucherEntryScope.policy_qual || "").includes("erp_company_scope_matches(company_id)")
    ) {
      throw new Error("Voucher-entry direct company-scope RLS fast path was not installed completely.");
    }

    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    const voucherEntryMismatch = await client.query(`
      SELECT COUNT(*)::int AS mismatch_count
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      WHERE ve.company_id IS DISTINCT FROM v.company_id
    `);
    await client.query("SELECT set_config('app.company_scope_maintenance', 'off', true)");
    if (Number(voucherEntryMismatch.rows[0]?.mismatch_count || 0) !== 0) {
      throw new Error("Voucher-entry company scope is out of sync with parent vouchers.");
    }

    await client.query("COMMIT");
    log("INFO", "Company-scope RLS fail-closed readiness verified", {
      tablesPresent: existingTables.length,
      policiesPresent: policyCheck.rows.length,
      forcedTables: existingTables.length,
      voucherEntryFastPath: true,
      migrationApplied: missing.length > 0,
      startupMigrationsEnabled: process.env.RUN_STARTUP_MIGRATIONS !== "false",
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    log("ERROR", "Company-scope RLS readiness failed; aborting startup", {
      errorCode: error?.code,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;
  await ensureCompanyScopeRlsReadiness();
}

// Phase 19 (A): the worker-bonus expense account repair (migration 0018) and the
// CHARGE-PRE factory charge voucher repair no longer run at boot. They rewrote
// posted lines, recreated vouchers and hard-deleted accounts in maintenance
// scope with no audit; production showed nothing left for either to repair
// (2026-10-10), and the charge routes write CHARGE-PRE vouchers themselves.
//
// Wave 6 inventory repair is separately env-gated and fail-closed. It runs
// after company-scope RLS readiness so the tenant-scoped transaction is valid.
await import("./inventoryValuationWave6RepairBridge.mjs");
