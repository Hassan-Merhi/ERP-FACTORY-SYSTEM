import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  (process.env.PGHOST
    ? `postgresql://${encodeURIComponent(process.env.PGUSER || "")}:${encodeURIComponent(process.env.PGPASSWORD || "")}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE || ""}`
    : "");

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "critical-security-schema",
      action: "startup-ensure",
      ...extra,
    })
  );
}

async function ensureCriticalSecuritySchema() {
  if (!connectionString) {
    if (process.env.CRITICAL_SECURITY_SCHEMA_MODE === "verify-only") {
      throw new Error("Critical security schema verify-only requires a database connection");
    }
    log("WARN", "Critical security schema check skipped because no database configuration is available");
    return;
  }

  const client = new Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 8_000,
  });

  let tableCreated = false;
  const columnsAdded = [];
  const indexesCreated = [];

  try {
    await client.connect();
    const verifyOnly = process.env.CRITICAL_SECURITY_SCHEMA_MODE === "verify-only";
    await client.query(verifyOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '60s'");

    if (verifyOnly) {
      const check = await client.query(`
        SELECT
          to_regclass('public.user_security_permissions') IS NOT NULL AS table_ready,
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'user_security_permissions'
              AND column_name = ANY(ARRAY['id','user_id','company_id','permission','granted_by','created_at','updated_at'])) AS columns_ready,
          (SELECT count(*)::int FROM pg_index i
            JOIN pg_class idx ON idx.oid=i.indexrelid
            JOIN pg_namespace ns ON ns.oid=idx.relnamespace
            WHERE ns.nspname='public' AND idx.relname='user_security_permissions_unique'
              AND i.indisvalid AND i.indisready AND i.indisunique) AS unique_ready,
          (SELECT count(*)::int FROM pg_index i
            JOIN pg_class idx ON idx.oid=i.indexrelid
            JOIN pg_namespace ns ON ns.oid=idx.relnamespace
            WHERE ns.nspname='public' AND idx.relname='user_security_permissions_company_user_idx'
              AND i.indisvalid AND i.indisready) AS lookup_ready
      `);
      const state = check.rows[0] || {};
      if (
        state.table_ready !== true ||
        Number(state.columns_ready) !== 7 ||
        Number(state.unique_ready) !== 1 ||
        Number(state.lookup_ready) !== 1
      ) {
        throw new Error("Critical security permissions schema incomplete; apply reviewed controlled migration first");
      }
      await client.query("ROLLBACK");
      log("INFO", "Critical security permissions schema verified (read-only; no role grants or cleanup)");
      return;
    }

    const tableLookup = await client.query(`SELECT to_regclass('public.user_security_permissions') AS table_name`);

    if (!tableLookup.rows[0]?.table_name) {
      await client.query(`
        CREATE TABLE user_security_permissions (
          id serial PRIMARY KEY NOT NULL,
          user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          company_id integer NOT NULL,
          permission text NOT NULL,
          granted_by varchar REFERENCES users(id) ON DELETE SET NULL,
          created_at timestamp DEFAULT now() NOT NULL,
          updated_at timestamp DEFAULT now() NOT NULL
        )
      `);
      tableCreated = true;
    } else {
      const columnResult = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'user_security_permissions'
      `);
      const existingColumns = new Set(columnResult.rows.map((row) => row.column_name));
      const requiredColumns = [
        ["id", "serial"],
        ["user_id", "varchar"],
        ["company_id", "integer"],
        ["permission", "text"],
        ["granted_by", "varchar"],
        ["created_at", "timestamp DEFAULT now()"],
        ["updated_at", "timestamp DEFAULT now()"],
      ];

      for (const [columnName, definition] of requiredColumns) {
        if (existingColumns.has(columnName)) continue;
        await client.query(`ALTER TABLE user_security_permissions ADD COLUMN ${columnName} ${definition}`);
        columnsAdded.push(columnName);
      }
    }

    const indexResult = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'user_security_permissions'
    `);
    const existingIndexes = new Set(indexResult.rows.map((row) => row.indexname));

    if (!existingIndexes.has("user_security_permissions_unique")) {
      await client.query(`
        DELETE FROM user_security_permissions
        WHERE user_id IS NULL OR company_id IS NULL OR permission IS NULL
      `);
      await client.query(`
        DELETE FROM user_security_permissions duplicate
        USING user_security_permissions canonical
        WHERE duplicate.id > canonical.id
          AND duplicate.user_id = canonical.user_id
          AND duplicate.company_id = canonical.company_id
          AND duplicate.permission = canonical.permission
      `);
      await client.query(`
        CREATE UNIQUE INDEX user_security_permissions_unique
        ON user_security_permissions (user_id, company_id, permission)
      `);
      indexesCreated.push("user_security_permissions_unique");
    }

    if (!existingIndexes.has("user_security_permissions_company_user_idx")) {
      await client.query(`
        CREATE INDEX user_security_permissions_company_user_idx
        ON user_security_permissions (company_id, user_id)
      `);
      indexesCreated.push("user_security_permissions_company_user_idx");
    }

    const permissions = [
      "administration.repair",
      "security.permissions.manage",
      "security.anomalies.read",
      "factory.documents.download",
      "factory.raw-stock.repair",
      "files.download",
    ];

    await client.query(
      `
        INSERT INTO user_security_permissions
          (user_id, company_id, permission, granted_by)
        SELECT
          ucr.user_id,
          ucr.company_id,
          permissions.permission_name,
          ucr.user_id
        FROM user_company_roles ucr
        CROSS JOIN unnest($1::text[]) AS permissions(permission_name)
        WHERE ucr.role IN ('Admin', 'Developer')
        ON CONFLICT (user_id, company_id, permission) DO NOTHING
      `,
      [permissions]
    );

    const verification = await client.query(`
      SELECT
        COUNT(*)::integer AS total_permissions,
        COUNT(*) FILTER (WHERE permission = 'factory.raw-stock.repair')::integer AS raw_stock_repair_permissions
      FROM user_security_permissions
    `);

    await client.query("COMMIT");

    log("INFO", "Critical security permissions schema verified", {
      tableCreated,
      columnsAdded,
      indexesCreated,
      totalPermissions: verification.rows[0]?.total_permissions ?? 0,
      rawStockRepairPermissions: verification.rows[0]?.raw_stock_repair_permissions ?? 0,
      startupMigrationsEnabled: process.env.RUN_STARTUP_MIGRATIONS !== "false",
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    log("ERROR", "Critical security schema verification failed; aborting startup", {
      errorCode: error?.code,
      errorMessage: error?.message || String(error),
    });
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

await ensureCriticalSecuritySchema();
