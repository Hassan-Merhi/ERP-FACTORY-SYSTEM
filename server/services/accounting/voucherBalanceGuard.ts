import type { Pool } from "pg";

import { logger } from "../../lib/logger";
import { getErrorMessage } from "../../lib/httpHandlers";

/**
 * Voucher balance guard (2026-10 accounting audit, waves 8.5 and 9).
 *
 * A deferred constraint trigger: at COMMIT, an active (not deleted, not
 * optional) voucher must have debits equal to credits (to the cent), so a
 * writer may add lines one by one inside its transaction and fails only if it
 * leaves the voucher unbalanced. Lines all in one transaction currency are
 * compared in that currency (per-line conversion can leave the USD columns a
 * cent apart); otherwise the USD base columns are compared.
 *
 * Which vouchers it checks:
 *   - every voucher created after the guard was first installed (the
 *     `voucher_balance_guard_since` system setting), except the stock
 *     adjustment types (Stock Adjustment, Production, Consumption, Mixed),
 *     which are one-sided by design under periodic inventory;
 *   - every voucher dated on or after a company's perpetual-inventory
 *     cut-over, stock adjustments included (they carry their inventory line),
 *     unless the company is a supplier partner.
 * Vouchers created before the install are history and are never checked, so
 * legacy rows stay editable; the integrity diagnostic reports them.
 *
 * Every writer posts a voucher and its lines in one transaction (the last ones
 * were converted in wave 8.5). Re-activating, re-dating or moving a voucher is
 * checked too. A reviewed repair can `SET LOCAL app.ledger_integrity_bypass =
 * 'on'` for its own transaction.
 */
/** The system_settings key holding when the guard was first installed. */
export const VOUCHER_BALANCE_GUARD_SINCE_KEY = "voucher_balance_guard_since";

export const VOUCHER_BALANCE_GUARD_DDL: readonly string[] = [
  // When the guard was first installed: vouchers created before it are history
  // and are never checked (legacy one-sided rows stay editable).
  `INSERT INTO system_settings (key, value) VALUES ('${VOUCHER_BALANCE_GUARD_SINCE_KEY}', now()::text)
   ON CONFLICT (key) DO NOTHING`,
  `CREATE OR REPLACE FUNCTION erp_voucher_balance_check(p_voucher_id integer) RETURNS void
   LANGUAGE plpgsql AS $fn$
   DECLARE
     v record;
     guard_since timestamptz;
     currencies integer;
     all_in_currency boolean;
     total_debit numeric;
     total_credit numeric;
   BEGIN
     IF p_voucher_id IS NULL OR erp_ledger_integrity_bypassed() THEN RETURN; END IF;
     SELECT vo.id, vo.voucher_number, vo.voucher_type, vo.created_at, COALESCE(co.company_type, '') AS company_type,
            EXISTS (SELECT 1 FROM gl_inventory_cutovers c
                     WHERE c.company_id = vo.company_id AND c.effective_from <= vo.voucher_date) AS perpetual
       INTO v
       FROM vouchers vo JOIN companies co ON co.id = vo.company_id
      WHERE vo.id = p_voucher_id AND vo.deleted_at IS NULL AND COALESCE(vo.optional, false) = false;
     IF NOT FOUND THEN RETURN; END IF;

     IF v.voucher_type IN ('Stock Adjustment', 'Production', 'Consumption', 'Mixed') THEN
       -- One-sided by design under periodic inventory; balanced (they carry their
       -- inventory line) from a non-supplier-partner company's cut-over.
       IF NOT v.perpetual OR v.company_type = 'supplier_partner' THEN RETURN; END IF;
     ELSE
       SELECT value::timestamptz INTO guard_since FROM system_settings WHERE key = '${VOUCHER_BALANCE_GUARD_SINCE_KEY}';
       IF NOT ((v.perpetual AND v.company_type <> 'supplier_partner')
               OR (guard_since IS NOT NULL AND v.created_at >= guard_since)) THEN
         RETURN;
       END IF;
     END IF;

     -- Lines in one transaction currency balance in that currency (per-line base
     -- rounding can leave the USD columns a cent apart); otherwise in the base.
     SELECT COUNT(DISTINCT transaction_currency) FILTER (WHERE transaction_currency IS NOT NULL),
            COALESCE(bool_and(transaction_currency IS NOT NULL), false)
       INTO currencies, all_in_currency
       FROM voucher_entries WHERE voucher_id = p_voucher_id;
     IF currencies = 1 AND all_in_currency THEN
       SELECT COALESCE(SUM(transaction_debit_amount), 0), COALESCE(SUM(transaction_credit_amount), 0)
         INTO total_debit, total_credit
         FROM voucher_entries WHERE voucher_id = p_voucher_id;
     ELSE
       SELECT COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0) INTO total_debit, total_credit
         FROM voucher_entries WHERE voucher_id = p_voucher_id;
     END IF;
     IF round(total_debit, 2) <> round(total_credit, 2) THEN
       RAISE EXCEPTION 'Voucher % does not balance: debits %, credits %',
         v.voucher_number, round(total_debit, 2), round(total_credit, 2)
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
  `DROP TRIGGER IF EXISTS voucher_entries_balance_guard ON voucher_entries`,
  `CREATE CONSTRAINT TRIGGER voucher_entries_balance_guard
     AFTER INSERT OR UPDATE OR DELETE ON voucher_entries
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION erp_voucher_entries_balance_guard()`,
  `DROP TRIGGER IF EXISTS vouchers_balance_guard ON vouchers`,
  // A voucher re-activated, re-dated or moved is checked as well.
  `CREATE CONSTRAINT TRIGGER vouchers_balance_guard
     AFTER UPDATE OF optional, deleted_at, voucher_date, company_id ON vouchers
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION erp_vouchers_balance_guard()`,
];

/** Version of VOUCHER_BALANCE_GUARD_DDL. Bump it whenever a statement changes. */
export const VOUCHER_BALANCE_GUARD_VERSION = "2026-10-voucher-balance-v2";

const INSTALL_LOCK_KEY = 2026_10_85;

async function installedVersion(client: { query: Pool["query"] }): Promise<string | null> {
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(to_regprocedure('erp_voucher_balance_check(integer)'), 'pg_proc') AS version
      WHERE EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'voucher_entries_balance_guard' AND NOT tgisinternal)
        AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'vouchers_balance_guard' AND NOT tgisinternal)`
  );
  return result.rows[0]?.version ?? null;
}

/**
 * Installs the guard. Runs on every boot after the ledger integrity guard
 * (whose bypass function it uses) and the cut-over table, like them because
 * production never runs the ordered startup-schema pass. A database already at
 * VOUCHER_BALANCE_GUARD_VERSION is left untouched; a failure is logged and
 * retried on the next boot rather than blocking startup.
 */
export async function ensureVoucherBalanceGuard(pool: Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    if ((await installedVersion(client)) === VOUCHER_BALANCE_GUARD_VERSION) {
      logger.info("[startup] ✓ Voucher balance guard already installed");
      return true;
    }
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
    await client.query("SET LOCAL lock_timeout = '10s'");
    for (const statement of VOUCHER_BALANCE_GUARD_DDL) {
      await client.query(statement);
    }
    await client.query(`COMMENT ON FUNCTION erp_voucher_balance_check(integer) IS '${VOUCHER_BALANCE_GUARD_VERSION}'`);
    await client.query("COMMIT");
    logger.info("[startup] ✓ Voucher balance guard ensured");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("[startup] ✗ Voucher balance guard could not be installed", { error: getErrorMessage(error) });
    return false;
  } finally {
    client.release();
  }
}
