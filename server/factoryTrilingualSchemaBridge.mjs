import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const INSTALL_KEY = Symbol.for("erp.factory-trilingual-schema.applied");
const STARTUP_SCHEMA_LOCK_SQL = "SELECT pg_advisory_lock(hashtext('erp.startup'), hashtext('factory-schema'))";
const STARTUP_SCHEMA_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('erp.startup'), hashtext('factory-schema'))";
const DEADLOCK_RETRY_DELAYS_MS = [250, 750, 1500];

function connectionStringFromEnvironment() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (
    process.env.PGHOST &&
    process.env.PGPORT &&
    process.env.PGUSER &&
    process.env.PGPASSWORD &&
    process.env.PGDATABASE
  ) {
    const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSchemaStatements(client, frenchSql, languagePreferenceSql) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.query(frenchSql);
      await client.query(languagePreferenceSql);
      await client.query(`
        DO $$
        BEGIN
          IF to_regclass('public.bale_recode_items') IS NOT NULL THEN
            ALTER TABLE public.bale_recode_items
              ADD COLUMN IF NOT EXISTS product_id INTEGER;
          END IF;
        END
        $$;
      `);
      return;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error?.code !== "40P01" || attempt >= DEADLOCK_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(DEADLOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function ensureFactoryTrilingualSchema() {
  const connectionString = connectionStringFromEnvironment();
  if (!connectionString) {
    if (process.env.FACTORY_MULTILINGUAL_SCHEMA_MODE === "verify-only") {
      throw new Error("Factory multilingual verify-only requires database configuration");
    }
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "WARN",
        message: "Factory trilingual schema check skipped because no database configuration is available",
        module: "factory-trilingual-schema",
        action: "startup-ensure",
      })
    );
    return;
  }

  const { Client } = pg;
  const client = new Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 15_000,
  });

  const frenchSql = await readFile(
    new URL("../migrations/20260802_001_factory_french_catalog_snapshots.sql", import.meta.url),
    "utf8"
  );
  const languagePreferenceSql = await readFile(
    new URL("../migrations/20260802_002_user_language_preferences.sql", import.meta.url),
    "utf8"
  );

  let startupSchemaLockAcquired = false;
  try {
    await client.connect();
    if (process.env.FACTORY_MULTILINGUAL_SCHEMA_MODE === "verify-only") {
      await client.query("BEGIN READ ONLY");
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '60s'");
        const requirements = [
          ["factory_categories","name_fr"],
          ["factory_bale_products","name_fr"],["factory_bale_products","description_fr"],
          ["factory_bales","product_name_fr"],["factory_bales","category_fr"],
          ["customer_proforma_lines","product_name_fr"],
          ["customer_order_lines","bale_name_fr"],
          ["customer_order_bales","bale_name_fr"],
          ["customer_order_bales_history","bale_name_fr"],
          ["customer_order_expected_lines","product_name_fr"]
        ];
        const optional = [
          ["factory_pos_sale_items","product_name_fr"],
          ["customer_order_bale_removals","product_name_fr"],
          ["factory_v3_load_bales","product_name_fr"],
          ["factory_invoice_loading_bales","product_name_fr"],
          ["customer_dispatch_bale_scans","product_name_fr"],
          ["bale_recode_items","product_name_fr"],
          ["bale_recode_items","product_id"]
        ];
        const columns=await client.query(`
          SELECT table_name,column_name FROM information_schema.columns
          WHERE table_schema='public'
        `);
        const available=new Set(columns.rows.map(row=>row.table_name+"."+row.column_name));
        const tables=new Set(columns.rows.map(row=>row.table_name));
        const missing=requirements.filter(([t,c])=>!available.has(t+"."+c));
        for (const [t,c] of optional) {
          if (tables.has(t)&&!available.has(t+"."+c)) missing.push([t,c]);
        }
        if (!tables.has("user_language_preferences")) missing.push(["user_language_preferences","table"]);
        if (missing.length) {
          throw new Error("Factory multilingual schema incomplete: "+missing.map(([t,c])=>t+"."+c).join(", "));
        }
        await client.query("ROLLBACK");
        console.log(JSON.stringify({module:"factory-trilingual-schema",mode:"verify-only",schemaVerified:true}));
        return;
      } catch(error) {
        await client.query("ROLLBACK").catch(()=>{});
        throw error;
      }
    }
    await client.query("SET statement_timeout = '90s'");
    await client.query(STARTUP_SCHEMA_LOCK_SQL);
    startupSchemaLockAcquired = true;
    await client.query("RESET statement_timeout");

    await runSchemaStatements(client, frenchSql, languagePreferenceSql);
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "INFO",
        message: "Factory multilingual schema and language preferences verified",
        module: "factory-trilingual-schema",
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        message: "Factory trilingual schema verification failed",
        module: "factory-trilingual-schema",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw error;
  } finally {
    if (startupSchemaLockAcquired) {
      await client.query(STARTUP_SCHEMA_UNLOCK_SQL).catch(() => {});
    }
    await client.end().catch(() => {});
  }
}

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = ensureFactoryTrilingualSchema();
}

await globalThis[INSTALL_KEY];
