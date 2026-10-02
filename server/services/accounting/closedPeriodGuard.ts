import type { Pool } from "pg";

import { logger } from "../../lib/logger";
import { CLOSED_PERIOD_ERROR_CODE } from "../../lib/closedPeriodError";

/**
 * Database-enforced closed-period lock.
 *
 * A fiscal close (closeFiscalPeriod in storage/accounting/fiscal-periods.ts)
 * posts a closing journal and records a fiscal_period_closures row, but nothing
 * stopped later writes dated inside the closed range: the balances the closing
 * journal moved to retained earnings could change underneath it. Vouchers are
 * written from dozens of routes and services, so the guard lives in BEFORE
 * triggers on vouchers and voucher_entries instead of in each caller.
 *
 * Rule: once a company has a CLOSED fiscal period, no voucher dated on or
 * before the latest closed period_end_date may be created, deleted, or have its
 * financial content changed (company, dates, type, amounts, currency, rate,
 * optional flag, soft-delete; for lines: voucher, accounts, parties, amounts).
 * Descriptions and narrations stay editable. Both voucher_date and
 * effective_date are checked because reports date by either.
 *
 * Bypass is limited to process-owned work: the maintenance database scope
 * (startup repairs and schedulers; request handlers can never elevate into it,
 * see runWithDatabaseMaintenanceScope) or an explicit transaction-local
 * `SET LOCAL app.closed_period_override = 'on'`.
 *
 * Concurrency: every guarded write takes a shared advisory lock on the company
 * and closeFiscalPeriod takes the exclusive one, so a close cannot compute its
 * balances while another transaction is still writing into the period.
 */

export { CLOSED_PERIOD_ERROR_CODE };
export const CLOSED_PERIOD_LOCK_NAMESPACE = 74_122;

export const CLOSED_PERIOD_GUARD_DDL: readonly string[] = [
  `CREATE OR REPLACE FUNCTION erp_closed_period_guard_bypassed()
   RETURNS boolean
   LANGUAGE sql
   STABLE
   AS $bypass$
     SELECT lower(btrim(coalesce(current_setting('app.company_scope_maintenance', true), ''))) = 'on'
         OR lower(btrim(coalesce(current_setting('app.closed_period_override', true), ''))) = 'on'
   $bypass$`,

  `CREATE OR REPLACE FUNCTION erp_assert_accounting_date_open(p_company_id integer, p_date date)
   RETURNS void
   LANGUAGE plpgsql
   AS $assert_open$
   DECLARE
     locked_through date;
   BEGIN
     IF p_company_id IS NULL OR p_date IS NULL OR erp_closed_period_guard_bypassed() THEN
       RETURN;
     END IF;

     PERFORM pg_advisory_xact_lock_shared(${CLOSED_PERIOD_LOCK_NAMESPACE}, p_company_id);

     SELECT max(period_end_date) INTO locked_through
       FROM fiscal_period_closures
      WHERE company_id = p_company_id
        AND status = 'CLOSED';

     IF locked_through IS NOT NULL AND p_date <= locked_through THEN
       RAISE EXCEPTION USING
         ERRCODE = '${CLOSED_PERIOD_ERROR_CODE}',
         MESSAGE = format(
           'ACCOUNTING_PERIOD_CLOSED: the books are closed through %s, so an entry dated %s cannot be created, changed or deleted',
           locked_through,
           p_date
         ),
         HINT = 'Post a correcting entry dated after the closed period.';
     END IF;
   END
   $assert_open$`,

  `CREATE OR REPLACE FUNCTION erp_vouchers_closed_period_guard()
   RETURNS trigger
   LANGUAGE plpgsql
   AS $vouchers_guard$
   DECLARE
     financial_change boolean := true;
   BEGIN
     IF TG_OP = 'UPDATE' THEN
       financial_change :=
         (NEW.company_id, NEW.voucher_type, NEW.voucher_date, NEW.effective_date, NEW.total_amount,
          NEW.currency, NEW.exchange_rate, NEW.optional, NEW.deleted_at)
         IS DISTINCT FROM
         (OLD.company_id, OLD.voucher_type, OLD.voucher_date, OLD.effective_date, OLD.total_amount,
          OLD.currency, OLD.exchange_rate, OLD.optional, OLD.deleted_at);
     END IF;

     IF NOT financial_change THEN
       RETURN NEW;
     END IF;

     IF TG_OP IN ('UPDATE', 'DELETE') THEN
       PERFORM erp_assert_accounting_date_open(OLD.company_id, OLD.voucher_date);
       PERFORM erp_assert_accounting_date_open(OLD.company_id, OLD.effective_date);
     END IF;
     IF TG_OP IN ('INSERT', 'UPDATE') THEN
       PERFORM erp_assert_accounting_date_open(NEW.company_id, NEW.voucher_date);
       PERFORM erp_assert_accounting_date_open(NEW.company_id, NEW.effective_date);
     END IF;

     IF TG_OP = 'DELETE' THEN
       RETURN OLD;
     END IF;
     RETURN NEW;
   END
   $vouchers_guard$`,

  `CREATE OR REPLACE FUNCTION erp_assert_voucher_open(p_voucher_id integer)
   RETURNS void
   LANGUAGE plpgsql
   AS $voucher_open$
   DECLARE
     parent record;
   BEGIN
     IF p_voucher_id IS NULL OR erp_closed_period_guard_bypassed() THEN
       RETURN;
     END IF;
     SELECT company_id, voucher_date, effective_date INTO parent FROM vouchers WHERE id = p_voucher_id;
     -- No visible parent: an insert fails its foreign key anyway, and a cascade
     -- from a voucher delete was already checked by the vouchers trigger.
     IF NOT FOUND THEN
       RETURN;
     END IF;
     PERFORM erp_assert_accounting_date_open(parent.company_id, parent.voucher_date);
     PERFORM erp_assert_accounting_date_open(parent.company_id, parent.effective_date);
   END
   $voucher_open$`,

  `CREATE OR REPLACE FUNCTION erp_voucher_entries_closed_period_guard()
   RETURNS trigger
   LANGUAGE plpgsql
   AS $entries_guard$
   DECLARE
     financial_change boolean := true;
   BEGIN
     IF TG_OP = 'UPDATE' THEN
       financial_change :=
         (NEW.voucher_id, NEW.ledger_account_id, NEW.bank_account_id, NEW.fixed_asset_id, NEW.supplier_id,
          NEW.employee_id, NEW.customer_id, NEW.factory_supplier_id, NEW.debit_amount, NEW.credit_amount,
          NEW.transaction_currency, NEW.transaction_debit_amount, NEW.transaction_credit_amount,
          NEW.base_debit_amount, NEW.base_credit_amount, NEW.historical_exchange_rate, NEW.rate_convention)
         IS DISTINCT FROM
         (OLD.voucher_id, OLD.ledger_account_id, OLD.bank_account_id, OLD.fixed_asset_id, OLD.supplier_id,
          OLD.employee_id, OLD.customer_id, OLD.factory_supplier_id, OLD.debit_amount, OLD.credit_amount,
          OLD.transaction_currency, OLD.transaction_debit_amount, OLD.transaction_credit_amount,
          OLD.base_debit_amount, OLD.base_credit_amount, OLD.historical_exchange_rate, OLD.rate_convention);
     END IF;

     IF NOT financial_change THEN
       RETURN NEW;
     END IF;

     IF TG_OP IN ('UPDATE', 'DELETE') THEN
       PERFORM erp_assert_voucher_open(OLD.voucher_id);
     END IF;
     IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.voucher_id IS DISTINCT FROM OLD.voucher_id) THEN
       PERFORM erp_assert_voucher_open(NEW.voucher_id);
     END IF;

     IF TG_OP = 'DELETE' THEN
       RETURN OLD;
     END IF;
     RETURN NEW;
   END
   $entries_guard$`,

  `DROP TRIGGER IF EXISTS vouchers_closed_period_guard ON vouchers`,
  `CREATE TRIGGER vouchers_closed_period_guard
     BEFORE INSERT OR UPDATE OR DELETE ON vouchers
     FOR EACH ROW EXECUTE FUNCTION erp_vouchers_closed_period_guard()`,
  `DROP TRIGGER IF EXISTS voucher_entries_closed_period_guard ON voucher_entries`,
  `CREATE TRIGGER voucher_entries_closed_period_guard
     BEFORE INSERT OR UPDATE OR DELETE ON voucher_entries
     FOR EACH ROW EXECUTE FUNCTION erp_voucher_entries_closed_period_guard()`,
];

const INSTALL_LOCK_KEY = 741_220_262;

/**
 * Installs the guard. Runs on every boot (not only in the ordered migration
 * pass, which production can skip), after ensureRuntimeSchema has created
 * fiscal_period_closures. One transaction under an advisory lock so instances
 * starting together do not race on CREATE OR REPLACE FUNCTION.
 */
export async function ensureClosedPeriodGuard(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
    for (const statement of CLOSED_PERIOD_GUARD_DDL) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  logger.info("[startup] ✓ Closed fiscal period guard ensured");
}

export { isClosedPeriodError, closedPeriodErrorResponse } from "../../lib/closedPeriodError";
