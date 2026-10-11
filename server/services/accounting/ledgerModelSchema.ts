/**
 * Phase 23 (chart of accounts and general ledger model): the database part.
 *
 *   - G12: fiscal_period_closure_history (a reopened closure is kept there);
 *   - G6: opening_journal_applications (the reviewed opening journal per company);
 *   - G7: legacy_line_repairs (each repaired legacy line, once);
 *   - C10: bank and fixed-asset codes unique per company, not across companies;
 *   - DI3 (decided by default: customer_balances, factory supplier payments,
 *     inventory movements, payroll, rental payments, sales cost): BEFORE
 *     triggers that refuse a write dated in a closed fiscal period on the
 *     sub-ledgers, as the closed-period guard does on vouchers and lines.
 *
 * The sub-ledger lock reuses the closed-period guard's functions
 * (erp_assert_accounting_date_open, erp_assert_voucher_open and its only
 * bypass, the fiscal reopen's transaction-local override), so it must be
 * installed after ensureClosedPeriodGuard. An update that changes none of a
 * table's financial columns (a note, a status that posts nothing) passes, as
 * on vouchers. Existing rows are never changed.
 *
 * Pattern of the other guards: versioned (a COMMENT on the trigger function),
 * idempotent, one transaction under an advisory lock with a lock timeout,
 * fatal on failure (serving writes without the sub-ledger lock would let a
 * closed period's sub-ledgers change). A table missing on an old schema is
 * skipped with a warning.
 */
import type { Pool } from "pg";

import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

export const LEDGER_MODEL_SCHEMA_VERSION = "2026-10-11-phase23-ledger-model-v2";
export const SUB_LEDGER_PERIOD_GUARD_FUNCTION = "erp_sub_ledger_period_guard";
export const subLedgerPeriodTriggerName = (table: string) => `${table}_closed_period_guard`;

/**
 * The sub-ledgers under the period lock: how each row is dated and which
 * columns are financial. The date is a column of the row, or
 * `voucher:<column>` (the row's voucher's dates), or `payroll_run:<column>`
 * (the run's date).
 */
export const SUB_LEDGER_PERIOD_LOCK: readonly { table: string; dateOf: string; financial: readonly string[] }[] = [
  {
    table: "customer_balances",
    dateOf: "transaction_date",
    // `balance` is the running total recomputed after any posting (a memo of
    // the engine): it is derived, so a recompute that rewrites it is allowed.
    financial: ["company_id", "customer_id", "transaction_date", "debit_amount", "credit_amount", "currency"],
  },
  {
    table: "factory_supplier_payments",
    dateOf: "date",
    financial: [
      "company_id",
      "supplier_id",
      "date",
      "amount",
      "currency_code",
      "fx_rate_to_usd",
      "amount_usd",
      "paid_from_account_id",
      "deleted_at",
    ],
  },
  {
    table: "inventory_value_movements",
    dateOf: "movement_date",
    financial: ["company_id", "movement_date", "stock_item_id", "location_id", "quantity_delta", "value_delta"],
  },
  {
    table: "canonical_stock_movements",
    dateOf: "occurred_at",
    financial: ["company_id", "stock_item_id", "location_id", "quantity_delta", "unit_cost", "occurred_at"],
  },
  {
    table: "erp_payroll_runs",
    dateOf: "date",
    financial: ["company_id", "date", "status", "payment_account_id"],
  },
  {
    table: "erp_payroll_run_items",
    dateOf: "payroll_run:run_id",
    financial: ["run_id", "employee_id", "base_salary", "deduction", "payroll_deduction", "net_pay"],
  },
  {
    table: "factory_payrolls",
    dateOf: "period_end",
    financial: [
      "company_id",
      "worker_id",
      "period_start",
      "period_end",
      "base_salary",
      "bale_earnings",
      "kg_earnings",
      "overtime_pay",
      "bonuses",
      "transport",
      "deductions",
      "advances",
      "net_salary",
    ],
  },
  {
    table: "property_payments",
    dateOf: "payment_date",
    financial: [
      "company_id",
      "contract_id",
      "amount",
      "payment_date",
      "currency",
      "exchange_rate",
      "posting_status",
      "voucher_id",
    ],
  },
  {
    table: "sales_items",
    dateOf: "voucher:voucher_id",
    financial: [
      "voucher_id",
      "stock_item_id",
      "quantity",
      "selling_price",
      "cost_price",
      "total_sales",
      "total_cost",
      "profit",
      "value_moved",
    ],
  },
];

const SAFE_IDENTIFIER = /^[a-z_]+(?::[a-z_]+)?$/;
for (const entry of SUB_LEDGER_PERIOD_LOCK) {
  for (const name of [entry.table, entry.dateOf, ...entry.financial]) {
    if (!SAFE_IDENTIFIER.test(name)) throw new Error("ledger_model_unsafe_identifier");
  }
}

/**
 * v2 (phases 23–29 integration, G7 under row-level security): which company
 * owns each of the given ledger account ids, and whether it is deleted — and
 * nothing else. The legacy line plan runs in its company's tenant scope, where
 * RLS hides another company's accounts, so a line on another company's account
 * looked like a line on a missing account (orphan) and would have been
 * "restored" as a placeholder. The function turns the maintenance scope on for
 * its one read and puts the caller's setting back before it returns, so the
 * probe cannot widen anything else in the caller's transaction (an error
 * aborts the transaction anyway).
 */
export const LEDGER_ACCOUNT_OWNERS_FUNCTION_DDL = `CREATE OR REPLACE FUNCTION erp_ledger_account_owners(p_ids integer[])
RETURNS TABLE (account_id integer, company_id integer, deleted boolean)
LANGUAGE plpgsql
VOLATILE
AS $owners$
DECLARE
  previous_maintenance text := current_setting('app.company_scope_maintenance', true);
BEGIN
  PERFORM set_config('app.company_scope_maintenance', 'on', true);
  RETURN QUERY
    SELECT la.id, la.company_id, la.deleted_at IS NOT NULL
      FROM ledger_accounts la
     WHERE la.id = ANY (p_ids);
  PERFORM set_config('app.company_scope_maintenance', COALESCE(previous_maintenance, 'off'), true);
END
$owners$`;

/**
 * v2 (phases 23–29 integration, phase 22 numbering under row-level security):
 * whether a voucher number is held anywhere (the unique constraint on
 * voucher_number is global) or was the company's own before a retirement. The
 * allocator runs in the posting company's tenant scope, where RLS hides other
 * companies' vouchers, so it could hand out a number another company holds and
 * the posting would fail on the unique constraint. Same narrow pattern as
 * erp_ledger_account_owners: a yes/no answer, the caller's scope restored.
 */
export const VOUCHER_NUMBER_TAKEN_FUNCTION_DDL = `CREATE OR REPLACE FUNCTION erp_voucher_number_taken(p_number text, p_company_id integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $taken$
DECLARE
  previous_maintenance text := current_setting('app.company_scope_maintenance', true);
  taken boolean;
BEGIN
  PERFORM set_config('app.company_scope_maintenance', 'on', true);
  SELECT EXISTS (
    SELECT 1 FROM vouchers v
     WHERE v.voucher_number = p_number
        OR (v.company_id = p_company_id AND v.original_voucher_number = p_number)
  ) INTO taken;
  PERFORM set_config('app.company_scope_maintenance', COALESCE(previous_maintenance, 'off'), true);
  RETURN taken;
END
$taken$`;

export const LEDGER_MODEL_TABLES_DDL: readonly string[] = [
  LEDGER_ACCOUNT_OWNERS_FUNCTION_DDL,
  VOUCHER_NUMBER_TAKEN_FUNCTION_DDL,
  `CREATE TABLE IF NOT EXISTS fiscal_period_closure_history (
     id serial PRIMARY KEY,
     closure_id integer NOT NULL,
     company_id integer NOT NULL,
     period_start_date date NOT NULL,
     period_end_date date NOT NULL,
     closing_voucher_id integer,
     retained_earnings_account_id integer,
     closed_by_user_id text,
     closed_at timestamp,
     reopened_by_user_id text,
     reopened_at timestamp NOT NULL DEFAULT now(),
     reason text,
     closure jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS fiscal_period_closure_history_company_idx
     ON fiscal_period_closure_history (company_id, period_end_date)`,
  `CREATE TABLE IF NOT EXISTS opening_journal_applications (
     id serial PRIMARY KEY,
     company_id integer NOT NULL,
     cut_over_date date NOT NULL,
     voucher_id integer,
     plan_hash text NOT NULL,
     status text NOT NULL DEFAULT 'APPLIED',
     snapshot jsonb NOT NULL,
     applied_by_user_id text,
     applied_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS opening_journal_applications_company_unique
     ON opening_journal_applications (company_id)`,
  `CREATE TABLE IF NOT EXISTS legacy_line_repairs (
     id serial PRIMARY KEY,
     company_id integer NOT NULL,
     entry_id integer NOT NULL,
     kind text NOT NULL,
     repair_voucher_id integer,
     target_ledger_account_id integer,
     placeholder_ledger_account_id integer,
     plan_hash text NOT NULL,
     applied_by_user_id text,
     applied_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS legacy_line_repairs_entry_unique ON legacy_line_repairs (entry_id)`,
  `CREATE INDEX IF NOT EXISTS legacy_line_repairs_company_idx ON legacy_line_repairs (company_id)`,
  // C10: codes unique per company. The single-column unique constraint (any
  // name) is replaced by a (company_id, code) unique index; existing codes are
  // globally unique already, so the new index cannot fail on them.
  ...(["bank_accounts", "fixed_assets"] as const).map(
    (table) => `DO $c10$
   DECLARE
     constraint_name text;
   BEGIN
     FOR constraint_name IN
       SELECT c.conname FROM pg_constraint c
        WHERE c.conrelid = '${table}'::regclass AND c.contype = 'u'
          AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                 WHERE a.attrelid = '${table}'::regclass AND a.attname = 'code')]::int2[]
     LOOP
       EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', constraint_name);
     END LOOP;
     CREATE UNIQUE INDEX IF NOT EXISTS ${table}_company_code_unique ON ${table} (company_id, code);
   END $c10$`
  ),
];

export const SUB_LEDGER_PERIOD_LOCK_DDL: readonly string[] = [
  `CREATE OR REPLACE FUNCTION erp_try_date(p_value text) RETURNS date
   LANGUAGE plpgsql IMMUTABLE AS $fn$
   BEGIN
     IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN NULL; END IF;
     RETURN substring(btrim(p_value) FROM 1 FOR 10)::date;
   EXCEPTION WHEN others THEN
     RETURN NULL;
   END $fn$`,
  `CREATE OR REPLACE FUNCTION erp_assert_sub_ledger_row_open(p_date_of text, p_row jsonb) RETURNS void
   LANGUAGE plpgsql AS $fn$
   DECLARE
     source_column text;
     run_company integer;
     run_date date;
   BEGIN
     IF p_row IS NULL THEN RETURN; END IF;
     IF p_date_of LIKE 'voucher:%' THEN
       source_column := split_part(p_date_of, ':', 2);
       PERFORM erp_assert_voucher_open(NULLIF(p_row->>source_column, '')::integer);
     ELSIF p_date_of LIKE 'payroll_run:%' THEN
       source_column := split_part(p_date_of, ':', 2);
       SELECT r.company_id, erp_try_date(r.date) INTO run_company, run_date
         FROM erp_payroll_runs r WHERE r.id = NULLIF(p_row->>source_column, '')::integer;
       PERFORM erp_assert_accounting_date_open(run_company, run_date);
     ELSE
       PERFORM erp_assert_accounting_date_open(NULLIF(p_row->>'company_id', '')::integer,
                                               erp_try_date(p_row->>p_date_of));
     END IF;
   END $fn$`,
  `CREATE OR REPLACE FUNCTION ${SUB_LEDGER_PERIOD_GUARD_FUNCTION}() RETURNS trigger
   LANGUAGE plpgsql AS $fn$
   DECLARE
     date_of text := TG_ARGV[0];
     financial text[] := string_to_array(TG_ARGV[1], ',');
     new_row jsonb;
     old_row jsonb;
     column_name text;
     changed boolean := false;
   BEGIN
     IF erp_closed_period_guard_bypassed() THEN
       IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
       RETURN NEW;
     END IF;
     IF TG_OP IN ('UPDATE', 'DELETE') THEN old_row := to_jsonb(OLD); END IF;
     IF TG_OP IN ('UPDATE', 'INSERT') THEN new_row := to_jsonb(NEW); END IF;
     IF TG_OP = 'UPDATE' THEN
       FOREACH column_name IN ARRAY financial LOOP
         IF (new_row -> column_name) IS DISTINCT FROM (old_row -> column_name) THEN
           changed := true;
           EXIT;
         END IF;
       END LOOP;
       IF NOT changed THEN RETURN NEW; END IF;
     END IF;
     PERFORM erp_assert_sub_ledger_row_open(date_of, old_row);
     PERFORM erp_assert_sub_ledger_row_open(date_of, new_row);
     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END $fn$`,
  ...SUB_LEDGER_PERIOD_LOCK.map(
    ({ table, dateOf, financial }) => `DO $lock$
   BEGIN
     IF to_regclass('${table}') IS NULL THEN
       RAISE WARNING 'Sub-ledger period lock not installed on %: the table is missing', '${table}';
       RETURN;
     END IF;
     DROP TRIGGER IF EXISTS ${subLedgerPeriodTriggerName(table)} ON ${table};
     CREATE TRIGGER ${subLedgerPeriodTriggerName(table)}
       BEFORE INSERT OR UPDATE OR DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${SUB_LEDGER_PERIOD_GUARD_FUNCTION}('${dateOf}', '${financial.join(",")}');
   END $lock$`
  ),
];

const INSTALL_LOCK_KEY = 2026_10_230;

type Queryable = { query: Pool["query"] };

/** The installed version, or null when the function or a table's trigger is missing. */
export async function installedLedgerModelSchemaVersion(client: Queryable): Promise<string | null> {
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(to_regprocedure('${SUB_LEDGER_PERIOD_GUARD_FUNCTION}()'), 'pg_proc') AS version
      WHERE to_regclass('fiscal_period_closure_history') IS NOT NULL
        AND to_regclass('opening_journal_applications') IS NOT NULL
        AND to_regclass('legacy_line_repairs') IS NOT NULL
        AND to_regclass('bank_accounts_company_code_unique') IS NOT NULL
        AND to_regclass('fixed_assets_company_code_unique') IS NOT NULL
        AND (SELECT COUNT(DISTINCT t.tgname) FROM pg_trigger t
              WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]))
            = (SELECT COUNT(*) FROM unnest($2::text[]) AS tables(name) WHERE to_regclass(tables.name) IS NOT NULL)`,
    [
      SUB_LEDGER_PERIOD_LOCK.map(({ table }) => subLedgerPeriodTriggerName(table)),
      SUB_LEDGER_PERIOD_LOCK.map(({ table }) => table),
    ]
  );
  return result.rows[0]?.version ?? null;
}

/**
 * Installs the phase 23 tables, the per-company code indexes and the
 * sub-ledger period lock on every boot (after the closed-period guard).
 * Fatal on failure.
 */
export async function ensureLedgerModelSchema(pool: Pick<Pool, "connect">): Promise<true> {
  const client = await pool.connect();
  try {
    if ((await installedLedgerModelSchemaVersion(client)) === LEDGER_MODEL_SCHEMA_VERSION) {
      logger.info(`[startup] ✓ Ledger model schema already installed (${LEDGER_MODEL_SCHEMA_VERSION})`);
      return true;
    }
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
    for (const statement of [...LEDGER_MODEL_TABLES_DDL, ...SUB_LEDGER_PERIOD_LOCK_DDL]) {
      await client.query(statement);
    }
    await client.query(`COMMENT ON FUNCTION ${SUB_LEDGER_PERIOD_GUARD_FUNCTION}() IS '${LEDGER_MODEL_SCHEMA_VERSION}'`);
    await client.query("COMMIT");
    logger.info(`[startup] ✓ Ledger model schema ensured (${LEDGER_MODEL_SCHEMA_VERSION})`);
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("[startup] ✗ Ledger model schema could not be installed; refusing to start", {
      version: LEDGER_MODEL_SCHEMA_VERSION,
      error: getErrorMessage(error),
    });
    throw error;
  } finally {
    client.release();
  }
}
