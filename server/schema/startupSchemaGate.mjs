/**
 * Read-only startup schema gate.
 *
 * Loaded by server/startupPreload.mjs before anything else touches the
 * database. It verifies that the database is exactly at the migration level this
 * release was built for (see server/schema/verifyDatabaseSchema.mjs) and throws
 * otherwise, so a new deployment never serves requests against the wrong schema
 * and the previous healthy instance keeps running.
 *
 * It never creates, alters or repairs anything: its only statements are catalog
 * SELECTs and probes inside READ ONLY transactions that are rolled back. Schema
 * changes are made only by `npm run db:migrate` (or `npm run db:adopt` for a
 * legacy database), run explicitly before the new release starts.
 *
 * SCHEMA_STARTUP_VERIFY:
 *   full     (default) migration history + full catalog comparison + tenant probes
 *   history  migration history only; an emergency escape hatch if the catalog
 *            comparison misfires on an environment. It does not permit any DDL.
 */
import process from "node:process";
import pg from "pg";

import { resolveDatabaseSsl } from "../lib/databaseSsl.mjs";
import { verifyDatabaseSchema } from "./verifyDatabaseSchema.mjs";

const RUN_KEY = Symbol.for("erp.startup-schema-gate.verified");

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "schema-gate",
      action: "startup-verify",
      ...extra,
    })
  );
}

function connectionStringFromEnvironment() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
  if (PGHOST && PGUSER && PGPASSWORD && PGDATABASE) {
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT || "5432"}/${PGDATABASE}`;
  }
  return "";
}

export class DatabaseSchemaMismatchError extends Error {
  constructor(problems) {
    super(
      "Database schema does not match this release; refusing to start.\n  - " +
        problems.join("\n  - ") +
        "\nApply migrations explicitly with `npm run db:migrate` (see docs/database-migrations.md)."
    );
    this.name = "DatabaseSchemaMismatchError";
    this.problems = problems;
  }
}

export async function verifyStartupSchema({ connectionString = connectionStringFromEnvironment() } = {}) {
  const mode = process.env.SCHEMA_STARTUP_VERIFY ?? "full";
  if (mode !== "full" && mode !== "history") {
    throw new Error(`SCHEMA_STARTUP_VERIFY must be "full" or "history", got "${mode}"`);
  }
  if (!connectionString) {
    if (process.env.NODE_ENV === "production") throw new Error("Schema gate requires DATABASE_URL in production");
    log("WARN", "Schema gate skipped: no database configuration");
    return { ok: true, skipped: true };
  }
  const started = Date.now();
  const client = new pg.Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 15_000,
    application_name: "erp-schema-gate",
  });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '60s'");
    const full = mode === "full";
    const result = await verifyDatabaseSchema(client, { catalog: full, probes: full });
    if (!result.ok) {
      log("ERROR", "Database schema verification failed", {
        problems: result.problems.slice(0, 50),
        summary: result.summary,
      });
      throw new DatabaseSchemaMismatchError(result.problems);
    }
    log("INFO", "Database schema verified", { mode, ms: Date.now() - started, ...result.summary });
    return result;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runStartupSchemaGateOnce() {
  if (globalThis[RUN_KEY]) return;
  await verifyStartupSchema();
  globalThis[RUN_KEY] = true;
}
