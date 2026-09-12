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
