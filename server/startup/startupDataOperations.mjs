/**
 * Data operations that run on every server start, after the read-only schema
 * gate has confirmed the database matches this release.
 *
 * These are business-data behaviours that used to live inside schema "bridges"
 * (server/*Bridge.mjs) alongside DDL. The DDL now lives in migrations/; the data
 * behaviour is preserved here unchanged. Nothing in this module may create,
 * alter or drop a database object.
 *
 *   1. grantBaselineSecurityPermissions  (was criticalSecuritySchemaBridge.mjs)
 *      Admin and Developer company roles always hold the six critical security
 *      permissions. Idempotent (ON CONFLICT DO NOTHING).
 *   2. keepAutomatedContainerTrackingDisabled  (was factoryContainerSchemaBridge.mjs)
 *      Automated carrier tracking is permanently disabled; legacy rows that
 *      still have it on are switched off. Idempotent.
 *   3. Wave 6 inventory valuation repair  (was inventoryValuationWave6RepairBridge.mjs)
 *      Disabled unless INVENTORY_VALUATION_WAVE6_REPAIR is configured; fail closed.
 */
import process from "node:process";
import pg from "pg";

import { resolveDatabaseSsl } from "../lib/databaseSsl.mjs";
import { runInventoryValuationWave6RepairOnce } from "./inventoryValuationGuardedRepair.mjs";

const RUN_KEY = Symbol.for("erp.startup-data-operations.ran");

export const BASELINE_SECURITY_PERMISSIONS = Object.freeze([
  "administration.repair",
  "security.permissions.manage",
  "security.anomalies.read",
  "factory.documents.download",
  "factory.raw-stock.repair",
  "files.download",
]);

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({ timestamp: new Date().toISOString(), level, message, module: "startup-data-operations", ...extra })
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

/** @param {{ query: Function }} client */
export async function grantBaselineSecurityPermissions(client) {
  const result = await client.query(
    `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
     SELECT ucr.user_id, ucr.company_id, permissions.permission_name, ucr.user_id
       FROM user_company_roles ucr
      CROSS JOIN unnest($1::text[]) AS permissions(permission_name)
      WHERE ucr.role IN ('Admin', 'Developer')
     ON CONFLICT (user_id, company_id, permission) DO NOTHING`,
    [BASELINE_SECURITY_PERMISSIONS]
  );
  return result.rowCount ?? 0;
}

/** @param {{ query: Function }} client */
export async function keepAutomatedContainerTrackingDisabled(client) {
  const result = await client.query(
    `UPDATE factory_containers
        SET tracking_enabled = false, tracking_auto_update = false
      WHERE tracking_enabled = true OR tracking_auto_update = true`
  );
  return result.rowCount ?? 0;
}

export async function runStartupDataOperations() {
  if (globalThis[RUN_KEY]) return;
  globalThis[RUN_KEY] = true;
  const connectionString = connectionStringFromEnvironment();
  if (!connectionString) {
    log("WARN", "Startup data operations skipped: no database configuration");
    return;
  }
  const client = new pg.Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 15_000,
    application_name: "erp-startup-data-operations",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const permissionsGranted = await grantBaselineSecurityPermissions(client);
    const containersUpdated = await keepAutomatedContainerTrackingDisabled(client);
    await client.query("COMMIT");
    log("INFO", "Startup data operations completed", { permissionsGranted, containersUpdated });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    log("ERROR", "Startup data operations failed; aborting startup", {
      errorCode: error?.code,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
  await runInventoryValuationWave6RepairOnce();
}
