import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;
const REPAIR_FLAG = "RUN_WAVE3_INDEX_REPAIR";
const REPAIR_LOCK_SQL = "SELECT pg_advisory_lock(20260907, 3)";
const REPAIR_UNLOCK_SQL = "SELECT pg_advisory_unlock(20260907, 3)";
const REQUIRED_INDEXES = [
  {
    name: "sales_items_voucher_idx",
    statement: "CREATE INDEX CONCURRENTLY IF NOT EXISTS sales_items_voucher_idx ON sales_items (voucher_id)",
    definition: "CREATE INDEX sales_items_voucher_idx ON public.sales_items USING btree (voucher_id)",
  },
  {
    name: "sales_items_stock_item_voucher_idx",
    statement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS sales_items_stock_item_voucher_idx ON sales_items (stock_item_id, voucher_id)",
    definition:
      "CREATE INDEX sales_items_stock_item_voucher_idx ON public.sales_items USING btree (stock_item_id, voucher_id)",
  },
  {
    name: "voucher_entries_voucher_idx",
    statement: "CREATE INDEX CONCURRENTLY IF NOT EXISTS voucher_entries_voucher_idx ON voucher_entries (voucher_id)",
    definition: "CREATE INDEX voucher_entries_voucher_idx ON public.voucher_entries USING btree (voucher_id)",
  },
];

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "wave3-sales-hotpath-index-repair",
      action: "startup-ensure",
      ...extra,
    })
  );
}

async function readIndexState(client, indexName) {
  const result = await client.query(
    `SELECT
       i.indisvalid AS valid,
       i.indisready AS ready,
       pg_get_indexdef(i.indexrelid) AS definition
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_index i ON i.indexrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relname = $1`,
    [indexName]
  );
  return result.rows[0] ?? null;
}

function indexMatchesExpectedDefinition(state, expected) {
  return Boolean(state && state.valid === true && state.ready === true && state.definition === expected.definition);
}

async function ensureWave3SalesHotpathIndexes() {
  if (process.env.RUN_WAVE3_INDEX_REPAIR !== "true") return;

  const connectionString =
    process.env.DATABASE_URL ||
    (process.env.PGHOST
      ? `postgresql://${encodeURIComponent(process.env.PGUSER || "")}:${encodeURIComponent(process.env.PGPASSWORD || "")}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE || ""}`
      : "");

  if (!connectionString) {
    throw new Error(`${REPAIR_FLAG}=true but no database configuration is available`);
  }

  const client = new Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 8_000,
  });
  let connected = false;
  let repairLockHeld = false;

  try {
    await client.connect();
    connected = true;
    // CREATE/DROP INDEX CONCURRENTLY must run outside an explicit transaction.
    // Keep lock waits bounded while allowing the index scan enough time to finish.
    await client.query("SET lock_timeout = '30s'");
    await client.query("SET statement_timeout = '10min'");

    // The repair spans multiple concurrent-index statements and therefore cannot
    // be wrapped in a transaction. Serialize the whole sequence with a session
    // advisory lock so multiple fresh app instances cannot race through the same
    // invalid/intermediate index catalog state during a deployment.
    await client.query(REPAIR_LOCK_SQL);
    repairLockHeld = true;

    for (const expected of REQUIRED_INDEXES) {
      const existing = await readIndexState(client, expected.name);
      if (existing && !indexMatchesExpectedDefinition(existing, expected)) {
        log("WARN", "Removing invalid or mismatched Wave 3 index before retry", {
          indexName: expected.name,
          existingDefinition: existing.definition,
          expectedDefinition: expected.definition,
          valid: existing.valid,
          ready: existing.ready,
        });
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${expected.name}`);
      }

      log("INFO", "Ensuring Wave 3 sales hot-path index", { indexName: expected.name });
      await client.query(expected.statement);
    }

    await client.query("ANALYZE sales_items");
    await client.query("ANALYZE voucher_entries");

    const verified = [];
    for (const expected of REQUIRED_INDEXES) {
      const state = await readIndexState(client, expected.name);
      if (!indexMatchesExpectedDefinition(state, expected)) {
        throw new Error(`Wave 3 index verification failed for ${expected.name}`);
      }
      verified.push(expected.name);
    }

    log("INFO", "Wave 3 sales hot-path index repair complete", {
      indexesVerified: verified.sort(),
    });
  } catch (error) {
    log("ERROR", "Wave 3 sales hot-path index repair failed; aborting startup", {
      errorCode: error?.code,
      errorMessage: error?.message || String(error),
    });
    throw error;
  } finally {
    if (repairLockHeld) {
      await client.query(REPAIR_UNLOCK_SQL).catch((error) => {
        log("WARN", "Failed to explicitly release Wave 3 index repair advisory lock", {
          errorCode: error?.code,
          errorMessage: error?.message || String(error),
        });
      });
    }
    if (connected) await client.end().catch(() => {});
  }
}

await ensureWave3SalesHotpathIndexes();

export {
  REPAIR_FLAG,
  REQUIRED_INDEXES,
  ensureWave3SalesHotpathIndexes,
  indexMatchesExpectedDefinition,
  readIndexState,
};
