import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  (process.env.PGHOST
    ? `postgresql://${encodeURIComponent(process.env.PGUSER || "")}:${encodeURIComponent(process.env.PGPASSWORD || "")}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE || ""}`
    : "");

const CORE_COLUMNS = Object.freeze(["id", "company_id", "container_number"]);

// Drizzle includes every declared table column in INSERT statements, using DEFAULT
// for fields that were not supplied. Therefore one missing optional column makes
// every factory-container create fail before PostgreSQL can insert the row.
const REQUIRED_COLUMNS = Object.freeze([
  ["supplier_id", "INTEGER"],
  ["origin", "TEXT"],
  ["total_kg", "NUMERIC(15,3)"],
  ["rate_per_kg", "NUMERIC(20,6)"],
  ["declared_kg", "NUMERIC(15,3)"],
  ["actual_received_kg", "NUMERIC(15,3)"],
  ["final_payable_amount", "NUMERIC(20,4)"],
  ["difference_kg", "NUMERIC(15,3)"],
  ["currency_code", "VARCHAR(10) NOT NULL DEFAULT 'USD'"],
  ["fx_rate_to_usd", "NUMERIC(20,8) NOT NULL DEFAULT 1"],
  ["fx_rate_to_usd_import", "NUMERIC(20,8)"],
  ["fx_rate_to_usd_offload", "NUMERIC(20,8)"],
  ["fx_rate_source", "TEXT NOT NULL DEFAULT 'auto'"],
  ["fx_rate_confirmed", "BOOLEAN NOT NULL DEFAULT false"],
  ["fx_rate_date_import", "DATE"],
  ["fx_rate_date_offload", "DATE"],
  ["rate_per_kg_usd", "NUMERIC(20,6)"],
  ["final_payable_amount_usd", "NUMERIC(20,4)"],
  ["arrival_date", "DATE"],
  ["destination", "TEXT"],
  ["notes", "TEXT"],
  ["status", "TEXT NOT NULL DEFAULT 'PENDING'"],
  ["freight", "NUMERIC(20,2) DEFAULT 0"],
  ["freight_currency_code", "VARCHAR(10) DEFAULT 'USD'"],
  ["freight_account_id", "INTEGER"],
  ["freight_supplier_id", "INTEGER"],
  ["freight_paid_by", "TEXT DEFAULT 'supplier'"],
  ["freight_own_account_id", "INTEGER"],
  ["freight_fx_rate_to_usd", "NUMERIC(20,8)"],
  ["freight_fx_rate_confirmed", "BOOLEAN NOT NULL DEFAULT false"],
  ["freight_fx_rate_date", "DATE"],
  ["other_charges", "NUMERIC(20,2) DEFAULT 0"],
  ["other_charges_currency_code", "VARCHAR(10)"],
  ["other_charges_account_id", "INTEGER"],
  ["other_charges_supplier_id", "INTEGER"],
  ["commission_amount", "NUMERIC(20,2) DEFAULT 0"],
  ["commission_currency_code", "VARCHAR(10) DEFAULT 'USD'"],
  ["commission_account_id", "INTEGER"],
  ["commission_supplier_id", "INTEGER"],
  ["commission_notes", "TEXT"],
  ["commission_fx_rate_to_usd", "NUMERIC(20,8)"],
  ["commission_fx_rate_confirmed", "BOOLEAN NOT NULL DEFAULT false"],
  ["commission_fx_rate_date", "DATE"],
  ["duty_amount", "NUMERIC(20,2)"],
  ["duty_account_id", "INTEGER"],
  ["duty_status", "TEXT NOT NULL DEFAULT 'NONE'"],
  ["duty_notes", "TEXT"],
  ["pre_offload_freight", "NUMERIC(20,2)"],
  ["pre_offload_freight_currency_code", "VARCHAR(10)"],
  ["pre_offload_freight_account_id", "INTEGER"],
  ["pre_offload_freight_supplier_id", "INTEGER"],
  ["pre_offload_other_charges", "NUMERIC(20,2)"],
  ["pre_offload_other_charges_account_id", "INTEGER"],
  ["pre_offload_other_charges_supplier_id", "INTEGER"],
  ["pre_offload_status", "TEXT"],
  ["pre_offload_commission_amount", "NUMERIC(20,2)"],
  ["pre_offload_commission_currency_code", "VARCHAR(10)"],
  ["pre_offload_commission_account_id", "INTEGER"],
  ["pre_offload_commission_supplier_id", "INTEGER"],
  ["pre_offload_commission_notes", "TEXT"],
  ["deleted_at", "TIMESTAMP"],
  ["created_at", "TIMESTAMP NOT NULL DEFAULT now()"],
  ["updated_at", "TIMESTAMP NOT NULL DEFAULT now()"],
  ["tracking_enabled", "BOOLEAN NOT NULL DEFAULT true"],
  ["tracking_auto_update", "BOOLEAN NOT NULL DEFAULT true"],
  ["tracking_carrier_hint", "TEXT"],
  ["tracking_provider", "TEXT"],
  ["tracking_last_status", "TEXT"],
  ["tracking_last_location", "TEXT"],
  ["tracking_last_checked_at", "TIMESTAMPTZ"],
  ["tracking_last_event_date", "TIMESTAMPTZ"],
  ["tracking_last_description", "TEXT"],
  ["tracking_error", "TEXT"],
  ["tracking_changed_at", "TIMESTAMPTZ"],
  ["tracking_detected_carrier", "TEXT"],
  ["tracking_next_check_at", "TIMESTAMPTZ"],
  ["tracking_last_skip_reason", "TEXT"],
  ["json_cargo_last_checked_at", "TIMESTAMPTZ"],
  ["json_cargo_tracking_status", "TEXT"],
  ["json_cargo_error", "TEXT"],
  ["otw_note", "TEXT"],
  ["otw_docs_received", "BOOLEAN NOT NULL DEFAULT false"],
]);

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "factory-container-schema",
      action: "startup-ensure",
      ...extra,
    })
  );
}

async function ensureFactoryContainerSchema() {
  if (!connectionString) {
    log("WARN", "Factory container schema check skipped because no database configuration is available");
    return;
  }

  const client = new Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 8_000,
  });

  const columnsAdded = [];

  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '90s'");

    const tableLookup = await client.query(`SELECT to_regclass('public.factory_containers') AS table_name`);
    if (!tableLookup.rows[0]?.table_name) {
      throw new Error("Required table public.factory_containers does not exist");
    }

    const columnResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'factory_containers'
    `);
    const existingColumns = new Set(columnResult.rows.map((row) => row.column_name));

    const missingCoreColumns = CORE_COLUMNS.filter((columnName) => !existingColumns.has(columnName));
    if (missingCoreColumns.length > 0) {
      throw new Error(`factory_containers is missing core column(s): ${missingCoreColumns.join(", ")}`);
    }

    for (const [columnName, definition] of REQUIRED_COLUMNS) {
      if (existingColumns.has(columnName)) continue;
      await client.query(`ALTER TABLE factory_containers ADD COLUMN ${columnName} ${definition}`);
      existingColumns.add(columnName);
      columnsAdded.push(columnName);
    }

    const requiredJsonCargoColumns = ["json_cargo_last_checked_at", "json_cargo_tracking_status", "json_cargo_error"];
    const missingAfterRepair = requiredJsonCargoColumns.filter((columnName) => !existingColumns.has(columnName));
    if (missingAfterRepair.length > 0) {
      throw new Error(`Factory container JSONCargo columns remain missing: ${missingAfterRepair.join(", ")}`);
    }

    await client.query("COMMIT");
    log("INFO", "Factory container schema verified", {
      columnsAdded,
      jsonCargoColumnsVerified: requiredJsonCargoColumns,
      startupMigrationsEnabled: process.env.RUN_STARTUP_MIGRATIONS !== "false",
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    log("ERROR", "Factory container schema verification failed; aborting startup", {
      errorCode: error?.code,
      errorMessage: error?.message || String(error),
      columnsAdded,
    });
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

await ensureFactoryContainerSchema();
