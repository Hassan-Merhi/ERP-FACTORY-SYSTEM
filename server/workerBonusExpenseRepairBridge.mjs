import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;
const INSTALL_KEY = Symbol.for("erp.worker-bonus-expense-name-repair.applied");
const STARTUP_LOCK_KEY = 741_220_262;
const REQUIRED_TABLES = ["worker_bonuses", "factory_workers", "vouchers", "voucher_entries", "ledger_accounts"];

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
      module: "worker-bonus-expense-repair",
      action: "startup-ensure",
      ...extra,
    })
  );
}

export async function ensureHistoricalWorkerBonusExpenseNames() {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    log("WARN", "Skipping worker bonus expense repair because no PostgreSQL configuration is available");
    return;
  }

  const migrationSql = await readFile(
    new URL("../migrations/0018_worker_bonus_expense_worker_names.sql", import.meta.url),
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

    // The company-scope RLS bridge runs immediately before this module. This
    // dedicated startup transaction explicitly opts into maintenance scope so
    // the repair can safely reconcile historical rows across factory companies.
    await client.query(
      `SELECT
         set_config('app.company_scope_maintenance', 'on', true),
         set_config('app.current_company_id', '', true),
         set_config('app.authorized_company_ids', '', true)`
    );

    const tableCheck = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES]
    );
    const presentTables = new Set(tableCheck.rows.map((row) => row.table_name));
    const missingTables = REQUIRED_TABLES.filter((tableName) => !presentTables.has(tableName));
    if (missingTables.length > 0) {
      await client.query("COMMIT");
      log("INFO", "Worker bonus expense repair deferred until required tables exist", { missingTables });
      return;
    }

    await client.query(migrationSql);

    const remaining = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM worker_bonuses wb
      JOIN vouchers v
        ON v.company_id = wb.company_id
       AND v.voucher_number LIKE ('WBONUS-' || wb.id || '-%')
      JOIN voucher_entries ve
        ON ve.voucher_id = v.id
       AND COALESCE(ve.debit_amount, 0)::numeric > 0
      JOIN ledger_accounts la
        ON la.id = ve.ledger_account_id
      JOIN factory_workers fw
        ON fw.id = wb.worker_id
       AND fw.company_id = wb.company_id
      WHERE wb.status = 'paid'
        AND NULLIF(btrim(fw.full_name), '') IS NOT NULL
        AND la.name <> ('Bonus Expense - ' || btrim(fw.full_name))
    `);

    await client.query("COMMIT");
    log("INFO", "Historical worker bonus expense accounts reconciled", {
      remainingMismatchedBonusEntries: remaining.rows[0]?.count ?? 0,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    log("ERROR", "Historical worker bonus expense repair failed", {
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
  await ensureHistoricalWorkerBonusExpenseNames();
}

// Wave 6 inventory repair is separately env-gated and fail-closed. It runs
// after company-scope RLS readiness so the tenant-scoped transaction is valid.
await import("./inventoryValuationWave6RepairBridge.mjs");
