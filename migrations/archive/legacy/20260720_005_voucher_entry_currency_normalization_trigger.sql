-- Enforce dual-currency storage for every NEW USD/CFA voucher entry, including
-- legacy posting routes that still insert debit_amount/credit_amount directly.
-- Historical rows are not touched; use the explicit dry-run backfill tool for them.

CREATE OR REPLACE FUNCTION normalize_voucher_entry_currency_amounts()
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

  -- Other currencies remain explicitly unresolved. They use several established
  -- factory/supplier rate conventions, so this trigger must neither guess nor block
  -- those flows. Leave the dual-currency fields NULL until the caller supplies a
  -- complete historical rate and convention.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS voucher_entries_normalize_currency_before_insert ON voucher_entries;
DROP TRIGGER IF EXISTS voucher_entries_normalize_currency_before_write ON voucher_entries;
CREATE TRIGGER voucher_entries_normalize_currency_before_write
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
EXECUTE FUNCTION normalize_voucher_entry_currency_amounts();
