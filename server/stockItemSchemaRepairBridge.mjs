import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;
const INSTALL_KEY = Symbol.for("erp.stock-item-schema-repair.applied");
const STARTUP_LOCK_KEY = 741_220_263;
const REQUIRED_COLUMNS = [
  "stock_group_id",
  "grade_id",
  "category_id",
  "opening_qty",
  "opening_rate",
  "opening_value",
  "reorder_level",
  "selling_price",
  "active",
  "deleted_at",
  "created_at",
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
      module: "stock-item-schema-repair",
      action: "startup-ensure",
      ...extra,
    })
  );
}

async function readPresentColumns(client) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'stock_items'
        AND column_name = ANY($1::text[])`,
    [REQUIRED_COLUMNS]
  );
  return new Set(result.rows.map((row) => row.column_name));
}

export async function ensureStockItemSchemaReadiness() {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    log("WARN", "Stock-item schema repair check skipped because no database configuration is available");
    return;
  }

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

    const tableCheck = await client.query("SELECT to_regclass('public.stock_items') AS table_name");
    if (!tableCheck.rows[0]?.table_name) {
      await client.query("COMMIT");
      log("INFO", "stock_items does not exist yet; deferred to normal startup migrations");
      return;
    }

    // stock_items is protected by FORCE RLS in production. This is a dedicated
    // startup-only schema repair connection, so establish the same explicit
    // maintenance capability used by the reviewed migration path.
    await client.query(
      `SELECT
         set_config('app.company_scope_maintenance', 'on', true),
         set_config('app.current_company_id', '', true),
         set_config('app.authorized_company_ids', '', true)`
    );

    const before = await readPresentColumns(client);

    if (!before.has("stock_group_id")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN stock_group_id integer");
      log("INFO", "Added missing stock_items column", { columnName: "stock_group_id" });
    }
    if (!before.has("grade_id")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN grade_id integer");
      log("INFO", "Added missing stock_items column", { columnName: "grade_id" });
    }
    if (!before.has("category_id")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN category_id integer");
      log("INFO", "Added missing stock_items column", { columnName: "category_id" });
    }
    if (!before.has("opening_qty")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN opening_qty numeric(15,3) DEFAULT 0");
      log("INFO", "Added missing stock_items column", { columnName: "opening_qty" });
    }
    if (!before.has("opening_rate")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN opening_rate numeric(15,2) DEFAULT 0");
      log("INFO", "Added missing stock_items column", { columnName: "opening_rate" });
    }
    if (!before.has("opening_value")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN opening_value numeric(15,2) DEFAULT 0");
      log("INFO", "Added missing stock_items column", { columnName: "opening_value" });
    }
    if (!before.has("reorder_level")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN reorder_level numeric(15,3) DEFAULT 0");
      log("INFO", "Added missing stock_items column", { columnName: "reorder_level" });
    }
    if (!before.has("selling_price")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN selling_price numeric(15,2) DEFAULT 0");
      log("INFO", "Added missing stock_items column", { columnName: "selling_price" });
    }
    if (!before.has("active")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN active boolean NOT NULL DEFAULT true");
      log("INFO", "Added missing stock_items column", { columnName: "active" });
    }
    if (!before.has("deleted_at")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN deleted_at timestamp");
      log("INFO", "Added missing stock_items column", { columnName: "deleted_at" });
    }
    if (!before.has("created_at")) {
      await client.query("ALTER TABLE stock_items ADD COLUMN created_at timestamp NOT NULL DEFAULT now()");
      log("INFO", "Added missing stock_items column", { columnName: "created_at" });
    }

    const after = await readPresentColumns(client);
    const missing = REQUIRED_COLUMNS.filter((name) => !after.has(name));
    if (missing.length > 0) {
      throw new Error(`stock_items schema is still missing required columns: ${missing.join(", ")}`);
    }

    // Validate the exact full-row shape used by Drizzle-backed stock-item reads.
    // LIMIT 0 asks PostgreSQL to resolve every column without reading tenant data.
    await client.query(`SELECT
      id,
      company_id,
      code,
      name,
      stock_group_id,
      grade_id,
      category_id,
      uom,
      opening_qty,
      opening_rate,
      opening_value,
      reorder_level,
      selling_price,
      active,
      deleted_at,
      created_at
    FROM stock_items
    LIMIT 0`);

    await client.query("COMMIT");
    log("INFO", "Stock-item schema readiness verified", {
      requiredColumns: REQUIRED_COLUMNS.length,
      startupMigrationsEnabled: process.env.RUN_STARTUP_MIGRATIONS !== "false",
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    log("ERROR", "Stock-item schema readiness failed; aborting startup", {
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
  await ensureStockItemSchemaReadiness();
}
