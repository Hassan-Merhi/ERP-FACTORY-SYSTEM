import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;
const INSTALL_KEY = Symbol.for("erp.stock-adjustment-header-repair.applied");
const STARTUP_LOCK_KEY = 741_220_529;
const REQUIRED_TABLES = ["vouchers", "stock_adjustment_vouchers", "stock_adjustment_items"];

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
      module: "stock-adjustment-header-repair",
      action: "startup-ensure",
      ...extra,
    })
  );
}

const mismatchSql = `
  WITH calculated AS (
    SELECT
      sav.voucher_id,
      ROUND(
        CASE
          WHEN LOWER(COALESCE(sav.adjustment_type, '')) = 'mixed' THEN
            COALESCE(
              SUM(
                CASE
                  WHEN COALESCE(sai.quantity, 0) > 0
                    THEN ABS(COALESCE(sai.total_amount, 0))
                  ELSE -ABS(COALESCE(sai.total_amount, 0))
                END
              ),
              0
            )
          ELSE COALESCE(SUM(ABS(COALESCE(sai.total_amount, 0))), 0)
        END,
        2
      ) AS expected_total
    FROM stock_adjustment_vouchers sav
    JOIN stock_adjustment_items sai
      ON sai.adjustment_id = sav.id
    GROUP BY sav.id, sav.voucher_id, sav.adjustment_type
  )
  SELECT COUNT(*)::int AS count
  FROM calculated
  JOIN vouchers v ON v.id = calculated.voucher_id
  WHERE ABS(COALESCE(v.total_amount, 0) - calculated.expected_total) >= 0.01
`;

export async function ensureStockAdjustmentHeaderTotals() {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    log("WARN", "Skipping stock-adjustment header repair because no PostgreSQL configuration is available");
    return;
  }

  const repairSql = await readFile(
    new URL("../migrations/20260929_001_stock_adjustment_header_totals.sql", import.meta.url),
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
      log("INFO", "Stock-adjustment header repair deferred until required tables exist", { missingTables });
      return;
    }

    const before = await client.query(mismatchSql);
    const repair = await client.query(repairSql);
    const after = await client.query(mismatchSql);

    await client.query("COMMIT");
    log("INFO", "Historical stock-adjustment headers reconciled", {
      mismatchesBefore: Number(before.rows[0]?.count || 0),
      headersUpdated: repair.rowCount ?? 0,
      mismatchesAfter: Number(after.rows[0]?.count || 0),
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    log("ERROR", "Historical stock-adjustment header repair failed", {
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
  await ensureStockAdjustmentHeaderTotals();
}
