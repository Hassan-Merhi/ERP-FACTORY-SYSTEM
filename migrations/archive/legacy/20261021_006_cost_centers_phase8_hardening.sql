-- Phase 8: append-only integrity hardening. No data writes/backfills.
-- Protect voucher reversal/intercompany exclusions and independently sourced
-- Factory expense daybook rows in the database, not only the application UI.

-- Both halves of a reversal pair are excluded from cost-center attribution.
-- Correction reversals set vouchers.reversal_of_voucher_id; the exact-reversal
-- endpoint links through its posting identity (accounting_posting_requests,
-- source_type 'voucher-reversal', source_id = original voucher id).
CREATE OR REPLACE FUNCTION cost_center_voucher_in_reversal_pair(p_voucher_id INTEGER)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $cc_reversal_pair$
  SELECT EXISTS (
    SELECT 1 FROM vouchers v
    WHERE v.id = p_voucher_id AND (
      v.reversal_of_voucher_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM vouchers rev
        WHERE rev.reversal_of_voucher_id = v.id AND rev.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM accounting_posting_requests apr
        WHERE apr.voucher_id = v.id AND apr.source_type = 'voucher-reversal')
      OR EXISTS (SELECT 1 FROM accounting_posting_requests apr
        JOIN vouchers rev ON rev.id = apr.voucher_id AND rev.deleted_at IS NULL
        WHERE apr.company_id = v.company_id AND apr.source_type = 'voucher-reversal'
          AND apr.source_id = v.id::text)
    )
  )
$cc_reversal_pair$;

CREATE OR REPLACE FUNCTION cost_center_allocation_eligibility_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_eligibility$
DECLARE
  active_center BOOLEAN;
  parent_voucher RECORD;
  daybook_type TEXT;
  daybook_reference TEXT;
  daybook_reference_id INTEGER;
  daybook_amount NUMERIC;
  daybook_usd NUMERIC;
BEGIN
  SELECT active INTO active_center FROM cost_centers
    WHERE id=NEW.cost_center_id AND company_id=NEW.company_id;
  IF active_center IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Cannot allocate to missing or archived cost center';
  END IF;

  IF NEW.voucher_entry_id IS NOT NULL THEN
    SELECT la.account_type, la.code AS account_code, ve.debit_amount, ve.credit_amount, v.voucher_number, v.source_module, v.optional, v.deleted_at
      INTO parent_voucher
    FROM voucher_entries ve
    JOIN vouchers v ON v.id=ve.voucher_id
    LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=ve.company_id
    WHERE ve.id=NEW.voucher_entry_id AND ve.company_id=NEW.company_id
      AND v.company_id=NEW.company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Voucher entry is unavailable for cost allocation';
    END IF;
    IF parent_voucher.voucher_number IS NULL OR parent_voucher.deleted_at IS NOT NULL
       OR parent_voucher.optional = TRUE
       OR parent_voucher.voucher_number LIKE 'GC-%'
       OR parent_voucher.voucher_number LIKE 'MIG-%'
       OR parent_voucher.source_module = 'SP_MIGRATION_READONLY'
       OR upper(coalesce(parent_voucher.source_module,'')) LIKE 'INTERCOMPANY%'
       OR cost_center_voucher_in_reversal_pair(
         (SELECT ve.voucher_id FROM voucher_entries ve WHERE ve.id=NEW.voucher_entry_id)
       ) THEN
      RAISE EXCEPTION 'Protected, optional, deleted or migrated vouchers cannot be allocated';
    END IF;
    IF upper(btrim(parent_voucher.account_type)) IN ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE') THEN
      IF NEW.cost_treatment <> 'EXPENSE' THEN
        RAISE EXCEPTION 'Expense ledger lines must keep EXPENSE cost treatment';
      END IF;
    ELSIF upper(btrim(parent_voucher.account_type)) = 'ASSET' THEN
      IF parent_voucher.account_code NOT IN (
        'FACTORY_RAW_MATERIAL_STOCK','FACTORY_WIP','FACTORY_FINISHED_GOODS'
      ) OR coalesce(parent_voucher.debit_amount,0) <= 0
        OR coalesce(parent_voucher.credit_amount,0) <> 0
        OR NEW.cost_treatment <> 'INVENTORY_COST' THEN
        RAISE EXCEPTION 'Only factory inventory stock accounts may receive INVENTORY_COST treatment';
      END IF;
    ELSE
      RAISE EXCEPTION 'Only expense or asset ledger lines may have cost center allocations';
    END IF;
  ELSE
    SELECT tx_type, reference_table, reference_id, amount_currency, amount_usd
      INTO daybook_type, daybook_reference, daybook_reference_id, daybook_amount, daybook_usd
      FROM factory_daybook_entries
    WHERE id=NEW.factory_daybook_entry_id AND company_id=NEW.company_id;
    -- No double-counting of Factory payment, journal, sale, or POS expense
    -- daybook mirrors. Future supported standalone expense types are explicit.
    IF daybook_type IS NULL OR daybook_type NOT IN
       ('EXPENSE', 'OPERATING_EXPENSE', 'FACTORY_EXPENSE')
       OR nullif(btrim(coalesce(daybook_reference,'')),'') IS NOT NULL
       OR daybook_reference_id IS NOT NULL
       OR coalesce(daybook_amount,0)<=0 OR coalesce(daybook_usd,-1)<0
       OR NEW.cost_treatment <> 'EXPENSE' THEN
      RAISE EXCEPTION 'Factory daybook source is not a standalone expense';
    END IF;
  END IF;
  RETURN NEW;
END
$cc_eligibility$;

CREATE OR REPLACE FUNCTION cost_center_auto_apply_voucher_entry(p_entry_id INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $cc_auto_voucher$
DECLARE
  src RECORD;
  rule_rec RECORD;
  remaining_native NUMERIC(20,6);
  remaining_base NUMERIC(20,6);
  next_native NUMERIC(20,6);
  next_base NUMERIC(20,6);
  specificity INTEGER;
BEGIN
  SELECT ve.id,ve.company_id,ve.ledger_account_id,la.account_type,
    v.currency AS voucher_currency,v.source_module,v.optional,v.deleted_at,
    v.voucher_number,
    coalesce(ve.transaction_currency,v.currency,'USD') AS native_currency,
    coalesce(ve.transaction_debit_amount,ve.debit_amount,0) AS native_debit,
    coalesce(ve.transaction_credit_amount,ve.credit_amount,0) AS native_credit,
    coalesce(ve.base_debit_amount,ve.debit_amount,0) AS base_debit,
    coalesce(ve.base_credit_amount,ve.credit_amount,0) AS base_credit,
    ve.debit_amount,ve.credit_amount,
    ve.historical_exchange_rate,ve.rate_convention
  INTO src
  FROM voucher_entries ve
  JOIN vouchers v ON v.id=ve.voucher_id AND v.company_id=ve.company_id
  LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=ve.company_id
  WHERE ve.id=p_entry_id AND v.deleted_at IS NULL
    AND upper(coalesce(v.source_module,'')) NOT LIKE 'INTERCOMPANY%'
    AND NOT cost_center_voucher_in_reversal_pair(v.id);
  IF NOT FOUND OR src.optional OR src.debit_amount<=0 OR src.credit_amount<>0
      OR src.native_debit<=0 OR src.native_credit<>0
      OR src.base_debit<=0 OR src.base_credit<>0
      OR upper(btrim(coalesce(src.account_type,''))) NOT IN
         ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE')
      OR src.voucher_number LIKE 'GC-%' OR src.voucher_number LIKE 'MIG-%'
      OR src.source_module='SP_MIGRATION_READONLY' THEN RETURN; END IF;

  -- Do not override any manual or previous automatic split; also remember
  -- deliberate CLEAR ALL operations in cost_center_source_overrides.
  IF EXISTS (SELECT 1 FROM cost_center_allocations a WHERE a.voucher_entry_id=p_entry_id)
    OR EXISTS (SELECT 1 FROM cost_center_source_overrides o WHERE o.voucher_entry_id=p_entry_id) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cost_center_auto_rules r WHERE r.company_id=src.company_id
    AND r.source_kind='VOUCHER_ENTRY' AND r.ledger_account_id=src.ledger_account_id
    AND r.active) THEN RETURN; END IF;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM cost_center_auto_rules r JOIN cost_centers c ON c.company_id=r.company_id
       AND c.id=r.cost_center_id AND c.active
    WHERE r.company_id=src.company_id AND r.source_kind='VOUCHER_ENTRY'
      AND r.ledger_account_id=src.ledger_account_id
      AND r.source_module=src.source_module AND r.active
  ) THEN 1 ELSE 0 END INTO specificity;

  PERFORM pg_advisory_xact_lock(721031,src.company_id);
  remaining_native := round(src.native_debit,6);
  remaining_base := round(src.base_debit,6);
  FOR rule_rec IN
    SELECT r.* FROM cost_center_auto_rules r
    JOIN cost_centers c ON c.company_id=r.company_id AND c.id=r.cost_center_id AND c.active
    WHERE r.company_id=src.company_id AND r.source_kind='VOUCHER_ENTRY'
      AND r.ledger_account_id=src.ledger_account_id AND r.active
      AND ((specificity=1 AND r.source_module=src.source_module)
        OR (specificity=0 AND r.source_module IS NULL))
    ORDER BY r.id
  LOOP
    next_native := least(remaining_native,
      round(src.native_debit * rule_rec.allocation_percent / 100,6));
    next_base := least(remaining_base,
      round(src.base_debit * rule_rec.allocation_percent / 100,6));
    IF next_native > 0 THEN
      INSERT INTO cost_center_allocations(company_id,cost_center_id,voucher_entry_id,
        amount_native,currency,amount_base,base_currency,historical_rate,
        rate_convention,cost_treatment,allocation_origin,auto_rule_id,created_by,updated_by)
      VALUES (src.company_id,rule_rec.cost_center_id,p_entry_id,next_native,src.native_currency,
        next_base,'USD',src.historical_exchange_rate,src.rate_convention,'EXPENSE','AUTO',
        rule_rec.id,'system:auto','system:auto');
      remaining_native := remaining_native - next_native;
      remaining_base := remaining_base - next_base;
    END IF;
  END LOOP;
END
$cc_auto_voucher$;


-- Source lifecycle: analytical tags must NEVER block accounting work.
-- Phase 2 rejected edits to allocated vouchers, voucher lines and Factory
-- daybook rows. Container freight/landed-cost sync, FX repair, account
-- migration and voucher edits update those rows, so a cost-center tag would
-- have turned into a posting failure. The guards below keep their trigger
-- names but run AFTER the accounting change and are fail-open:
--   * rate metadata only, or a ledger account change that keeps every split
--     eligible: the splits are kept (rate snapshot refreshed);
--   * an amount, currency, company, voucher or source-type change: the now
--     stale splits are removed (reports would otherwise over-attribute), the
--     automatic rules re-tag the source unless a manual override exists, and
--     manual work that was removed is listed in cost_center_auto_failures;
--   * dates and posting status are read live by every report: nothing to do.
-- Any analytical error is recorded and swallowed; the accounting change wins.

CREATE OR REPLACE FUNCTION cost_center_clear_stale_source(
  p_company_id INTEGER, p_source_kind VARCHAR, p_source_id INTEGER, p_cause TEXT
) RETURNS VOID LANGUAGE plpgsql AS $cc_clear_stale$
DECLARE
  cleared INTEGER;
  manual_cleared INTEGER;
  remaining INTEGER;
BEGIN
  IF p_source_kind = 'VOUCHER_ENTRY' THEN
    SELECT count(*), count(*) FILTER (WHERE allocation_origin = 'MANUAL')
      INTO cleared, manual_cleared
      FROM cost_center_allocations WHERE voucher_entry_id = p_source_id;
    DELETE FROM cost_center_allocations WHERE voucher_entry_id = p_source_id;
    PERFORM cost_center_auto_apply_voucher_entry(p_source_id);
    SELECT count(*) INTO remaining FROM cost_center_allocations WHERE voucher_entry_id = p_source_id;
  ELSE
    SELECT count(*), count(*) FILTER (WHERE allocation_origin = 'MANUAL')
      INTO cleared, manual_cleared
      FROM cost_center_allocations WHERE factory_daybook_entry_id = p_source_id;
    DELETE FROM cost_center_allocations WHERE factory_daybook_entry_id = p_source_id;
    PERFORM cost_center_auto_apply_factory_daybook(p_source_id);
    SELECT count(*) INTO remaining FROM cost_center_allocations WHERE factory_daybook_entry_id = p_source_id;
  END IF;
  IF manual_cleared > 0 OR (cleared > 0 AND remaining = 0) THEN
    PERFORM cost_center_auto_record_failure(p_company_id, p_source_kind, p_source_id,
      format('%s; %s cost center split(s) cleared for review (%s manual). Accounting was not changed.',
        p_cause, cleared, manual_cleared));
  END IF;
END
$cc_clear_stale$;

CREATE OR REPLACE FUNCTION cost_center_voucher_entry_change_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_ve_guard$
DECLARE
  monetary_changed BOOLEAN;
  new_type TEXT;
  new_code TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cost_center_allocations WHERE voucher_entry_id = OLD.id) THEN
    RETURN NULL;
  END IF;
  BEGIN
    monetary_changed :=
      NEW.company_id IS DISTINCT FROM OLD.company_id OR
      NEW.voucher_id IS DISTINCT FROM OLD.voucher_id OR
      NEW.debit_amount IS DISTINCT FROM OLD.debit_amount OR
      NEW.credit_amount IS DISTINCT FROM OLD.credit_amount OR
      NEW.transaction_currency IS DISTINCT FROM OLD.transaction_currency OR
      NEW.transaction_debit_amount IS DISTINCT FROM OLD.transaction_debit_amount OR
      NEW.transaction_credit_amount IS DISTINCT FROM OLD.transaction_credit_amount OR
      NEW.base_debit_amount IS DISTINCT FROM OLD.base_debit_amount OR
      NEW.base_credit_amount IS DISTINCT FROM OLD.base_credit_amount;
    IF NOT monetary_changed THEN
      IF NEW.ledger_account_id IS DISTINCT FROM OLD.ledger_account_id THEN
        SELECT upper(btrim(account_type)), code INTO new_type, new_code
          FROM ledger_accounts WHERE id = NEW.ledger_account_id AND company_id = NEW.company_id;
        IF EXISTS (
          SELECT 1 FROM cost_center_allocations a
          WHERE a.voucher_entry_id = OLD.id AND NOT (
            (a.cost_treatment = 'EXPENSE'
              AND coalesce(new_type, '') IN ('EXPENSE', 'DIRECT EXPENSE', 'INDIRECT EXPENSE'))
            OR (a.cost_treatment = 'INVENTORY_COST' AND new_type = 'ASSET'
              AND new_code IN ('FACTORY_RAW_MATERIAL_STOCK', 'FACTORY_WIP', 'FACTORY_FINISHED_GOODS'))
          )
        ) THEN
          PERFORM cost_center_clear_stale_source(OLD.company_id, 'VOUCHER_ENTRY', OLD.id,
            'Voucher entry moved to an ineligible ledger account');
          RETURN NULL;
        END IF;
      END IF;
      IF NEW.historical_exchange_rate IS DISTINCT FROM OLD.historical_exchange_rate
         OR NEW.rate_convention IS DISTINCT FROM OLD.rate_convention THEN
        UPDATE cost_center_allocations
          SET historical_rate = NEW.historical_exchange_rate,
              rate_convention = NEW.rate_convention,
              updated_by = 'system:source-change', updated_at = now()
          WHERE voucher_entry_id = OLD.id;
      END IF;
      RETURN NULL;
    END IF;
    PERFORM cost_center_clear_stale_source(OLD.company_id, 'VOUCHER_ENTRY', OLD.id,
      'Voucher entry amount, currency or source changed after allocation');
  EXCEPTION WHEN OTHERS THEN
    PERFORM cost_center_auto_record_failure(OLD.company_id, 'VOUCHER_ENTRY', OLD.id,
      'Cost center follow-up after a voucher entry change failed: ' || SQLERRM);
    RAISE WARNING 'Cost center follow-up skipped voucher entry %: %', OLD.id, SQLERRM;
  END;
  RETURN NULL;
END
$cc_ve_guard$;
DROP TRIGGER IF EXISTS cost_center_voucher_entry_change_trg ON voucher_entries;
CREATE TRIGGER cost_center_voucher_entry_change_trg
AFTER UPDATE ON voucher_entries
FOR EACH ROW EXECUTE FUNCTION cost_center_voucher_entry_change_guard();

-- A voucher's date, optional flag and deletion are read live by reports. Only a
-- company move or a voucher-currency change (lines that inherit it) can make
-- the stored native-currency split stale.
CREATE OR REPLACE FUNCTION cost_center_voucher_change_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_voucher_guard$
DECLARE
  item RECORD;
BEGIN
  IF NEW.company_id IS NOT DISTINCT FROM OLD.company_id
     AND NEW.currency IS NOT DISTINCT FROM OLD.currency THEN
    RETURN NULL;
  END IF;
  FOR item IN
    SELECT DISTINCT ve.id FROM voucher_entries ve
    JOIN cost_center_allocations a ON a.voucher_entry_id = ve.id
    WHERE ve.voucher_id = OLD.id
      AND (NEW.company_id IS DISTINCT FROM OLD.company_id OR ve.transaction_currency IS NULL)
  LOOP
    BEGIN
      PERFORM cost_center_clear_stale_source(OLD.company_id, 'VOUCHER_ENTRY', item.id,
        'Voucher company or currency changed after allocation');
    EXCEPTION WHEN OTHERS THEN
      PERFORM cost_center_auto_record_failure(OLD.company_id, 'VOUCHER_ENTRY', item.id,
        'Cost center follow-up after a voucher change failed: ' || SQLERRM);
      RAISE WARNING 'Cost center follow-up skipped voucher %, entry %: %', OLD.id, item.id, SQLERRM;
    END;
  END LOOP;
  RETURN NULL;
END
$cc_voucher_guard$;
DROP TRIGGER IF EXISTS cost_center_voucher_change_trg ON vouchers;
CREATE TRIGGER cost_center_voucher_change_trg
AFTER UPDATE OF company_id, currency ON vouchers
FOR EACH ROW EXECUTE FUNCTION cost_center_voucher_change_guard();

CREATE OR REPLACE FUNCTION cost_center_factory_daybook_change_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_factory_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cost_center_allocations WHERE factory_daybook_entry_id = OLD.id) THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id OR
       NEW.reference_table IS DISTINCT FROM OLD.reference_table OR
       NEW.reference_id IS DISTINCT FROM OLD.reference_id OR
       NEW.tx_type IS DISTINCT FROM OLD.tx_type OR
       NEW.currency_code IS DISTINCT FROM OLD.currency_code OR
       NEW.amount_currency IS DISTINCT FROM OLD.amount_currency OR
       NEW.amount_usd IS DISTINCT FROM OLD.amount_usd THEN
      PERFORM cost_center_clear_stale_source(OLD.company_id, 'FACTORY_DAYBOOK', OLD.id,
        'Factory daybook amount, currency, type or reference changed after allocation');
    ELSIF NEW.fx_rate_to_usd IS DISTINCT FROM OLD.fx_rate_to_usd THEN
      UPDATE cost_center_allocations
        SET historical_rate = NEW.fx_rate_to_usd,
            updated_by = 'system:source-change', updated_at = now()
        WHERE factory_daybook_entry_id = OLD.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM cost_center_auto_record_failure(OLD.company_id, 'FACTORY_DAYBOOK', OLD.id,
      'Cost center follow-up after a Factory daybook change failed: ' || SQLERRM);
    RAISE WARNING 'Cost center follow-up skipped factory daybook entry %: %', OLD.id, SQLERRM;
  END;
  RETURN NULL;
END
$cc_factory_guard$;
DROP TRIGGER IF EXISTS cost_center_factory_daybook_change_trg ON factory_daybook_entries;
CREATE TRIGGER cost_center_factory_daybook_change_trg
AFTER UPDATE ON factory_daybook_entries
FOR EACH ROW EXECUTE FUNCTION cost_center_factory_daybook_change_guard();

-- Deleting a source (voucher edits that rebuild their lines, permanent deletes)
-- cascades to its splits. Keep that, but list removed MANUAL work for review.
CREATE OR REPLACE FUNCTION cost_center_source_delete_notice()
RETURNS trigger LANGUAGE plpgsql AS $cc_delete_notice$
DECLARE
  manual_count INTEGER;
  kind VARCHAR := CASE WHEN TG_TABLE_NAME = 'voucher_entries' THEN 'VOUCHER_ENTRY' ELSE 'FACTORY_DAYBOOK' END;
BEGIN
  BEGIN
    IF kind = 'VOUCHER_ENTRY' THEN
      SELECT count(*) INTO manual_count FROM cost_center_allocations
        WHERE voucher_entry_id = OLD.id AND allocation_origin = 'MANUAL';
    ELSE
      SELECT count(*) INTO manual_count FROM cost_center_allocations
        WHERE factory_daybook_entry_id = OLD.id AND allocation_origin = 'MANUAL';
    END IF;
    IF manual_count > 0 THEN
      PERFORM cost_center_auto_record_failure(OLD.company_id, kind, OLD.id,
        format('Source deleted; %s manual cost center split(s) were removed with it. Re-assign the replacement entry if needed.',
          manual_count));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Cost center delete notice skipped source %: %', OLD.id, SQLERRM;
  END;
  RETURN OLD;
END
$cc_delete_notice$;
DROP TRIGGER IF EXISTS cost_center_voucher_entry_delete_trg ON voucher_entries;
CREATE TRIGGER cost_center_voucher_entry_delete_trg
BEFORE DELETE ON voucher_entries
FOR EACH ROW EXECUTE FUNCTION cost_center_source_delete_notice();
DROP TRIGGER IF EXISTS cost_center_factory_daybook_delete_trg ON factory_daybook_entries;
CREATE TRIGGER cost_center_factory_daybook_delete_trg
BEFORE DELETE ON factory_daybook_entries
FOR EACH ROW EXECUTE FUNCTION cost_center_source_delete_notice();

-- Posting hot path: skip the deferred classification work entirely for a
-- company that has no active automatic rule (the default after installation).
CREATE OR REPLACE FUNCTION cost_center_auto_after_voucher_entry_insert()
RETURNS trigger LANGUAGE plpgsql AS $cc_auto_ve_trg$
BEGIN
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM cost_center_auto_rules r
      WHERE r.company_id = NEW.company_id AND r.source_kind = 'VOUCHER_ENTRY' AND r.active
    ) THEN
      RETURN NULL;
    END IF;
    PERFORM cost_center_auto_apply_voucher_entry(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM cost_center_auto_record_failure(NEW.company_id, 'VOUCHER_ENTRY', NEW.id, SQLERRM);
    RAISE WARNING 'Cost center auto allocation skipped voucher entry %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$cc_auto_ve_trg$;

CREATE OR REPLACE FUNCTION cost_center_auto_after_daybook_insert()
RETURNS trigger LANGUAGE plpgsql AS $cc_auto_fd_trg$
BEGIN
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM cost_center_auto_rules r
      WHERE r.company_id = NEW.company_id AND r.source_kind = 'FACTORY_DAYBOOK' AND r.active
    ) THEN
      RETURN NULL;
    END IF;
    PERFORM cost_center_auto_apply_factory_daybook(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM cost_center_auto_record_failure(NEW.company_id, 'FACTORY_DAYBOOK', NEW.id, SQLERRM);
    RAISE WARNING 'Cost center auto allocation skipped factory daybook entry %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$cc_auto_fd_trg$;
