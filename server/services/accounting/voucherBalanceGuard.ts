import type { Pool } from "pg";

import { logger } from "../../lib/logger";
import { getErrorMessage } from "../../lib/httpHandlers";

/**
 * Voucher balance guard (2026-10 accounting audit, waves 8.5, 9 and 12).
 *
 * A deferred constraint trigger: at COMMIT, an active (not deleted, not
 * optional) voucher must have debits equal to credits, so a writer may add
 * lines one by one inside its transaction and fails only if it leaves the
 * voucher unbalanced.
 *
 * v3 (wave 12, owner decision 1):
 *   - History is marked once, at the first v3 install, by an immutable column
 *     `vouchers.balance_guard_exempt_history`: it is added with DEFAULT true
 *     (every existing row is history, a catalogue-only change that rewrites
 *     nothing and fires no trigger), then its default becomes false. A trigger
 *     forces it to false on every insert and refuses any change to it, so no
 *     application path, bypass setting or imported `created_at` can make a
 *     voucher history. History vouchers are never checked and stay editable;
 *     the integrity diagnostic keeps reporting them. `created_at` is no longer
 *     read.
 *   - The stock adjustment types (Stock Adjustment, Production, Consumption,
 *     Mixed) are exempt only when the voucher has stock_adjustment_items rows
 *     (through stock_adjustment_vouchers) AND all its lines are on one side,
 *     before the company's perpetual-inventory cut-over or in a supplier-partner
 *     company (the stock sub-ledger carries the contra under periodic
 *     inventory). A two-sided stock voucher must balance. From a
 *     non-supplier-partner company's cut-over a stock voucher carries its
 *     inventory line and must balance, as in v2. Only the stock adjustment
 *     writers create these types (the generic voucher routes refuse them).
 *   - The base columns (debit_amount / credit_amount, USD) are always checked,
 *     rounded to cents. When every line shares one transaction currency the
 *     transaction columns must balance to the cent too, and the base columns may
 *     then differ by one cent at most (per-line conversion rounding).
 *   - Re-activating, re-dating, moving or re-typing a voucher is checked (the
 *     vouchers trigger fires on optional, deleted_at, voucher_date, company_id,
 *     voucher_type and created_at); removing a voucher's stock adjustment rows
 *     re-checks it as well.
 *
 * A reviewed repair can `SET LOCAL app.ledger_integrity_bypass = 'on'` for its
 * own transaction; the bypass skips the balance check, never the history marker.
 */

/** The immutable history marker column. */
export const VOUCHER_HISTORY_MARKER_COLUMN = "balance_guard_exempt_history";

/** Version of VOUCHER_BALANCE_GUARD_DDL. Bump it whenever a statement changes. */
export const VOUCHER_BALANCE_GUARD_VERSION = "2026-10-voucher-balance-v3";

/** Every trigger the guard installs, as `[table, trigger]`. */
export const VOUCHER_BALANCE_GUARD_TRIGGERS: ReadonlyArray<readonly [table: string, trigger: string]> = [
  ["voucher_entries", "voucher_entries_balance_guard"],
  ["vouchers", "vouchers_balance_guard"],
  ["vouchers", "vouchers_balance_guard_history_marker"],
  ["stock_adjustment_vouchers", "stock_adjustment_vouchers_balance_guard"],
  ["stock_adjustment_items", "stock_adjustment_items_balance_guard"],
];

export const VOUCHER_BALANCE_GUARD_DDL: readonly string[] = [
  // History marker: added once. ADD COLUMN with a constant default marks every
  // existing row without rewriting the table; new rows then default to false.
  `DO $marker$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'vouchers'
          AND column_name = '${VOUCHER_HISTORY_MARKER_COLUMN}'
     ) THEN
       ALTER TABLE vouchers ADD COLUMN ${VOUCHER_HISTORY_MARKER_COLUMN} boolean NOT NULL DEFAULT true;
       ALTER TABLE vouchers ALTER COLUMN ${VOUCHER_HISTORY_MARKER_COLUMN} SET DEFAULT false;
     END IF;
   END $marker$`,
  `CREATE OR REPLACE FUNCTION erp_vouchers_history_marker_guard() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   BEGIN
     IF TG_OP = 'INSERT' THEN
       -- A new voucher is never history, whatever the writer (or an import) sends.
       NEW.${VOUCHER_HISTORY_MARKER_COLUMN} := false;
     ELSIF NEW.${VOUCHER_HISTORY_MARKER_COLUMN} IS DISTINCT FROM OLD.${VOUCHER_HISTORY_MARKER_COLUMN} THEN
       RAISE EXCEPTION 'Voucher % history marker is set once, when the balance guard is installed, and cannot change',
         OLD.voucher_number USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END $fn$`,
  `DROP TRIGGER IF EXISTS vouchers_balance_guard_history_marker ON vouchers`,
  `CREATE TRIGGER vouchers_balance_guard_history_marker
     BEFORE INSERT OR UPDATE OF ${VOUCHER_HISTORY_MARKER_COLUMN} ON vouchers
     FOR EACH ROW EXECUTE FUNCTION erp_vouchers_history_marker_guard()`,
  `CREATE OR REPLACE FUNCTION erp_voucher_balance_check(p_voucher_id integer) RETURNS void
   LANGUAGE plpgsql AS $fn$
   DECLARE
     v record;
     currencies integer;
     all_in_currency boolean;
     debit_lines integer;
     credit_lines integer;
     base_debit numeric;
     base_credit numeric;
     txn_debit numeric;
     txn_credit numeric;
     base_tolerance numeric := 0;
   BEGIN
     IF p_voucher_id IS NULL OR erp_ledger_integrity_bypassed() THEN RETURN; END IF;
     SELECT vo.id, vo.voucher_number, vo.voucher_type, vo.${VOUCHER_HISTORY_MARKER_COLUMN} AS history,
            COALESCE(co.company_type, '') AS company_type,
            EXISTS (SELECT 1 FROM gl_inventory_cutovers c
                     WHERE c.company_id = vo.company_id AND c.effective_from <= vo.voucher_date) AS perpetual
       INTO v
       FROM vouchers vo JOIN companies co ON co.id = vo.company_id
      WHERE vo.id = p_voucher_id AND vo.deleted_at IS NULL AND COALESCE(vo.optional, false) = false;
     IF NOT FOUND OR v.history THEN RETURN; END IF;

     SELECT COUNT(DISTINCT transaction_currency) FILTER (WHERE transaction_currency IS NOT NULL),
            COALESCE(bool_and(transaction_currency IS NOT NULL), false),
            COUNT(*) FILTER (WHERE COALESCE(debit_amount, 0) <> 0 OR COALESCE(transaction_debit_amount, 0) <> 0),
            COUNT(*) FILTER (WHERE COALESCE(credit_amount, 0) <> 0 OR COALESCE(transaction_credit_amount, 0) <> 0),
            COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0),
            COALESCE(SUM(transaction_debit_amount), 0), COALESCE(SUM(transaction_credit_amount), 0)
       INTO currencies, all_in_currency, debit_lines, credit_lines, base_debit, base_credit, txn_debit, txn_credit
       FROM voucher_entries WHERE voucher_id = p_voucher_id;

     -- Periodic stock adjustment: one-sided by design when a stock document backs it.
     IF v.voucher_type IN ('Stock Adjustment', 'Production', 'Consumption', 'Mixed')
        AND (NOT v.perpetual OR v.company_type = 'supplier_partner')
        AND (debit_lines = 0 OR credit_lines = 0)
        AND EXISTS (SELECT 1 FROM stock_adjustment_vouchers sav
                      JOIN stock_adjustment_items sai ON sai.adjustment_id = sav.id
                     WHERE sav.voucher_id = p_voucher_id) THEN
       RETURN;
     END IF;

     IF currencies = 1 AND all_in_currency THEN
       IF round(txn_debit, 2) <> round(txn_credit, 2) THEN
         RAISE EXCEPTION 'Voucher % does not balance in its transaction currency: debits %, credits %',
           v.voucher_number, round(txn_debit, 2), round(txn_credit, 2)
           USING ERRCODE = '23514';
       END IF;
       base_tolerance := 0.01;
     END IF;
     IF abs(round(base_debit, 2) - round(base_credit, 2)) > base_tolerance THEN
       RAISE EXCEPTION 'Voucher % does not balance: debits %, credits %',
         v.voucher_number, round(base_debit, 2), round(base_credit, 2)
         USING ERRCODE = '23514';
     END IF;
   END $fn$`,
  `CREATE OR REPLACE FUNCTION erp_voucher_entries_balance_guard() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   BEGIN
     IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM erp_voucher_balance_check(NEW.voucher_id); END IF;
     IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.voucher_id IS DISTINCT FROM NEW.voucher_id) THEN
       PERFORM erp_voucher_balance_check(OLD.voucher_id);
     END IF;
     RETURN NULL;
   END $fn$`,
  `CREATE OR REPLACE FUNCTION erp_vouchers_balance_guard() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   BEGIN
     PERFORM erp_voucher_balance_check(NEW.id);
     RETURN NULL;
   END $fn$`,
  // Removing a voucher's stock document can end its one-sided exemption.
  `CREATE OR REPLACE FUNCTION erp_stock_adjustment_vouchers_balance_guard() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   BEGIN
     PERFORM erp_voucher_balance_check(OLD.voucher_id);
     IF TG_OP = 'UPDATE' THEN PERFORM erp_voucher_balance_check(NEW.voucher_id); END IF;
     RETURN NULL;
   END $fn$`,
  `CREATE OR REPLACE FUNCTION erp_stock_adjustment_items_balance_guard() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   BEGIN
     -- A cascade from a removed adjustment finds no parent here; that
     -- adjustment's own trigger re-checks the voucher.
     PERFORM erp_voucher_balance_check(sav.voucher_id)
        FROM stock_adjustment_vouchers sav WHERE sav.id = OLD.adjustment_id;
     RETURN NULL;
   END $fn$`,
  `DROP TRIGGER IF EXISTS voucher_entries_balance_guard ON voucher_entries`,
  `CREATE CONSTRAINT TRIGGER voucher_entries_balance_guard
     AFTER INSERT OR UPDATE OR DELETE ON voucher_entries
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION erp_voucher_entries_balance_guard()`,
  `DROP TRIGGER IF EXISTS vouchers_balance_guard ON vouchers`,
  // A voucher re-activated, re-dated, moved or re-typed is checked as well.
  `CREATE CONSTRAINT TRIGGER vouchers_balance_guard
     AFTER UPDATE OF optional, deleted_at, voucher_date, company_id, voucher_type, created_at ON vouchers
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION erp_vouchers_balance_guard()`,
  `DROP TRIGGER IF EXISTS stock_adjustment_vouchers_balance_guard ON stock_adjustment_vouchers`,
  `CREATE CONSTRAINT TRIGGER stock_adjustment_vouchers_balance_guard
     AFTER UPDATE OF voucher_id OR DELETE ON stock_adjustment_vouchers
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION erp_stock_adjustment_vouchers_balance_guard()`,
  `DROP TRIGGER IF EXISTS stock_adjustment_items_balance_guard ON stock_adjustment_items`,
  `CREATE CONSTRAINT TRIGGER stock_adjustment_items_balance_guard
     AFTER UPDATE OF adjustment_id OR DELETE ON stock_adjustment_items
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION erp_stock_adjustment_items_balance_guard()`,
];

const INSTALL_LOCK_KEY = 2026_10_85;
/** How long the installer waits for its locks (the ALTER TABLE needs a brief exclusive lock on vouchers). */
export const VOUCHER_BALANCE_GUARD_LOCK_TIMEOUT = "15s";

type Queryable = { query: Pool["query"] };

const TRIGGER_NAMES_SQL = VOUCHER_BALANCE_GUARD_TRIGGERS.map(([, name]) => `'${name}'`).join(", ");

/**
 * The installed guard version, or null when any trigger or the history marker
 * is missing.
 */
export async function installedVoucherBalanceGuardVersion(client: Queryable): Promise<string | null> {
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(to_regprocedure('erp_voucher_balance_check(integer)'), 'pg_proc') AS version
      WHERE (SELECT COUNT(DISTINCT tgname) FROM pg_trigger
              WHERE NOT tgisinternal AND tgname IN (${TRIGGER_NAMES_SQL})) = ${VOUCHER_BALANCE_GUARD_TRIGGERS.length}
        AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2)`,
    ["vouchers", VOUCHER_HISTORY_MARKER_COLUMN]
  );
  return result.rows[0]?.version ?? null;
}

/**
 * Installs the guard. Runs on every boot after the ledger integrity guard
 * (whose bypass function it uses) and the cut-over table, like them because
 * production never runs the ordered startup-schema pass. A database already at
 * VOUCHER_BALANCE_GUARD_VERSION is left untouched (idempotent). Fatal on
 * failure, like the closed-period guard: serving writes without it would let
 * unbalanced vouchers commit. The installer waits at most
 * VOUCHER_BALANCE_GUARD_LOCK_TIMEOUT for its locks, then fails with a clear log
 * so the previous deployment stays live.
 */
export async function ensureVoucherBalanceGuard(pool: Pick<Pool, "connect">): Promise<true> {
  const client = await pool.connect();
  try {
    if ((await installedVoucherBalanceGuardVersion(client)) === VOUCHER_BALANCE_GUARD_VERSION) {
      logger.info(`[startup] ✓ Voucher balance guard already installed (${VOUCHER_BALANCE_GUARD_VERSION})`);
      return true;
    }
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${VOUCHER_BALANCE_GUARD_LOCK_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
    for (const statement of VOUCHER_BALANCE_GUARD_DDL) {
      await client.query(statement);
    }
    await client.query(`COMMENT ON FUNCTION erp_voucher_balance_check(integer) IS '${VOUCHER_BALANCE_GUARD_VERSION}'`);
    await client.query("COMMIT");
    logger.info(`[startup] ✓ Voucher balance guard ensured (${VOUCHER_BALANCE_GUARD_VERSION})`);
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const reason = getErrorMessage(error);
    logger.error("[startup] ✗ Voucher balance guard could not be installed; refusing to start", {
      version: VOUCHER_BALANCE_GUARD_VERSION,
      lockTimeout: VOUCHER_BALANCE_GUARD_LOCK_TIMEOUT,
      error: reason,
    });
    // Fatal: the caller (server/index.ts) aborts startup; the log above says why.
    throw error;
  } finally {
    client.release();
  }
}
