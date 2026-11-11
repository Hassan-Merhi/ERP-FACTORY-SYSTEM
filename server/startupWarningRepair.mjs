import { Client } from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const REPAIR_LOCK_KEY = "erp-startup-warning-repair-v1";

const SUPPLIER_SYNC_COLUMNS = [
  {
    table: "vouchers",
    column: "supplier_id",
    ddl: `ALTER TABLE vouchers ADD COLUMN supplier_id INTEGER`,
  },
  {
    table: "voucher_entries",
    column: "supplier_id",
    ddl: `ALTER TABLE voucher_entries ADD COLUMN supplier_id INTEGER`,
  },
  {
    table: "sp_containers",
    column: "supplier_id",
    ddl: `ALTER TABLE sp_containers ADD COLUMN supplier_id INTEGER`,
  },
  {
    table: "sp_containers",
    column: "goods_otw_voucher_id",
    ddl: `ALTER TABLE sp_containers ADD COLUMN goods_otw_voucher_id INTEGER`,
  },
  {
    table: "ledger_accounts",
    column: "sub_type",
    ddl: `ALTER TABLE ledger_accounts ADD COLUMN sub_type TEXT`,
  },
  {
    table: "user_preferences",
    column: "factory_net_position_valuation_mode",
    ddl: `ALTER TABLE user_preferences
      ADD COLUMN factory_net_position_valuation_mode TEXT NOT NULL DEFAULT 'cost'`,
  },
];

function structuredLog(level, message, detail = {}) {
  const writer = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  writer(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "startup-warning-repair",
      action: "startup-repair",
      ...detail,
    })
  );
}

function connectionOptions() {
  const connectionString =
    process.env.DATABASE_URL ||
    (process.env.PGHOST
      ? `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`
      : "");

  if (!connectionString) return null;

  return {
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
  };
}

async function existingTables(client) {
  const result = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [["exchange_rates", "vouchers", "voucher_entries", "sp_containers", "ledger_accounts", "user_preferences"]]
  );
  return new Set(result.rows.map((row) => row.table_name));
}

async function ensureSupplierSyncColumns(client, tables) {
  const ensured = [];

  for (const spec of SUPPLIER_SYNC_COLUMNS) {
    if (!tables.has(spec.table)) continue;

    const columnCheck = await client.query(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_name = $2
       ) AS exists`,
      [spec.table, spec.column]
    );

    if (columnCheck.rows[0]?.exists) continue;

    await client.query(spec.ddl);
    ensured.push(`${spec.table}.${spec.column}`);
  }

  return ensured;
}

async function repairExchangeRateDuplicates(client, tables) {
  if (!tables.has("exchange_rates")) {
    return { duplicateRowsRemoved: 0, indexEnsured: false, indexAlreadyPresent: false };
  }

  const indexCheck = await client.query(
    `SELECT to_regclass('public.exchange_rates_company_date_pair_unique') IS NOT NULL AS exists`
  );
  if (indexCheck.rows[0]?.exists) {
    return { duplicateRowsRemoved: 0, indexEnsured: true, indexAlreadyPresent: true };
  }

  await client.query(`LOCK TABLE exchange_rates IN SHARE ROW EXCLUSIVE MODE`);

  const removed = await client.query(`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY company_id, effective_date, from_currency, to_currency
               ORDER BY id DESC
             ) AS duplicate_rank
        FROM exchange_rates
    )
    DELETE FROM exchange_rates er
    USING ranked r
    WHERE er.id = r.id
      AND r.duplicate_rank > 1
    RETURNING er.id
  `);

  await client.query(`
    CREATE UNIQUE INDEX exchange_rates_company_date_pair_unique
      ON exchange_rates (company_id, effective_date, from_currency, to_currency)
  `);

  return {
    duplicateRowsRemoved: removed.rowCount ?? 0,
    indexEnsured: true,
    indexAlreadyPresent: false,
  };
}


/**
 * Opt-in verification path for the post-migration deployment stage.
 * The transaction is READ ONLY, so neither DDL nor data repair can execute.
 * A missing or invalid schema fails startup instead of continuing silently.
 */
async function verifyStartupWarningSchema(client) {
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '20s'");
    const tables = await existingTables(client);
    const missing = [];
    for (const spec of SUPPLIER_SYNC_COLUMNS) {
      if (!tables.has(spec.table)) {
        missing.push("table " + spec.table);
        continue;
      }
      const exists = await client.query(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name=$2
        ) AS present`, [spec.table, spec.column]
      );
      if (exists.rows[0]?.present !== true) missing.push(spec.table + "." + spec.column);
    }
    const index = await client.query(`
      SELECT i.indisvalid AS valid, i.indisready AS ready,
             pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_index i ON i.indexrelid=c.oid
      WHERE n.nspname='public' AND c.relname='exchange_rates_company_date_pair_unique'
    `);
    if (index.rowCount !== 1 || index.rows[0]?.valid !== true ||
        index.rows[0]?.ready !== true ||
        !/ON (?:public\\.)?exchange_rates USING btree \\(company_id, effective_date, from_currency, to_currency\\)/i.test(index.rows[0]?.definition || "")) {
      missing.push("valid exchange_rates_company_date_pair_unique index");
    }
    if (missing.length) throw new Error("Startup schema verify-only failed: " + missing.join(", "));
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function runStartupWarningRepair() {
  const options = connectionOptions();
  if (!options) {
    structuredLog("INFO", "Startup warning repair skipped because no database configuration is present");
    return;
  }

  const client = new Client(options);
  let transactionStarted = false;
  const verifyOnly = process.env.STARTUP_WARNING_SCHEMA_MODE === "verify-only";

  try {
    await client.connect();
    if (verifyOnly) {
      await verifyStartupWarningSchema(client);
      structuredLog("INFO", "Startup warning schema verified without writes");
      return;
    }
    await client.query(`SET lock_timeout = '30s'`);
    await client.query(`SET statement_timeout = '120s'`);
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [REPAIR_LOCK_KEY]);

    const tables = await existingTables(client);
    const ensuredColumns = await ensureSupplierSyncColumns(client, tables);
    const exchangeRateRepair = await repairExchangeRateDuplicates(client, tables);

    await client.query("COMMIT");
    transactionStarted = false;

    structuredLog("INFO", "Startup database warning repair completed", {
      ensuredColumns,
      ...exchangeRateRepair,
    });
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    structuredLog(verifyOnly ? "ERROR" : "WARN", "Startup database warning repair could not complete" + (verifyOnly ? "; startup aborting" : "; normal server startup will continue"), {
      error: error instanceof Error ? error.message : String(error),
      code: error && typeof error === "object" && "code" in error ? error.code : undefined,
    });
    if (verifyOnly) throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

await runStartupWarningRepair();
