import type { Pool } from "pg";

import { logger } from "../../lib/logger";
import { getErrorMessage } from "../../lib/httpHandlers";

/**
 * Voucher-entry currency normalization trigger (accounting audit wave 14,
 * owner decision 4).
 *
 * migrations/20260720_005_voucher_entry_currency_normalization_trigger.sql
 * defines `normalize_voucher_entry_currency_amounts()` and the BEFORE trigger
 * `voucher_entries_normalize_currency_before_write`. Production has it; the
 * test database and CI never did, so every test ran against a ledger shape
 * production refuses or rewrites (a zero line, a debit and a credit on one
 * line, native/base amounts that contradict their rate, and the legacy USD/CFA
 * insert that the trigger converts). It is now installed at every boot by this
 * installer, with exactly the migration's definition (pinned by
 * tests/wave14-currency.test.ts), so CI and tests run against it. Since wave
 * 17 D the definition is CURRENCY_NORMALIZATION_MIGRATION (v2).
 *
 * Pattern of the other guards: idempotent (skipped when the version comment
 * and the trigger are present), one transaction under an advisory lock with a
 * lock timeout, versioned by a COMMENT on the function, fatal on failure. A
 * required column missing on a freshly pushed schema skips the install with a
 * warning instead (the integrity diagnostic's database_guards_installed then
 * lists the trigger as missing).
 */

/** Bump whenever the definition below changes (and add a migration for it). */
export const CURRENCY_NORMALIZATION_GUARD_VERSION = "2026-10-09-001-currency-normalization-v2";

/**
 * The migration holding the current definition. v1 is
 * migrations/20260720_005 (USD/CFA normalized, other currencies left
 * unresolved). v2 (wave 17 D, owner decision 1 of 2026-10-09) refuses a new
 * line of any other currency without its transaction_* amounts; existing rows
 * are untouched.
 */
export const CURRENCY_NORMALIZATION_MIGRATION = "migrations/20261009_001_voucher_entry_currency_normalization_v2.sql";

export const CURRENCY_NORMALIZATION_TRIGGER = "voucher_entries_normalize_currency_before_write";
export const CURRENCY_NORMALIZATION_FUNCTION = "normalize_voucher_entry_currency_amounts";

/** Columns the function reads or writes, by table. */
export const CURRENCY_NORMALIZATION_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  vouchers: ["id", "currency", "exchange_rate"],
  voucher_entries: [
    "voucher_id",
    "debit_amount",
    "credit_amount",
    "transaction_currency",
    "transaction_debit_amount",
    "transaction_credit_amount",
    "base_debit_amount",
    "base_credit_amount",
    "historical_exchange_rate",
    "rate_convention",
  ],
};

/** The function, verbatim from CURRENCY_NORMALIZATION_MIGRATION. */
export const CURRENCY_NORMALIZATION_FUNCTION_DDL = `CREATE OR REPLACE FUNCTION normalize_voucher_entry_currency_amounts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  voucher_currency text;
  voucher_rate numeric(20, 10);
  raw_debit numeric(20, 6);
  raw_credit numeric(20, 6);
  expected_base_debit numeric(20, 6);
  expected_base_credit numeric(20, 6);
  dual_fields_changed boolean;
BEGIN
  SELECT UPPER(COALESCE(v.currency, 'USD')), v.exchange_rate::numeric
    INTO voucher_currency, voucher_rate
    FROM vouchers v
   WHERE v.id = NEW.voucher_id;

  IF voucher_currency IS NULL THEN
    RAISE EXCEPTION 'Voucher % not found while normalizing voucher entry', NEW.voucher_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    dual_fields_changed := true;
  ELSE
    dual_fields_changed :=
      NEW.transaction_currency IS DISTINCT FROM OLD.transaction_currency
      OR NEW.transaction_debit_amount IS DISTINCT FROM OLD.transaction_debit_amount
      OR NEW.transaction_credit_amount IS DISTINCT FROM OLD.transaction_credit_amount
      OR NEW.base_debit_amount IS DISTINCT FROM OLD.base_debit_amount
      OR NEW.base_credit_amount IS DISTINCT FROM OLD.base_credit_amount
      OR NEW.historical_exchange_rate IS DISTINCT FROM OLD.historical_exchange_rate
      OR NEW.rate_convention IS DISTINCT FROM OLD.rate_convention;
  END IF;

  -- Legacy update callers still submit debit_amount/credit_amount. Once a row is
  -- normalized, interpret those changed values as NEW transaction-currency amounts
  -- and recompute historical base using the row's already locked rate/convention.
  IF TG_OP = 'UPDATE'
     AND OLD.transaction_currency IS NOT NULL
     AND NOT dual_fields_changed
     AND (NEW.debit_amount IS DISTINCT FROM OLD.debit_amount
          OR NEW.credit_amount IS DISTINCT FROM OLD.credit_amount) THEN
    raw_debit := COALESCE(NEW.debit_amount, 0)::numeric;
    raw_credit := COALESCE(NEW.credit_amount, 0)::numeric;

    IF raw_debit < 0 OR raw_credit < 0 THEN
      RAISE EXCEPTION 'Voucher entry amounts cannot be negative';
    END IF;
    IF raw_debit > 0 AND raw_credit > 0 THEN
      RAISE EXCEPTION 'Voucher entry cannot contain both a debit and a credit amount';
    END IF;
    IF raw_debit = 0 AND raw_credit = 0 THEN
      RAISE EXCEPTION 'Voucher entry must contain a debit or credit amount';
    END IF;

    NEW.transaction_currency := CASE WHEN UPPER(OLD.transaction_currency) = 'XOF' THEN 'CFA' ELSE UPPER(OLD.transaction_currency) END;
    NEW.transaction_debit_amount := raw_debit;
    NEW.transaction_credit_amount := raw_credit;
    NEW.historical_exchange_rate := OLD.historical_exchange_rate;
    NEW.rate_convention := OLD.rate_convention;

    IF NEW.rate_convention = 'IDENTITY' THEN
      NEW.base_debit_amount := raw_debit;
      NEW.base_credit_amount := raw_credit;
    ELSIF NEW.rate_convention = 'TRANSACTION_PER_BASE' THEN
      IF NEW.historical_exchange_rate IS NULL OR NEW.historical_exchange_rate <= 0 THEN
        RAISE EXCEPTION 'TRANSACTION_PER_BASE requires a positive historical rate';
      END IF;
      NEW.base_debit_amount := ROUND(raw_debit / NEW.historical_exchange_rate, 6);
      NEW.base_credit_amount := ROUND(raw_credit / NEW.historical_exchange_rate, 6);
    ELSIF NEW.rate_convention = 'BASE_PER_TRANSACTION' THEN
      IF NEW.historical_exchange_rate IS NULL OR NEW.historical_exchange_rate <= 0 THEN
        RAISE EXCEPTION 'BASE_PER_TRANSACTION requires a positive historical rate';
      END IF;
      NEW.base_debit_amount := ROUND(raw_debit * NEW.historical_exchange_rate, 6);
      NEW.base_credit_amount := ROUND(raw_credit * NEW.historical_exchange_rate, 6);
    ELSE
      RAISE EXCEPTION 'Unknown voucher-entry rate convention %', NEW.rate_convention;
    END IF;

    NEW.debit_amount := NEW.base_debit_amount;
    NEW.credit_amount := NEW.base_credit_amount;
    RETURN NEW;
  END IF;

  -- Fully normalized application paths remain authoritative, but their fields
  -- are validated so contradictory native/base values cannot be persisted.
  IF NEW.transaction_currency IS NOT NULL
     AND NEW.transaction_debit_amount IS NOT NULL
     AND NEW.transaction_credit_amount IS NOT NULL
     AND NEW.base_debit_amount IS NOT NULL
     AND NEW.base_credit_amount IS NOT NULL
     AND NEW.historical_exchange_rate IS NOT NULL
     AND NEW.rate_convention IS NOT NULL THEN
    NEW.transaction_currency := CASE WHEN UPPER(NEW.transaction_currency) = 'XOF' THEN 'CFA' ELSE UPPER(NEW.transaction_currency) END;
    raw_debit := NEW.transaction_debit_amount::numeric;
    raw_credit := NEW.transaction_credit_amount::numeric;

    IF raw_debit < 0 OR raw_credit < 0 THEN
      RAISE EXCEPTION 'Voucher entry amounts cannot be negative';
    END IF;
    IF raw_debit > 0 AND raw_credit > 0 THEN
      RAISE EXCEPTION 'Voucher entry cannot contain both a debit and a credit amount';
    END IF;
    IF raw_debit = 0 AND raw_credit = 0 THEN
      RAISE EXCEPTION 'Voucher entry must contain a debit or credit amount';
    END IF;

    IF NEW.rate_convention = 'IDENTITY' THEN
      expected_base_debit := raw_debit;
      expected_base_credit := raw_credit;
    ELSIF NEW.rate_convention = 'TRANSACTION_PER_BASE' THEN
      IF NEW.historical_exchange_rate <= 0 THEN
        RAISE EXCEPTION 'TRANSACTION_PER_BASE requires a positive historical rate';
      END IF;
      expected_base_debit := ROUND(raw_debit / NEW.historical_exchange_rate, 6);
      expected_base_credit := ROUND(raw_credit / NEW.historical_exchange_rate, 6);
    ELSIF NEW.rate_convention = 'BASE_PER_TRANSACTION' THEN
      IF NEW.historical_exchange_rate <= 0 THEN
        RAISE EXCEPTION 'BASE_PER_TRANSACTION requires a positive historical rate';
      END IF;
      expected_base_debit := ROUND(raw_debit * NEW.historical_exchange_rate, 6);
      expected_base_credit := ROUND(raw_credit * NEW.historical_exchange_rate, 6);
    ELSE
      RAISE EXCEPTION 'Unknown voucher-entry rate convention %', NEW.rate_convention;
    END IF;

    IF ROUND(NEW.base_debit_amount::numeric, 6) <> expected_base_debit
       OR ROUND(NEW.base_credit_amount::numeric, 6) <> expected_base_credit THEN
      RAISE EXCEPTION
        'Voucher entry native/base amounts do not match the historical rate and convention';
    END IF;

    NEW.debit_amount := expected_base_debit;
    NEW.credit_amount := expected_base_credit;
    RETURN NEW;
  END IF;

  -- Unnormalized legacy insertion/update: the legacy debit/credit values are
  -- interpreted as the original transaction-currency values for USD/CFA only.
  raw_debit := COALESCE(NEW.debit_amount, 0)::numeric;
  raw_credit := COALESCE(NEW.credit_amount, 0)::numeric;

  IF raw_debit < 0 OR raw_credit < 0 THEN
    RAISE EXCEPTION 'Voucher entry amounts cannot be negative';
  END IF;
  IF raw_debit > 0 AND raw_credit > 0 THEN
    RAISE EXCEPTION 'Voucher entry cannot contain both a debit and a credit amount';
  END IF;
  IF raw_debit = 0 AND raw_credit = 0 THEN
    RAISE EXCEPTION 'Voucher entry must contain a debit or credit amount';
  END IF;

  IF voucher_currency = 'USD' THEN
    NEW.transaction_currency := 'USD';
    NEW.transaction_debit_amount := raw_debit;
    NEW.transaction_credit_amount := raw_credit;
    NEW.base_debit_amount := raw_debit;
    NEW.base_credit_amount := raw_credit;
    NEW.historical_exchange_rate := 1.0000000000;
    NEW.rate_convention := 'IDENTITY';
    NEW.debit_amount := raw_debit;
    NEW.credit_amount := raw_credit;
    RETURN NEW;
  END IF;

  IF voucher_currency IN ('CFA', 'XOF') THEN
    IF voucher_rate IS NULL OR voucher_rate <= 0 THEN
      RAISE EXCEPTION 'CFA voucher % requires a positive historical exchange rate', NEW.voucher_id;
    END IF;
    NEW.transaction_currency := 'CFA';
    NEW.transaction_debit_amount := raw_debit;
    NEW.transaction_credit_amount := raw_credit;
    NEW.base_debit_amount := ROUND(raw_debit / voucher_rate, 6);
    NEW.base_credit_amount := ROUND(raw_credit / voucher_rate, 6);
    NEW.historical_exchange_rate := voucher_rate;
    NEW.rate_convention := 'TRANSACTION_PER_BASE';
    NEW.debit_amount := NEW.base_debit_amount;
    NEW.credit_amount := NEW.base_credit_amount;
    RETURN NEW;
  END IF;

  -- Any other currency needs its native amounts, historical rate and convention
  -- from the caller (several factory/supplier rate conventions exist, so the
  -- trigger never guesses one). A NEW line without them (an INSERT, or an UPDATE
  -- that changes its voucher, amounts or transaction currency) is refused. An
  -- existing legacy line whose voucher and amounts are unchanged is left as it is.
  IF TG_OP = 'UPDATE'
     AND NEW.voucher_id IS NOT DISTINCT FROM OLD.voucher_id
     AND NEW.debit_amount IS NOT DISTINCT FROM OLD.debit_amount
     AND NEW.credit_amount IS NOT DISTINCT FROM OLD.credit_amount
     AND NEW.transaction_currency IS NOT DISTINCT FROM OLD.transaction_currency THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'VOUCHER_LINE_NATIVE_AMOUNT_REQUIRED: a % voucher line (voucher %) needs its transaction-currency amounts, historical rate and rate convention',
    voucher_currency, NEW.voucher_id
    USING ERRCODE = '23514';
END;
$$`;

/** The trigger, verbatim from CURRENCY_NORMALIZATION_MIGRATION (unchanged since 20260720_005). */
export const CURRENCY_NORMALIZATION_TRIGGER_DDL = `CREATE TRIGGER voucher_entries_normalize_currency_before_write
BEFORE INSERT OR UPDATE OF
  voucher_id,
  debit_amount,
  credit_amount,
  transaction_currency,
  transaction_debit_amount,
  transaction_credit_amount,
  base_debit_amount,
  base_credit_amount,
  historical_exchange_rate,
  rate_convention
ON voucher_entries
FOR EACH ROW
EXECUTE FUNCTION normalize_voucher_entry_currency_amounts()`;

export const CURRENCY_NORMALIZATION_DDL: readonly string[] = [
  CURRENCY_NORMALIZATION_FUNCTION_DDL,
  "DROP TRIGGER IF EXISTS voucher_entries_normalize_currency_before_insert ON voucher_entries",
  `DROP TRIGGER IF EXISTS ${CURRENCY_NORMALIZATION_TRIGGER} ON voucher_entries`,
  CURRENCY_NORMALIZATION_TRIGGER_DDL,
  `COMMENT ON FUNCTION ${CURRENCY_NORMALIZATION_FUNCTION}() IS '${CURRENCY_NORMALIZATION_GUARD_VERSION}'`,
];

const INSTALL_LOCK_KEY = 2026_10_140;

type Queryable = { query: Pool["query"] };

/**
 * The installed version, or null when the trigger is missing, disabled or not
 * bound to the function (a catalogue read).
 */
export async function installedCurrencyNormalizationVersion(client: Queryable): Promise<string | null> {
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(p.oid, 'pg_proc') AS version
       FROM pg_trigger t
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = to_regclass('voucher_entries')
        AND t.tgname = $1
        AND NOT t.tgisinternal
        AND t.tgenabled <> 'D'
        AND p.proname = $2`,
    [CURRENCY_NORMALIZATION_TRIGGER, CURRENCY_NORMALIZATION_FUNCTION]
  );
  return result.rows[0]?.version ?? null;
}

/** Required columns that do not exist, as `table.column`. */
async function missingRequiredColumns(client: Queryable): Promise<string[]> {
  const wanted = Object.entries(CURRENCY_NORMALIZATION_REQUIRED_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column) => `${table}.${column}`)
  );
  const result = await client.query<{ name: string }>(
    `SELECT table_name || '.' || column_name AS name
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND (table_name || '.' || column_name) = ANY($1::text[])`,
    [wanted]
  );
  const present = new Set(result.rows.map((row) => row.name));
  return wanted.filter((name) => !present.has(name));
}

/**
 * Installs the trigger on every boot. Returns true when it is installed at
 * the current version, false when a required column is missing (warned).
 * Throws (fatal at boot) on any other failure.
 */
export async function ensureCurrencyNormalizationGuard(pool: Pick<Pool, "connect">): Promise<boolean> {
  const client = await pool.connect();
  try {
    if ((await installedCurrencyNormalizationVersion(client)) === CURRENCY_NORMALIZATION_GUARD_VERSION) {
      logger.info(
        `[startup] ✓ Currency normalization trigger already installed (${CURRENCY_NORMALIZATION_GUARD_VERSION})`
      );
      return true;
    }
    const missing = await missingRequiredColumns(client);
    if (missing.length) {
      logger.warn("[startup] Currency normalization trigger not installed: required columns are missing", {
        missing,
      });
      return false;
    }
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [INSTALL_LOCK_KEY]);
    for (const statement of CURRENCY_NORMALIZATION_DDL) {
      await client.query(statement);
    }
    await client.query("COMMIT");
    logger.info(`[startup] ✓ Currency normalization trigger ensured (${CURRENCY_NORMALIZATION_GUARD_VERSION})`);
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("[startup] ✗ Currency normalization trigger could not be installed; refusing to start", {
      version: CURRENCY_NORMALIZATION_GUARD_VERSION,
      error: getErrorMessage(error),
    });
    // Fatal: the caller (server/index.ts) aborts startup; the log above says why.
    throw error;
  } finally {
    client.release();
  }
}
