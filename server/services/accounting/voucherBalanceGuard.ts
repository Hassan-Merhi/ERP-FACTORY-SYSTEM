import type { Pool } from "pg";

import { logger } from "../../lib/logger";
import { getErrorMessage } from "../../lib/httpHandlers";

/**
 * Voucher balance guard (2026-10 accounting audit, wave 8.5).
 *
 * Once a company's perpetual-inventory cut-over is applied, every voucher it
 * posts balances: the stock adjustments carry their inventory line, and the
 * linked journals (COGS, goods in transit, stock-in, factory invoices, the
 * factory stock journal) are balanced by construction. This guard makes that a
 * database rule: at COMMIT, an active (not deleted, not optional) voucher of
 * such a company dated on or after its cut-over must have debits equal to
 * credits (to the cent).
 *
 * It is a deferred constraint trigger, so a writer may add a voucher's lines
 * one by one inside its transaction; it fails only if the voucher is left
 * unbalanced when the transaction commits. Every writer posts a voucher and its
 * lines in one transaction (the last ones were converted with this guard).
 *
 * Left alone: vouchers dated before the cut-over (periodic history, where stock
 * adjustments were one-sided by design), companies without a cut-over, and
 * supplier-partner companies, whose stock is carried in their sp_stock accounts
 * and whose stock adjustments stay one-sided. A reviewed repair can
 * `SET LOCAL app.ledger_integrity_bypass = 'on'` for its own transaction.
 */
export const VOUCHER_BALANCE_GUARD_DDL: readonly string[] = [
  `CREATE OR REPLACE FUNCTION erp_voucher_balance_check(p_voucher_id integer) RETURNS void
   LANGUAGE plpgsql AS $fn$
   DECLARE
     v record;
     total_debit numeric;
     total_credit numeric;
   BEGIN
     IF p_voucher_id IS NULL OR erp_ledger_integrity_bypassed() THEN RETURN; END IF;
     SELECT vo.id, vo.voucher_number, vo.voucher_date, vo.company_id INTO v
       FROM vouchers vo
       JOIN gl_inventory_cutovers c ON c.company_id = vo.company_id AND c.effective_from <= vo.voucher_date
       JOIN companies co ON co.id = vo.company_id AND COALESCE(co.company_type, '') <> 'supplier_partner'
      WHERE vo.id = p_voucher_id AND vo.deleted_at IS NULL AND COALESCE(vo.optional, false) = false;
     IF NOT FOUND THEN RETURN; END IF;
     SELECT COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0) INTO total_debit, total_credit
       FROM voucher_entries WHERE voucher_id = p_voucher_id;
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
export const VOUCHER_BALANCE_GUARD_VERSION = "2026-10-voucher-balance-v1";

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
