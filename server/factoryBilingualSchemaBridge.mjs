import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;
const INSTALL_KEY = Symbol.for("erp.factory-bilingual-schema.applied");
const STARTUP_SCHEMA_LOCK_SQL =
  "SELECT pg_advisory_lock(hashtext('erp.startup'), hashtext('factory-schema'))";
const STARTUP_SCHEMA_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('erp.startup'), hashtext('factory-schema'))";

const connectionString =
  process.env.DATABASE_URL ||
  (process.env.PGHOST
    ? `postgresql://${encodeURIComponent(process.env.PGUSER || "")}:${encodeURIComponent(
        process.env.PGPASSWORD || ""
      )}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE || ""}`
    : "");

export const FACTORY_BILINGUAL_COLUMNS = Object.freeze([
  ["factory_categories", "name_ar", "VARCHAR(100)", true],
  ["factory_bale_products", "name_ar", "TEXT", true],
  ["factory_bale_products", "description_ar", "TEXT", true],
  ["factory_bales", "product_name_ar", "TEXT", true],
  ["factory_bales", "category_ar", "TEXT", true],
  ["customer_proforma_lines", "product_name_ar", "TEXT", true],
  ["customer_order_lines", "bale_name_ar", "TEXT", true],
  ["customer_order_bales", "bale_name_ar", "TEXT", true],
  ["customer_order_bales_history", "bale_name_ar", "TEXT", true],
  ["customer_order_expected_lines", "product_name_ar", "TEXT", true],
  ["factory_pos_sale_items", "product_name_ar", "TEXT", false],
  ["customer_order_bale_removals", "product_name_ar", "TEXT", false],
  ["factory_v3_load_bales", "product_name_ar", "TEXT", false],
  ["factory_invoice_loading_bales", "product_name_ar", "TEXT", false],
  ["customer_dispatch_bale_scans", "product_name_ar", "TEXT", false],
  ["bale_recode_items", "product_name_ar", "TEXT", false],
]);

export const FACTORY_BILINGUAL_ARTICLE_INDEX = "factory_bale_products_company_article_code_normalized_idx";

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "factory-bilingual-schema",
      action: "startup-ensure",
      ...extra,
    })
  );
}

export async function ensureFactoryBilingualSchema() {
  if (!connectionString) {
    if (process.env.FACTORY_BILINGUAL_SCHEMA_MODE === "verify-only") {
      throw new Error("Factory bilingual schema verification requires database configuration");
    }
    log("WARN", "Factory bilingual schema check skipped because no database configuration is available");
    return { columnsAdded: [], missingOptionalTables: [] };
  }

  const client = new Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 8_000,
  });

  const columnsAdded = [];
  const missingOptionalTables = new Set();
  const availableTables = new Set();
  let startupSchemaLockAcquired = false;

  try {
    await client.connect();
    const verifyOnly = process.env.FACTORY_BILINGUAL_SCHEMA_MODE === "verify-only";
    if (verifyOnly) {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const required = FACTORY_BILINGUAL_COLUMNS.filter(([, , , mustExist]) => mustExist);
      const existing = await client.query(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
      `);
      const columns = new Set(existing.rows.map((row) => row.table_name + "." + row.column_name));
      const tables = new Set(existing.rows.map((row) => row.table_name));
      const missing = FACTORY_BILINGUAL_COLUMNS.filter(([table, column, , mustExist]) =>
        (mustExist || tables.has(table)) && !columns.has(table + "." + column)
      ).map(([table, column]) => table + "." + column);
      if (required.some(([table]) => !tables.has(table))) {
        missing.push("required Factory bilingual table");
      }
      const index = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_index i
          JOIN pg_class c ON c.oid=i.indexrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=$1 AND i.indisvalid AND i.indisready
        ) AS ready
      `, [FACTORY_BILINGUAL_ARTICLE_INDEX]);
      if (!index.rows[0]?.ready) missing.push(FACTORY_BILINGUAL_ARTICLE_INDEX);
      if (missing.length) throw new Error("Factory bilingual schema incomplete: " + missing.join(", "));
      await client.query("ROLLBACK");
      log("INFO", "Factory bilingual schema verified read-only");
      return { columnsAdded: [], missingOptionalTables: [] };
    }
    await client.query("SET statement_timeout = '90s'");
    await client.query(STARTUP_SCHEMA_LOCK_SQL);
    startupSchemaLockAcquired = true;
    await client.query("RESET statement_timeout");

    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '90s'");

    const tableRequirements = new Map();
    for (const [tableName, , , required] of FACTORY_BILINGUAL_COLUMNS) {
      tableRequirements.set(tableName, Boolean(tableRequirements.get(tableName)) || required);
    }

    for (const [tableName, required] of tableRequirements) {
      const lookup = await client.query("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]);
      if (lookup.rows[0]?.table_name) {
        availableTables.add(tableName);
        continue;
      }

      if (required) throw new Error(`Required table public.${tableName} does not exist`);
      missingOptionalTables.add(tableName);
    }

    for (const [tableName, columnName, definition] of FACTORY_BILINGUAL_COLUMNS) {
      if (!availableTables.has(tableName)) continue;

      const existing = await client.query(
        `SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_name = $2`,
        [tableName, columnName]
      );
      if (existing.rowCount > 0) continue;

      await client.query(
        `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(
          columnName
        )} ${definition}`
      );
      columnsAdded.push(`${tableName}.${columnName}`);
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS ${FACTORY_BILINGUAL_ARTICLE_INDEX}
        ON factory_bale_products (company_id, UPPER(BTRIM(article_code)))
    `);

    const missingColumns = [];
    for (const [tableName, columnName] of FACTORY_BILINGUAL_COLUMNS) {
      if (!availableTables.has(tableName)) continue;
      const verification = await client.query(
        `SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2`,
        [tableName, columnName]
      );
      if (verification.rowCount === 0) missingColumns.push(`${tableName}.${columnName}`);
    }
    if (missingColumns.length > 0) {
      throw new Error(`Factory bilingual columns remain missing: ${missingColumns.join(", ")}`);
    }

    const indexVerification = await client.query(
      `SELECT 1
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = $1`,
      [FACTORY_BILINGUAL_ARTICLE_INDEX]
    );
    if (indexVerification.rowCount === 0) {
      throw new Error(`Factory bilingual article-code index remains missing: ${FACTORY_BILINGUAL_ARTICLE_INDEX}`);
    }

    await client.query("COMMIT");
    const result = { columnsAdded, missingOptionalTables: [...missingOptionalTables] };
    log("INFO", "Factory bilingual schema verified", result);
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    log("ERROR", "Factory bilingual schema verification failed; aborting startup", {
      errorCode: error?.code,
      errorMessage: error?.message || String(error),
      columnsAdded,
      missingOptionalTables: [...missingOptionalTables],
    });
    throw error;
  } finally {
    if (startupSchemaLockAcquired) {
      await client.query(STARTUP_SCHEMA_UNLOCK_SQL).catch(() => {});
    }
    await client.end().catch(() => {});
  }
}

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = ensureFactoryBilingualSchema();
}

await globalThis[INSTALL_KEY];
