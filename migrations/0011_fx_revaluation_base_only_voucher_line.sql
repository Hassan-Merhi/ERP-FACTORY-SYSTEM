-- 0011_fx_revaluation_base_only_voucher_line.sql
--
-- REQUIRES OWNER SIGN-OFF (accounting behaviour). See the PR description.
--
-- Allow one new kind of voucher line: an unrealized FX revaluation line
-- (rate_convention = 'BASE_ONLY_REVALUATION'). When a company exchange rate is
-- saved, the automatic FX revaluation journal
-- (server/services/accounting/fxRevaluationPosting.ts) brings the USD book
-- value of each foreign-currency cash/bank, customer and loan balance to the
-- new rate. Such a line moves the historical base (USD) amount only; its
-- native amount is zero, so native CFA/ZMW balances never change.
--
-- normalize_voucher_entry_currency_amounts() refused every line whose native
-- amount is zero and required base = native / rate. This migration adds a
-- validated branch for the new convention and changes nothing else in the
-- function: every existing convention follows exactly the same code as before.
--
-- No row is read or changed.

CREATE OR REPLACE FUNCTION public.normalize_voucher_entry_currency_amounts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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

  -- Unrealized FX revaluation line (0011). It changes only the historical
  -- base (USD) value of a foreign-currency balance: the native amount is zero
  -- by definition, so the native/rate = base rule cannot apply to it. The
  -- rate stored on the line is the rate the balance was revalued at.
  IF NEW.rate_convention = 'BASE_ONLY_REVALUATION' THEN
    IF TG_OP = 'UPDATE' AND NOT dual_fields_changed
       AND (NEW.debit_amount IS DISTINCT FROM OLD.debit_amount
            OR NEW.credit_amount IS DISTINCT FROM OLD.credit_amount) THEN
      RAISE EXCEPTION 'An FX revaluation line cannot be edited; delete its voucher instead';
    END IF;
    IF NEW.transaction_currency IS NULL OR UPPER(NEW.transaction_currency) = 'USD' THEN
      RAISE EXCEPTION 'An FX revaluation line needs the foreign currency it revalues';
    END IF;
    IF COALESCE(NEW.transaction_debit_amount, 0) <> 0 OR COALESCE(NEW.transaction_credit_amount, 0) <> 0 THEN
      RAISE EXCEPTION 'An FX revaluation line cannot carry a native amount';
    END IF;
    IF NEW.historical_exchange_rate IS NULL OR NEW.historical_exchange_rate <= 0 THEN
      RAISE EXCEPTION 'An FX revaluation line requires the positive rate it was valued at';
    END IF;
    raw_debit := COALESCE(NEW.base_debit_amount, 0)::numeric;
    raw_credit := COALESCE(NEW.base_credit_amount, 0)::numeric;
    IF raw_debit < 0 OR raw_credit < 0 THEN
      RAISE EXCEPTION 'Voucher entry amounts cannot be negative';
    END IF;
    IF raw_debit > 0 AND raw_credit > 0 THEN
      RAISE EXCEPTION 'Voucher entry cannot contain both a debit and a credit amount';
    END IF;
    IF raw_debit = 0 AND raw_credit = 0 THEN
      RAISE EXCEPTION 'Voucher entry must contain a debit or credit amount';
    END IF;
    NEW.transaction_currency := CASE WHEN UPPER(NEW.transaction_currency) = 'XOF' THEN 'CFA' ELSE UPPER(NEW.transaction_currency) END;
    NEW.transaction_debit_amount := 0;
    NEW.transaction_credit_amount := 0;
    NEW.base_debit_amount := raw_debit;
    NEW.base_credit_amount := raw_credit;
    NEW.debit_amount := raw_debit;
    NEW.credit_amount := raw_credit;
    RETURN NEW;
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
$function$;
