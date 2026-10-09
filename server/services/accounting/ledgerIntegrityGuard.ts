import type { Pool } from "pg";

import { logger } from "../../lib/logger";
import { getErrorMessage } from "../../lib/httpHandlers";
import { accountTypeNamesOf } from "./accountClassification";

function typeList(...classes: Parameters<typeof accountTypeNamesOf>): string {
  return accountTypeNamesOf(...classes)
    .map((name) => {
      if (!/^[a-z ]+$/.test(name)) throw new Error("ledger_integrity_unsafe_type_name");
      return `'${name}'`;
    })
    .join(", ");
}

/**
 * The engine's side for a sideless ledger opening (ledgerBalanceEngine
 * defaultOpeningSide: accountClassification.defaultOpeningSide of the account
 * type, Dr for a type the classifier does not know): Dr for assets and
 * expenses, Cr for liabilities, equity and income; a party account Dr for a
 * customer, Cr otherwise. Generated from the classifier's type lists, so the
 * SQL cannot drift from it.
 */
const DEFAULT_OPENING_SIDE_FUNCTION = `CREATE OR REPLACE FUNCTION erp_default_ledger_opening_side(p_type text)
   RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
     SELECT CASE
              WHEN t IN (${typeList("asset", "expense")}) THEN 'Dr'
              WHEN t IN (${typeList("liability", "equity", "income")}) THEN 'Cr'
              WHEN t = 'customer' THEN 'Dr'
              WHEN t IN (${typeList("party")}) THEN 'Cr'
              ELSE 'Dr'
            END
       FROM (SELECT lower(btrim(COALESCE(p_type, ''))) AS t) normalized
   $fn$`;

/**
 * Ledger integrity guards (2026-10 accounting audit, wave 4).
 *
 * Production held posted lines on hard-deleted accounts (there was no foreign
 * key on voucher_entries.ledger_account_id), on soft-deleted accounts, on
 * another company's accounts and with negative amounts, and accounts carrying
 * history had been deleted. These guards stop new cases at the database,
 * whatever code path writes:
 *   - foreign keys (ON DELETE RESTRICT) from voucher_entries to ledger, bank and
 *     fixed-asset accounts, so an account with lines cannot be hard-deleted;
 *   - CHECK constraints: amounts non-negative, at most one side per line;
 *   - a BEFORE trigger on voucher_entries: a new line (or one whose targets
 *     change) has one owner under the engine's attribution — one account
 *     (ledger, bank or fixed asset; a bank with its linked ledger counts once)
 *     with at most one party tag, or one party alone (wave 16 B); every
 *     account a line names belongs
 *     to the line's company (a supplier may belong to the parent company or a
 *     subsidiary: the group shares suppliers in intercompany POs) and is not
 *     deleted;
 *   - a BEFORE trigger on ledger_accounts: an account whose balance (opening
 *     plus posted lines; a sideless opening on its type's side, as the engine
 *     reads it — wave 16 B) is not zero cannot be soft-deleted.
 *
 * Existing rows are left as they are: constraints are NOT VALID and the line
 * trigger only checks accounts when they are set or changed. The accounting
 * integrity diagnostic reports the existing cases for a reviewed correction.
 *
 * A reviewed repair can `SET LOCAL app.ledger_integrity_bypass = 'on'` for its
 * own transaction; nothing in the application does.
 */
export const LEDGER_INTEGRITY_GUARD_DDL: readonly string[] = [
  `DO $$ BEGIN
     ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_ledger_account_id_fkey
       FOREIGN KEY (ledger_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_bank_account_id_fkey
       FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE RESTRICT NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_fixed_asset_id_fkey
       FOREIGN KEY (fixed_asset_id) REFERENCES fixed_assets(id) ON DELETE RESTRICT NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_amounts_non_negative
       CHECK (COALESCE(debit_amount, 0) >= 0 AND COALESCE(credit_amount, 0) >= 0) NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_single_side
       CHECK (COALESCE(debit_amount, 0) = 0 OR COALESCE(credit_amount, 0) = 0) NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE OR REPLACE FUNCTION erp_ledger_integrity_bypassed() RETURNS boolean
   LANGUAGE sql STABLE AS $fn$
     SELECT COALESCE(lower(btrim(current_setting('app.ledger_integrity_bypass', true))), '') = 'on'
   $fn$`,
  // Every account a line names must belong to the line's company (a supplier may
  // also belong to the parent company: subsidiaries post against the group's
  // shared suppliers) and must not be deleted. Runs after
  // voucher_entries_sync_company_id (triggers fire in name order), so
  // NEW.company_id is the parent voucher's company.
  `CREATE OR REPLACE FUNCTION erp_voucher_entry_target_guard() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   DECLARE
     target_company integer;
     target_deleted timestamp;
     parent_company integer;
     account_targets integer;
     party_targets integer;
   BEGIN
     IF erp_ledger_integrity_bypassed() THEN
       RETURN NEW;
     END IF;
     IF TG_OP = 'UPDATE'
        AND (NEW.company_id, NEW.ledger_account_id, NEW.bank_account_id, NEW.fixed_asset_id, NEW.supplier_id,
             NEW.employee_id, NEW.customer_id, NEW.factory_supplier_id)
            IS NOT DISTINCT FROM
            (OLD.company_id, OLD.ledger_account_id, OLD.bank_account_id, OLD.fixed_asset_id, OLD.supplier_id,
             OLD.employee_id, OLD.customer_id, OLD.factory_supplier_id)
     THEN
       RETURN NEW;
     END IF;

     -- Wave 16 (B): a new line, or a line whose targets change, must have one
     -- owner under the engine's attribution (partyLineRules.ts): exactly one
     -- account (ledger, bank or fixed asset) with at most one party tag
     -- (supplier, employee, factory supplier or customer) — a tag on an
     -- account line belongs to the account — or, with no account, exactly one
     -- party. The one pair of accounts the engine defines is a bank with its
     -- own linked ledger (the line counts on the ledger). A line with no target
     -- (no owner) or with two accounts or two parties is refused. Existing
     -- lines are exempt: an update that leaves the targets alone returned above.
     account_targets := num_nonnulls(NEW.ledger_account_id, NEW.bank_account_id, NEW.fixed_asset_id);
     party_targets := num_nonnulls(NEW.supplier_id, NEW.employee_id, NEW.factory_supplier_id, NEW.customer_id);
     IF account_targets = 2 AND NEW.fixed_asset_id IS NULL
        AND EXISTS (SELECT 1 FROM bank_accounts b
                     WHERE b.id = NEW.bank_account_id AND b.linked_ledger_id = NEW.ledger_account_id) THEN
       account_targets := 1;
     END IF;
     IF NOT ((account_targets = 1 AND party_targets <= 1) OR (account_targets = 0 AND party_targets = 1)) THEN
       RAISE EXCEPTION USING ERRCODE = '23514',
         MESSAGE = format('VOUCHER_LINE_TARGET_REQUIRED: a voucher line must post to exactly one account (line of voucher %s names %s accounts and %s parties)',
                          NEW.voucher_id, account_targets, party_targets),
         HINT = 'Choose one ledger, bank or fixed asset (optionally tagged with one party), or one party.';
     END IF;

     IF NEW.ledger_account_id IS NOT NULL THEN
       SELECT company_id, deleted_at INTO target_company, target_deleted
         FROM ledger_accounts WHERE id = NEW.ledger_account_id;
       IF NOT FOUND OR target_company IS DISTINCT FROM NEW.company_id THEN
         RAISE EXCEPTION USING ERRCODE = '23514',
           MESSAGE = format('LEDGER_ACCOUNT_COMPANY_MISMATCH: ledger account %s does not belong to company %s',
                            NEW.ledger_account_id, NEW.company_id);
       END IF;
       IF target_deleted IS NOT NULL THEN
         RAISE EXCEPTION USING ERRCODE = '23514',
           MESSAGE = format('LEDGER_ACCOUNT_DELETED: ledger account %s is deleted and cannot be posted to',
                            NEW.ledger_account_id);
       END IF;
     END IF;

     IF NEW.bank_account_id IS NOT NULL THEN
       SELECT company_id, deleted_at INTO target_company, target_deleted
         FROM bank_accounts WHERE id = NEW.bank_account_id;
       IF NOT FOUND OR target_company IS DISTINCT FROM NEW.company_id OR target_deleted IS NOT NULL THEN
         RAISE EXCEPTION USING ERRCODE = '23514',
           MESSAGE = format('BANK_ACCOUNT_NOT_POSTABLE: bank account %s is deleted or belongs to another company',
                            NEW.bank_account_id);
       END IF;
     END IF;

     IF NEW.fixed_asset_id IS NOT NULL THEN
       SELECT company_id INTO target_company FROM fixed_assets WHERE id = NEW.fixed_asset_id;
       IF NOT FOUND OR target_company IS DISTINCT FROM NEW.company_id THEN
         RAISE EXCEPTION USING ERRCODE = '23514',
           MESSAGE = format('FIXED_ASSET_COMPANY_MISMATCH: fixed asset %s does not belong to company %s',
                            NEW.fixed_asset_id, NEW.company_id);
       END IF;
     END IF;

     IF NEW.customer_id IS NOT NULL THEN
       SELECT company_id INTO target_company FROM customers WHERE id = NEW.customer_id;
       IF NOT FOUND OR target_company IS DISTINCT FROM NEW.company_id THEN
         RAISE EXCEPTION USING ERRCODE = '23514',
           MESSAGE = format('CUSTOMER_COMPANY_MISMATCH: customer %s does not belong to company %s',
                            NEW.customer_id, NEW.company_id);
       END IF;
     END IF;

     IF NEW.employee_id IS NOT NULL THEN
       SELECT company_id INTO target_company FROM employees WHERE id = NEW.employee_id;
       IF target_company IS DISTINCT FROM NEW.company_id THEN
         RAISE EXCEPTION USING ERRCODE = '23514',
           MESSAGE = format('EMPLOYEE_COMPANY_MISMATCH: employee %s does not belong to company %s',
                            NEW.employee_id, NEW.company_id);
       END IF;
     END IF;

     IF NEW.factory_supplier_id IS NOT NULL THEN
       SELECT company_id INTO target_company FROM factory_suppliers WHERE id = NEW.factory_supplier_id;
       IF target_company IS DISTINCT FROM NEW.company_id THEN
         RAISE EXCEPTION USING ERRCODE = '23514',
           MESSAGE = format('FACTORY_SUPPLIER_COMPANY_MISMATCH: factory supplier %s does not belong to company %s',
                            NEW.factory_supplier_id, NEW.company_id);
       END IF;
     END IF;

     IF NEW.supplier_id IS NOT NULL THEN
       SELECT company_id INTO target_company FROM suppliers WHERE id = NEW.supplier_id;
       IF target_company IS DISTINCT FROM NEW.company_id THEN
         -- Group suppliers are shared between a parent and its subsidiaries in
         -- both directions (subsidiary POs, and the parent's side of an
         -- intercompany PO); anything outside that parent/child pair is refused.
         SELECT parent_company_id INTO parent_company FROM companies WHERE id = NEW.company_id;
         IF NOT (
              (parent_company IS NOT NULL AND target_company = parent_company)
              OR EXISTS (SELECT 1 FROM companies c WHERE c.id = target_company AND c.parent_company_id = NEW.company_id)
            ) THEN
           RAISE EXCEPTION USING ERRCODE = '23514',
             MESSAGE = format('SUPPLIER_COMPANY_MISMATCH: supplier %s belongs to neither company %s nor its parent or subsidiaries',
                              NEW.supplier_id, NEW.company_id);
         END IF;
       END IF;
     END IF;

     RETURN NEW;
   END
   $fn$`,
  `DROP TRIGGER IF EXISTS voucher_entries_target_guard ON voucher_entries`,
  `CREATE TRIGGER voucher_entries_target_guard
     BEFORE INSERT OR UPDATE ON voucher_entries
     FOR EACH ROW EXECUTE FUNCTION erp_voucher_entry_target_guard()`,
  // An account whose balance (opening plus posted lines) is not zero cannot be
  // soft-deleted: every report hides deleted accounts, so the balance would
  // silently leave the books (company 10 lost ~1.5M of activity this way). An
  // account emptied by a journal (account migration does this) can be retired;
  // its history stays on its vouchers.
  DEFAULT_OPENING_SIDE_FUNCTION,
  `CREATE OR REPLACE FUNCTION erp_ledger_account_delete_guard() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   DECLARE
     balance numeric;
   BEGIN
     IF erp_ledger_integrity_bypassed() OR NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL THEN
       RETURN NEW;
     END IF;
     -- Wave 16 (B): a sideless opening takes the engine's side for the type (it assumed Dr).
     SELECT (CASE WHEN COALESCE(NULLIF(OLD.opening_balance_side, ''),
                                erp_default_ledger_opening_side(OLD.account_type)) = 'Cr'
                  THEN -1 ELSE 1 END) * COALESCE(OLD.opening_balance, 0)
            + COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0)
       INTO balance
       FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
      WHERE ve.ledger_account_id = OLD.id AND v.deleted_at IS NULL AND v.optional = false;
     IF balance <> 0 THEN
       RAISE EXCEPTION USING ERRCODE = '23514',
         MESSAGE = format('LEDGER_ACCOUNT_HAS_BALANCE: account %s has a balance of %s and cannot be deleted', OLD.id, balance),
         HINT = 'Move its balance to another account with a journal entry first, or deactivate it instead.';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DROP TRIGGER IF EXISTS ledger_accounts_delete_guard ON ledger_accounts`,
  `CREATE TRIGGER ledger_accounts_delete_guard
     BEFORE UPDATE OF deleted_at ON ledger_accounts
     FOR EACH ROW EXECUTE FUNCTION erp_ledger_account_delete_guard()`,
];

const INSTALL_LOCK_KEY = 741_220_263;

/**
 * Version of LEDGER_INTEGRITY_GUARD_DDL. Bump it whenever a statement changes:
 * a database already at this version is left alone, so boots after the first
 * take no locks on the ledger tables (ADD CONSTRAINT and CREATE TRIGGER take
 * strong table locks even when they end up changing nothing).
 */
export const LEDGER_INTEGRITY_GUARD_VERSION = "2026-10-ledger-integrity-v2";

// A schema push drops constraints it does not know about while the version
// comment survives, so the constraints are checked as well as the version.
export const LEDGER_GUARD_CONSTRAINTS: readonly string[] = [
  "voucher_entries_ledger_account_id_fkey",
  "voucher_entries_bank_account_id_fkey",
  "voucher_entries_fixed_asset_id_fkey",
  "voucher_entries_amounts_non_negative",
  "voucher_entries_single_side",
];

async function installedVersion(client: { query: Pool["query"] }): Promise<string | null> {
  const result = await client.query<{ version: string | null }>(
    // to_regprocedure, not a ::regprocedure cast: the cast raises on a database
    // where the function does not exist yet, which is every first install.
    `SELECT obj_description(to_regprocedure('erp_voucher_entry_target_guard()'), 'pg_proc') AS version
      WHERE EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'voucher_entries_target_guard' AND NOT tgisinternal)
        AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ledger_accounts_delete_guard' AND NOT tgisinternal)
        AND (SELECT COUNT(*) FROM pg_constraint
              WHERE conrelid = 'voucher_entries'::regclass
                AND conname = ANY($1::text[])) = cardinality($1::text[])`,
    [LEDGER_GUARD_CONSTRAINTS]
  );
  return result.rows[0]?.version ?? null;
}

/**
 * Installs the guards. Runs on every boot, like ensureClosedPeriodGuard,
 * because production runs with RUN_STARTUP_MIGRATIONS=false and never executes
 * the ordered startup-schema pass. A database already at
 * LEDGER_INTEGRITY_GUARD_VERSION is left untouched. Otherwise one transaction
 * under an advisory lock with a bounded lock wait; a failure is logged and
 * retried on the next boot rather than blocking startup.
 */
export async function ensureLedgerIntegrityGuard(pool: Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    if ((await installedVersion(client)) === LEDGER_INTEGRITY_GUARD_VERSION) {
      logger.info("[startup] ✓ Ledger integrity guards already installed");
      return true;
    }
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
    await client.query("SET LOCAL lock_timeout = '10s'");
    for (const statement of LEDGER_INTEGRITY_GUARD_DDL) {
      await client.query(statement);
    }
    await client.query(`COMMENT ON FUNCTION erp_voucher_entry_target_guard() IS '${LEDGER_INTEGRITY_GUARD_VERSION}'`);
    await client.query("COMMIT");
    logger.info("[startup] ✓ Ledger integrity guards ensured");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("[startup] ✗ Ledger integrity guards could not be installed", { error: getErrorMessage(error) });
    return false;
  } finally {
    client.release();
  }
}
