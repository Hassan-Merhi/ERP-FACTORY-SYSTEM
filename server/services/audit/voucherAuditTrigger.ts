import type { Pool } from "pg";

import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { AUDIT_ACTOR_SETTINGS, UNKNOWN_AUDIT_ACTOR } from "./auditActorContext";

/**
 * Phase 21 (A): the database audits every voucher and line write, and every
 * audit_log row is hashed into a chain.
 *
 * AT2 (owner decision: a database trigger). AFTER INSERT / UPDATE / DELETE
 * statement triggers on `vouchers` and `voucher_entries` (transition tables,
 * one set-based INSERT per statement, so a 500-line import is one extra
 * statement, not 500 function calls) write one audit_log row per changed row:
 *   action       row_insert | row_update | row_delete
 *   table_name   vouchers | voucher_entries
 *   record_id    the row id; record_identifier the voucher number (header) or
 *                `voucher:{id}` (line)
 *   company_id   the row's company
 *   changes      {"source":"db_trigger","row":{"old":…,"new":…}} — the whole
 *                row before and after (jsonb); an UPDATE that changes nothing
 *                writes no row
 *   user_id      app.current_actor (the signed-in user, or `system:<job>`);
 *                'unknown' when the setting is empty — recorded, never refused,
 *                and counted by the integrity diagnostic (audit_actor_unknown)
 *   username     app.current_actor_name (else the actor id)
 * The application audit rows (logAudit / writeAuditEvent, action create /
 * update / delete with the readable summary) are kept as they are: the two do
 * not duplicate each other's action names, so readers that count application
 * rows (`action = 'delete'`) are unaffected.
 *
 * AT3. A BEFORE INSERT / UPDATE row trigger on `vouchers` keeps the actor
 * columns: created_by (set on insert from the actor setting, never changed
 * after), updated_by (the actor of the last change that changed the row),
 * deleted_by (the actor that set deleted_at; cleared on restore) and
 * original_voucher_number (the number before a retirement renamed it
 * `{number}~DEL{id}`; kept once set). Existing vouchers keep NULL in all four
 * (decided by default: no backfill — NULL means "before tracking"; the
 * application audit rows still name who created most of them).
 *
 * AT5 / AT6. A BEFORE INSERT row trigger on audit_log fills request_id, ip,
 * session_id (sha256 of the session id) and reason from the request settings
 * when the insert left them empty, then hashes the row:
 *   row_hash = sha256 of the row's content and prev_hash;
 *   prev_hash = row_hash of the latest chained row with a lower id ('genesis'
 *     for the first), for every row the retention job may not prune; rows on
 *     the prunable allow-list are hashed but not chained (they may be pruned).
 * No lock is taken (decided by default): a global lock held to commit would
 * serialise every posting and add deadlocks. Under concurrent commits two rows
 * may name the same predecessor (a fork); verifyAuditLogChain checks every
 * row's hash and every link, so an edited row or a deleted linked row is
 * found, and reports rows no later row links to.
 *
 * Installed on every boot after the append-only guard, versioned and
 * idempotent; fatal on failure. Rows written before the install have no hash
 * (counted as `unhashed`), and nothing is rewritten.
 */
export const VOUCHER_AUDIT_TRIGGER_VERSION = "2026-10-audit-trail-v1";

/** [table, trigger] pairs the integrity diagnostic requires present and enabled. */
export const AUDIT_TRAIL_TRIGGERS: ReadonlyArray<readonly [table: string, trigger: string]> = [
  ["vouchers", "vouchers_audit_actor_columns"],
  ["vouchers", "vouchers_audit_row_insert"],
  ["vouchers", "vouchers_audit_row_update"],
  ["vouchers", "vouchers_audit_row_delete"],
  ["voucher_entries", "voucher_entries_audit_row_insert"],
  ["voucher_entries", "voucher_entries_audit_row_update"],
  ["voucher_entries", "voucher_entries_audit_row_delete"],
  ["audit_log", "audit_log_before_insert_chain"],
  ["audit_log", "audit_log_append_only"],
  ["audit_log", "audit_log_no_truncate"],
];

export const AUDIT_CHAIN_GENESIS = "genesis";
export const ROW_AUDIT_ACTIONS = ["row_insert", "row_update", "row_delete"] as const;

const INSTALL_LOCK_KEY = 2026_10_210;
const LOCK_TIMEOUT = "10s";

const setting = (name: string) => `NULLIF(btrim(current_setting('${name}', true)), '')`;

function rowAuditTriggers(table: string): string[] {
  return (["INSERT", "UPDATE", "DELETE"] as const).flatMap((op) => {
    const name = `${table}_audit_row_${op.toLowerCase()}`;
    const referencing =
      op === "INSERT"
        ? "REFERENCING NEW TABLE AS audit_new"
        : op === "DELETE"
          ? "REFERENCING OLD TABLE AS audit_old"
          : "REFERENCING OLD TABLE AS audit_old NEW TABLE AS audit_new";
    return [
      `DROP TRIGGER IF EXISTS ${name} ON ${table}`,
      `CREATE TRIGGER ${name} AFTER ${op} ON ${table} ${referencing}
         FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_row_audit()`,
    ];
  });
}

export const VOUCHER_AUDIT_TRIGGER_DDL: readonly string[] = [
  // AT3: actor columns and the original number (catalogue-only adds, no rewrite).
  `ALTER TABLE vouchers
     ADD COLUMN IF NOT EXISTS created_by TEXT,
     ADD COLUMN IF NOT EXISTS updated_by TEXT,
     ADD COLUMN IF NOT EXISTS deleted_by TEXT,
     ADD COLUMN IF NOT EXISTS original_voucher_number VARCHAR(100)`,
  // AT5 / AT6: request metadata and the hash chain.
  `ALTER TABLE audit_log
     ADD COLUMN IF NOT EXISTS request_id TEXT,
     ADD COLUMN IF NOT EXISTS ip TEXT,
     ADD COLUMN IF NOT EXISTS session_id TEXT,
     ADD COLUMN IF NOT EXISTS reason TEXT,
     ADD COLUMN IF NOT EXISTS prev_hash TEXT,
     ADD COLUMN IF NOT EXISTS row_hash TEXT`,
  // The predecessor lookup is a backward scan of this partial index.
  `CREATE INDEX IF NOT EXISTS audit_log_chain_idx ON audit_log (id) WHERE prev_hash IS NOT NULL`,
  `CREATE OR REPLACE FUNCTION erp_audit_current_actor() RETURNS text
   LANGUAGE sql STABLE AS $fn$
     SELECT COALESCE(${setting(AUDIT_ACTOR_SETTINGS.actorId)}, '${UNKNOWN_AUDIT_ACTOR}')
   $fn$`,
  `CREATE OR REPLACE FUNCTION erp_vouchers_actor_columns() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   DECLARE
     v_actor text := erp_audit_current_actor();
   BEGIN
     IF TG_OP = 'INSERT' THEN
       IF v_actor <> '${UNKNOWN_AUDIT_ACTOR}' OR NULLIF(btrim(COALESCE(NEW.created_by, '')), '') IS NULL THEN
         NEW.created_by := v_actor;
       END IF;
       NEW.updated_by := NULL;
       NEW.deleted_by := CASE WHEN NEW.deleted_at IS NOT NULL THEN v_actor END;
       NEW.original_voucher_number := NULL;
       RETURN NEW;
     END IF;
     NEW.created_by := OLD.created_by;
     NEW.updated_by := OLD.updated_by;
     IF NEW.deleted_at IS NULL THEN
       NEW.deleted_by := NULL;
     ELSIF OLD.deleted_at IS NULL THEN
       NEW.deleted_by := v_actor;
     ELSE
       NEW.deleted_by := OLD.deleted_by;
     END IF;
     IF OLD.original_voucher_number IS NOT NULL THEN
       NEW.original_voucher_number := OLD.original_voucher_number;
     ELSIF NEW.voucher_number ~ '~DEL[0-9]+$' AND OLD.voucher_number !~ '~DEL[0-9]+$' THEN
       NEW.original_voucher_number := OLD.voucher_number;
     ELSE
       NEW.original_voucher_number := NULL;
     END IF;
     IF NEW IS DISTINCT FROM OLD THEN
       NEW.updated_by := v_actor;
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DROP TRIGGER IF EXISTS vouchers_audit_actor_columns ON vouchers`,
  `CREATE TRIGGER vouchers_audit_actor_columns BEFORE INSERT OR UPDATE ON vouchers
     FOR EACH ROW EXECUTE FUNCTION erp_vouchers_actor_columns()`,
  `CREATE OR REPLACE FUNCTION erp_ledger_row_audit() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   DECLARE
     v_actor text := erp_audit_current_actor();
     v_name text := COALESCE(${setting(AUDIT_ACTOR_SETTINGS.actorName)}, erp_audit_current_actor());
   BEGIN
     IF TG_OP = 'INSERT' THEN
       INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, changes)
       SELECT v_actor, v_name, (img->>'company_id')::integer, 'row_insert', TG_TABLE_NAME, (img->>'id')::integer,
              COALESCE(img->>'voucher_number', 'voucher:' || (img->>'voucher_id')),
              jsonb_build_object('source', 'db_trigger', 'row', jsonb_build_object('new', img))
         FROM (SELECT to_jsonb(n) AS img FROM audit_new n) AS rows;
     ELSIF TG_OP = 'UPDATE' THEN
       INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, changes)
       SELECT v_actor, v_name, (after->>'company_id')::integer, 'row_update', TG_TABLE_NAME, (after->>'id')::integer,
              COALESCE(after->>'voucher_number', 'voucher:' || (after->>'voucher_id')),
              jsonb_build_object('source', 'db_trigger', 'row', jsonb_build_object('old', before, 'new', after))
         FROM (SELECT to_jsonb(o) AS before, to_jsonb(n) AS after
                 FROM audit_old o JOIN audit_new n ON n.id = o.id) AS rows
        WHERE before IS DISTINCT FROM after;
     ELSE
       INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, changes)
       SELECT v_actor, v_name, (img->>'company_id')::integer, 'row_delete', TG_TABLE_NAME, (img->>'id')::integer,
              COALESCE(img->>'voucher_number', 'voucher:' || (img->>'voucher_id')),
              jsonb_build_object('source', 'db_trigger', 'row', jsonb_build_object('old', img))
         FROM (SELECT to_jsonb(o) AS img FROM audit_old o) AS rows;
     END IF;
     RETURN NULL;
   END
   $fn$`,
  ...rowAuditTriggers("vouchers"),
  ...rowAuditTriggers("voucher_entries"),
  // The content a row hash covers (every column but row_hash itself).
  `CREATE OR REPLACE FUNCTION erp_audit_log_row_hash(r audit_log) RETURNS text
   LANGUAGE sql STABLE AS $fn$
     SELECT encode(sha256(convert_to(jsonb_build_array(
              r.id, r.user_id, r.username, r.company_id, r.action, r.table_name, r.record_id,
              r.record_identifier, r.changes, to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US'),
              r.request_id, r.ip, r.session_id, r.reason, r.prev_hash)::text, 'UTF8')), 'hex')
   $fn$`,
  `CREATE OR REPLACE FUNCTION erp_audit_log_before_insert() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   DECLARE
     v_prev text;
   BEGIN
     NEW.request_id := COALESCE(NEW.request_id, ${setting(AUDIT_ACTOR_SETTINGS.requestId)});
     NEW.ip := COALESCE(NEW.ip, ${setting(AUDIT_ACTOR_SETTINGS.ip)});
     NEW.session_id := COALESCE(NEW.session_id, ${setting(AUDIT_ACTOR_SETTINGS.sessionHash)});
     NEW.reason := COALESCE(NEW.reason, ${setting(AUDIT_ACTOR_SETTINGS.reason)});
     NEW.prev_hash := NULL;
     IF erp_audit_log_is_financial(NEW.table_name) THEN
       SELECT a.row_hash INTO v_prev FROM audit_log a
        WHERE a.prev_hash IS NOT NULL AND a.id < NEW.id
        ORDER BY a.id DESC LIMIT 1;
       NEW.prev_hash := COALESCE(v_prev, '${AUDIT_CHAIN_GENESIS}');
     END IF;
     NEW.row_hash := erp_audit_log_row_hash(NEW);
     RETURN NEW;
   END
   $fn$`,
  `DROP TRIGGER IF EXISTS audit_log_before_insert_chain ON audit_log`,
  `CREATE TRIGGER audit_log_before_insert_chain BEFORE INSERT ON audit_log
     FOR EACH ROW EXECUTE FUNCTION erp_audit_log_before_insert()`,
];

async function installedVersion(client: { query: Pool["query"] }): Promise<string | null> {
  const names = AUDIT_TRAIL_TRIGGERS.map(([, trigger]) => trigger);
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(to_regprocedure('erp_ledger_row_audit()'), 'pg_proc') AS version
      WHERE (SELECT count(DISTINCT tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[])) = $2`,
    [names, new Set(names).size]
  );
  return result.rows[0]?.version ?? null;
}

/** Installs the audit trail triggers; throws when it cannot (boot stops, the previous deployment stays live). */
export async function ensureVoucherAuditTrigger(pool: Pick<Pool, "connect">): Promise<void> {
  const client = await pool.connect();
  try {
    if ((await installedVersion(client)) === VOUCHER_AUDIT_TRIGGER_VERSION) {
      logger.info(`[startup] ✓ Audit trail triggers already installed (${VOUCHER_AUDIT_TRIGGER_VERSION})`);
      return;
    }
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
    for (const statement of VOUCHER_AUDIT_TRIGGER_DDL) {
      await client.query(statement);
    }
    await client.query(`COMMENT ON FUNCTION erp_ledger_row_audit() IS '${VOUCHER_AUDIT_TRIGGER_VERSION}'`);
    await client.query("COMMIT");
    logger.info(`[startup] ✓ Audit trail triggers ensured (${VOUCHER_AUDIT_TRIGGER_VERSION})`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("[startup] ✗ Audit trail triggers could not be installed; refusing to start", {
      version: VOUCHER_AUDIT_TRIGGER_VERSION,
      error: getErrorMessage(error),
    });
    throw error;
  } finally {
    client.release();
  }
}
