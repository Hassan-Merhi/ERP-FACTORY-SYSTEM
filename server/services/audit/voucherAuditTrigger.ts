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
 * The functions, triggers and actor columns are defined by the schema
 * migrations (migrations/); nothing is installed at runtime. Rows written
 * before the triggers existed have no hash (counted as `unhashed`). The
 * functions read the request settings named by auditActorContext's
 * AUDIT_ACTOR_SETTINGS (pinned by tests/audit-trigger.test.ts).
 */
/** Expected version: the comment on erp_ledger_row_audit(), read by the integrity diagnostic. */
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
