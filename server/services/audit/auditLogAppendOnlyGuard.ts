import type { Pool } from "pg";

import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  AUDIT_LOG_MAINTENANCE_SETTING,
  AUDIT_LOG_RETENTION_MODE,
  FINANCIAL_AUDIT_TABLE_PREFIXES,
  FINANCIAL_AUDIT_TABLES,
} from "./auditLogRetentionPolicy";

/**
 * Wave 12 (audit trail, owner decision 3): audit_log is append-only.
 *
 *   - A BEFORE UPDATE OR DELETE row trigger refuses every change to an
 *     existing audit row. The single exception is a DELETE made while the
 *     transaction-local setting app.audit_log_maintenance is 'retention' (set
 *     only by the scheduled retention job, auditLogRetention.ts) of a row whose
 *     table_name is not financial (auditLogRetentionPolicy.ts). UPDATE is never
 *     allowed.
 *   - A BEFORE TRUNCATE statement trigger refuses TRUNCATE.
 *
 * Installed on every boot, like the other ledger guards, because production
 * runs with RUN_STARTUP_MIGRATIONS=false. Idempotent and versioned: a database
 * already at AUDIT_LOG_APPEND_ONLY_VERSION with both triggers present is left
 * alone. A failure is fatal: serving writes without the guard would let the
 * audit trail be rewritten.
 *
 * Test cleanup that has to remove its own audit rows runs as the database
 * superuser with `SET LOCAL session_replication_role = replica` (see
 * tests/helpers/auditLogCleanup.ts): a superuser can drop the trigger anyway,
 * so that is not a bypass the application role has.
 */
function sqlTextArray(values: readonly string[]): string {
  const quoted = values.map((value) => `'${value.toLowerCase().replace(/'/g, "''")}'`);
  return `ARRAY[${quoted.join(", ")}]::text[]`;
}

export const AUDIT_LOG_APPEND_ONLY_DDL: readonly string[] = [
  // audit_log outlives the company it describes: an empty company's deletion
  // keeps its audit rows (wave 12 decision 4), and append-only rows cannot be
  // cleared first, so audit_log carries no foreign key to companies.
  `ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_company_id_fkey`,
  `CREATE OR REPLACE FUNCTION erp_audit_log_is_financial(audit_table text) RETURNS boolean
   LANGUAGE sql IMMUTABLE AS $fn$
     SELECT lower(btrim(COALESCE(audit_table, ''))) = ANY (${sqlTextArray(FINANCIAL_AUDIT_TABLES)})
         OR EXISTS (
              SELECT 1 FROM unnest(${sqlTextArray(FINANCIAL_AUDIT_TABLE_PREFIXES)}) AS financial(prefix)
               WHERE left(lower(btrim(COALESCE(audit_table, ''))), length(financial.prefix)) = financial.prefix
            )
   $fn$`,
  `CREATE OR REPLACE FUNCTION erp_audit_log_append_only() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   BEGIN
     IF TG_OP = 'DELETE'
        AND COALESCE(lower(btrim(current_setting('${AUDIT_LOG_MAINTENANCE_SETTING}', true))), '') = '${AUDIT_LOG_RETENTION_MODE}'
        AND NOT erp_audit_log_is_financial(OLD.table_name)
     THEN
       RETURN OLD;
     END IF;
     RAISE EXCEPTION USING ERRCODE = '42501',
       MESSAGE = format('AUDIT_LOG_APPEND_ONLY: audit_log row %s (%s) cannot be %s; the audit trail is append-only',
                        OLD.id, OLD.table_name, CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE 'changed' END);
   END
   $fn$`,
  `CREATE OR REPLACE FUNCTION erp_audit_log_no_truncate() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   BEGIN
     RAISE EXCEPTION USING ERRCODE = '42501',
       MESSAGE = 'AUDIT_LOG_APPEND_ONLY: audit_log cannot be truncated; the audit trail is append-only';
   END
   $fn$`,
  `DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log`,
  `CREATE TRIGGER audit_log_append_only
     BEFORE UPDATE OR DELETE ON audit_log
     FOR EACH ROW EXECUTE FUNCTION erp_audit_log_append_only()`,
  `DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log`,
  `CREATE TRIGGER audit_log_no_truncate
     BEFORE TRUNCATE ON audit_log
     FOR EACH STATEMENT EXECUTE FUNCTION erp_audit_log_no_truncate()`,
];

/** Version of AUDIT_LOG_APPEND_ONLY_DDL (and of the financial table list). Bump it whenever either changes. */
export const AUDIT_LOG_APPEND_ONLY_VERSION = "2026-10-audit-log-append-only-v2";

const INSTALL_LOCK_KEY = 2026_10_120;

/** Trigger names the accounting integrity diagnostic checks for. */
export const AUDIT_LOG_GUARD_TRIGGERS = ["audit_log_append_only", "audit_log_no_truncate"] as const;

async function installedVersion(client: { query: Pool["query"] }): Promise<string | null> {
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(to_regprocedure('erp_audit_log_append_only()'), 'pg_proc') AS version
      WHERE EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_append_only' AND NOT tgisinternal)
        AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_no_truncate' AND NOT tgisinternal)
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_company_id_fkey')`
  );
  return result.rows[0]?.version ?? null;
}

/** Installs the guard; throws when it cannot (boot stops, the previous deployment stays live). */
export async function ensureAuditLogAppendOnlyGuard(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    if ((await installedVersion(client)) === AUDIT_LOG_APPEND_ONLY_VERSION) {
      logger.info("[startup] ✓ audit_log append-only guard already installed");
      return;
    }
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
    await client.query("SET LOCAL lock_timeout = '10s'");
    for (const statement of AUDIT_LOG_APPEND_ONLY_DDL) {
      await client.query(statement);
    }
    await client.query(`COMMENT ON FUNCTION erp_audit_log_append_only() IS '${AUDIT_LOG_APPEND_ONLY_VERSION}'`);
    await client.query("COMMIT");
    logger.info("[startup] ✓ audit_log append-only guard ensured");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("[startup] ✗ audit_log append-only guard could not be installed", {
      error: getErrorMessage(error),
    });
    throw error;
  } finally {
    client.release();
  }
}
