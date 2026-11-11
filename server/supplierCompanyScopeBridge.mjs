import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Teach supertest's HTTP client to hand back XLSX responses as a Buffer instead
 * of mangling them as text. This exists purely for the test suite.
 *
 * It has to be optional, because `npm start` preloads this bridge in production
 * via --import, and superagent arrives only as a dependency of supertest — a
 * devDependency. A static import here made a production-only install fail to
 * boot with ERR_MODULE_NOT_FOUND before the process ever reached the migration
 * work this bridge is actually here to do.
 */
try {
  const { default: superagent } = await import("superagent");
  superagent.parse[XLSX_MIME] = (response, callback) => {
    const chunks = [];
    response.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on("end", () => callback(null, Buffer.concat(chunks)));
    response.on("error", (error) => callback(error));
  };
} catch {
  // superagent absent — a production install with no devDependencies. There is
  // no supertest to serve, so there is nothing to register.
}

const INSTALL_KEY = Symbol.for("erp.supplier-company-scope-migration.applied");

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;

  const { Pool } = pg;
  let connectionString;

  if (process.env.DATABASE_URL) {
    connectionString = process.env.DATABASE_URL;
  } else if (
    process.env.PGHOST &&
    process.env.PGPORT &&
    process.env.PGUSER &&
    process.env.PGPASSWORD &&
    process.env.PGDATABASE
  ) {
    const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
    connectionString = `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
  }

  if (!connectionString) {
    if (process.env.SUPPLIER_SCOPE_SCHEMA_MODE === "verify-only") {
      throw new Error("Supplier schema verify-only requires database configuration");
    }
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "WARN",
        message: "Supplier company-scope migration skipped because no database configuration is available",
        module: "supplier-company-scope-migration",
        action: "startup-ensure",
      })
    );
  } else if (process.env.SUPPLIER_SCOPE_SCHEMA_MODE === "verify-only") {
    const { Client } = pg;
    const client = new Client({
      connectionString,
      ssl: resolveDatabaseSsl(connectionString),
      connectionTimeoutMillis: 15_000,
    });
    try {
      await client.connect();
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const result = await client.query(`
        SELECT
          to_regclass('public.suppliers') IS NOT NULL AS table_ready,
          EXISTS(SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='suppliers' AND column_name='company_id' AND is_nullable='NO') AS company_id_ready,
          EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
            WHERE c.relname='suppliers_company_code_unique' AND i.indisunique AND i.indisvalid AND i.indisready) AS company_code_unique,
          EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            WHERE c.relname='suppliers' AND t.tgname='suppliers_assign_company_id'
              AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')) AS supplier_trigger_ready,
          EXISTS(SELECT 1 FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
            WHERE c.relname='suppliers' AND co.conname='suppliers_company_id_fkey') AS company_fk_ready
      `);
      const state = result.rows[0] || {};
      if (
        !state.table_ready ||
        !state.company_id_ready ||
        !state.company_code_unique ||
        !state.supplier_trigger_ready ||
        !state.company_fk_ready
      ) {
        throw new Error(
          "Supplier company scope schema incomplete; review legacy 20260728 migration before read-only cutover"
        );
      }
      await client.query("ROLLBACK");
      console.log(JSON.stringify({ module: "supplier-company-scope", mode: "verify-only", schemaVerified: true }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  } else {
    const migrationSql = await readFile(
      new URL("../migrations/20260728_001_supplier_company_scope.sql", import.meta.url),
      "utf8"
    );

    const pool = new Pool({
      connectionString,
      ssl: resolveDatabaseSsl(connectionString),
      max: 1,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
    });

    try {
      await pool.query(migrationSql);
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "INFO",
          message: "Supplier company-scope migration applied",
          module: "supplier-company-scope-migration",
        })
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "ERROR",
          message: "Supplier company-scope migration failed",
          module: "supplier-company-scope-migration",
          error: error instanceof Error ? error.message : String(error),
        })
      );
      throw error;
    } finally {
      await pool.end();
    }
  }
}
