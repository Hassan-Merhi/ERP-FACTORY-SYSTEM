/**
 * Idempotent startup compatibility bridge for the Fixed Production Planner.
 * The SQL is also registered in the versioned migration registry, but
 * production currently does not execute that registry on deploy.
 *
 * This bridge creates only the new, isolated company-scoped planner table.
 * It never updates raw materials, containers, costing, or ledger records.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const KEY = Symbol.for("erp.fixed-production-planner-schema.applied");

export async function ensureFixedProductionPlannerSchema() {
  const connectionString =
    process.env.DATABASE_URL ||
    (process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE
      ? `postgresql://${encodeURIComponent(process.env.PGUSER)}:${encodeURIComponent(process.env.PGPASSWORD)}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE}`
      : "");
  if (!connectionString) {
    console.warn("[fixed-production-planner] Schema check skipped: no database configuration");
    return;
  }

  const client = new pg.Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 12_000,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const verifyOnly = process.env.FIXED_PRODUCTION_PLANNER_SCHEMA_MODE === "verify-only";
    // Verify-only cutover is explicit: the controlled migration must have been
    // applied independently before this setting is enabled. No DDL is allowed.
    const ddl = verifyOnly
      ? null
      : await readFile(
          new URL("../migrations/20261015_001_factory_fixed_production_planner.sql", import.meta.url),
          "utf8"
        );

    // Reuse the startup schema advisory lock that protects other schema bridges.
    if (!verifyOnly) {
      await client.query("SELECT pg_advisory_lock(hashtext('erp.startup'), hashtext('factory-schema'))");
    }
    try {
      await client.query(verifyOnly ? "BEGIN READ ONLY" : "BEGIN");
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      if (ddl) await client.query(ddl);
      const check = await client.query(`
        SELECT
          to_regclass('public.factory_fixed_production_plans') IS NOT NULL AS table_ready,
          (SELECT count(*)::int FROM information_schema.columns
           WHERE table_schema='public' AND table_name='factory_fixed_production_plans'
             AND column_name = ANY(ARRAY['company_id','allocations_20t','is_locked','revision','updated_by','updated_at']))
            AS column_count,
          (SELECT count(*)::int FROM pg_constraint
           WHERE conrelid = to_regclass('public.factory_fixed_production_plans')
             AND conname IN ('factory_fixed_production_plans_pkey','factory_fixed_production_allocations_object'))
            AS constraint_count
      `);
      const state = check.rows[0] || {};
      if (state.table_ready !== true || Number(state.column_count) !== 6 || Number(state.constraint_count) !== 2) {
        throw new Error(
          "Fixed Production Planner schema incomplete; apply controlled migration before enabling verify-only"
        );
      }
      if (verifyOnly) await client.query("ROLLBACK");
      else await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (!verifyOnly) {
        await client
          .query("SELECT pg_advisory_unlock(hashtext('erp.startup'), hashtext('factory-schema'))")
          .catch(() => {});
      }
    }
    console.log(
      "[fixed-production-planner] Schema verified" + (verifyOnly ? " (read-only)" : " (compatibility ensure)")
    );
  } catch (error) {
    console.error("[fixed-production-planner] Schema ensure failed; stopping startup", error);
    throw error;
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

if (!globalThis[KEY]) {
  globalThis[KEY] = ensureFixedProductionPlannerSchema();
}
await globalThis[KEY];
