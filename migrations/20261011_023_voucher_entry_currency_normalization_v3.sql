-- Accounting audit phase 23 (DI5/M8), decided by default (owner can override):
-- currency normalization trigger v3. As v2 (20261009_001), and additionally a NEW
-- voucher line (an INSERT, or an UPDATE that changes its currency fields) is refused
-- when its voucher is in a document currency (not the company's base, USD) and the
-- line's currency is neither that currency nor USD (a base-currency voucher may mix
-- line currencies), or when its historical rate (or a CFA voucher's header rate)
-- differs by more than 0.5% from the recorded rate of its convention's store on or
-- before the voucher's date (erp_recorded_rate: exchange_rates for
-- TRANSACTION_PER_BASE, factory_fx_rates for BASE_PER_TRANSACTION; a date with no
-- recorded rate is not checked). Existing rows are not touched: a legacy line whose
-- currency fields are unchanged keeps the exemption, as does a legacy line (no
-- transaction currency yet) normalized at its own historical rate by a reviewed repair.
-- The boot installer (server/services/accounting/currencyNormalizationGuard.ts)
-- installs exactly this definition, versioned 2026-10-11-001-currency-normalization-v3.

CREATE OR REPLACE FUNCTION erp_recorded_rate(p_company_id integer, p_currency text, p_date date, p_convention text)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  WITH aliases AS (
    SELECT CASE WHEN UPPER(p_currency) IN ('CFA', 'XOF') THEN ARRAY['CFA', 'XOF'] ELSE ARRAY[UPPER(p_currency)] END AS codes
  ), company_rate AS (
    SELECT CASE WHEN UPPER(er.from_currency) = 'USD' THEN er.rate::numeric ELSE 1 / NULLIF(er.rate::numeric, 0) END
             AS units_per_usd
      FROM exchange_rates er, aliases a
     WHERE er.company_id = p_company_id
       AND er.effective_date <= p_date
       AND er.rate::numeric > 0
       AND ((UPPER(er.from_currency) = 'USD' AND UPPER(er.to_currency) = ANY (a.codes))
            OR (UPPER(er.to_currency) = 'USD' AND UPPER(er.from_currency) = ANY (a.codes)))
     ORDER BY er.effective_date DESC, CASE WHEN UPPER(er.from_currency) = 'USD' THEN 1 ELSE 0 END DESC, er.id DESC
     LIMIT 1
  ), factory_rate AS (
    SELECT fr.rate_to_usd::numeric AS usd_per_unit
      FROM factory_fx_rates fr, aliases a
     WHERE fr.company_id = p_company_id
       AND fr.effective_date <= p_date
       AND fr.rate_to_usd::numeric > 0
       AND UPPER(fr.currency_code) = ANY (a.codes)
     ORDER BY fr.effective_date DESC, CASE WHEN fr.source = 'manual' THEN 1 ELSE 0 END DESC, fr.id DESC
     LIMIT 1
  )
  SELECT CASE
           WHEN p_convention = 'BASE_PER_TRANSACTION' THEN (SELECT usd_per_unit FROM factory_rate)
           ELSE (SELECT units_per_usd FROM company_rate)
         END
$$;

CREATE OR REPLACE FUNCTION normalize_voucher_entry_currency_amounts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  voucher_currency text;
  voucher_rate numeric(20, 10);
  voucher_company integer;
  voucher_booked_on date;
  company_base text;
  recorded_rate numeric;
  raw_debit numeric(20, 6);
  raw_credit numeric(20, 6);
  expected_base_debit numeric(20, 6);
  expected_base_credit numeric(20, 6);
  dual_fields_changed boolean;
BEGIN
  SELECT UPPER(COALESCE(v.currency, 'USD')), v.exchange_rate::numeric, v.company_id,
         COALESCE(v.effective_date, v.voucher_date)
    INTO voucher_currency, voucher_rate, voucher_company, voucher_booked_on
    FROM vouchers v
   WHERE v.id = NEW.voucher_id;
  IF voucher_currency = 'XOF' THEN
    voucher_currency := 'CFA';
  END IF;

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

    -- v3 (phase 23, DI5/M8): a new or re-currencied line of a voucher in a
    -- document currency is in that currency or the company's base currency
    -- (USD); a base-currency voucher may carry lines of several currencies (a
    -- multi-currency voucher, balanced in base). A converted line's rate is
    -- within 0.5% of the recorded rate of its convention's store on or before
    -- the voucher's date, when one is recorded. Existing lines whose currency
    -- fields are unchanged are exempt (history), and so is a legacy line being
    -- normalized at its own historical rate (OLD.transaction_currency NULL: the
    -- reviewed legacy currency repairs).
    IF TG_OP = 'INSERT' OR (dual_fields_changed AND OLD.transaction_currency IS NOT NULL) THEN
      SELECT UPPER(COALESCE(c.base_currency, 'USD')) INTO company_base FROM companies c WHERE c.id = voucher_company;
      company_base := CASE WHEN COALESCE(company_base, 'USD') = 'XOF' THEN 'CFA' ELSE COALESCE(company_base, 'USD') END;
      IF voucher_currency NOT IN (company_base, 'USD')
         AND NEW.transaction_currency NOT IN (voucher_currency, company_base, 'USD') THEN
        RAISE EXCEPTION
          'VOUCHER_LINE_CURRENCY_MISMATCH: a % line cannot be posted on a % voucher (voucher %)',
          NEW.transaction_currency, voucher_currency, NEW.voucher_id
          USING ERRCODE = '23514';
      END IF;
      IF NEW.rate_convention IN ('TRANSACTION_PER_BASE', 'BASE_PER_TRANSACTION') THEN
        recorded_rate := erp_recorded_rate(voucher_company, NEW.transaction_currency, voucher_booked_on, NEW.rate_convention);
        IF recorded_rate IS NOT NULL AND recorded_rate > 0
           AND abs(NEW.historical_exchange_rate::numeric - recorded_rate) > recorded_rate * 0.005 THEN
          RAISE EXCEPTION
            'VOUCHER_LINE_RATE_MISMATCH: the % rate % of voucher % differs from the recorded rate % on %',
            NEW.transaction_currency, NEW.historical_exchange_rate, NEW.voucher_id, recorded_rate, voucher_booked_on
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;

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
    -- v3 (phase 23, M8): the header rate is checked against the recorded rate too.
    recorded_rate := erp_recorded_rate(voucher_company, 'CFA', voucher_booked_on, 'TRANSACTION_PER_BASE');
    IF recorded_rate IS NOT NULL AND recorded_rate > 0 AND abs(voucher_rate - recorded_rate) > recorded_rate * 0.005 THEN
      RAISE EXCEPTION
        'VOUCHER_LINE_RATE_MISMATCH: the CFA rate % of voucher % differs from the recorded rate % on %',
        voucher_rate, NEW.voucher_id, recorded_rate, voucher_booked_on
        USING ERRCODE = '23514';
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

COMMENT ON FUNCTION normalize_voucher_entry_currency_amounts() IS '2026-10-11-001-currency-normalization-v3';
