-- Phase 8: append-only integrity hardening. No data writes/backfills.
-- Protect voucher reversal/intercompany exclusions and independently sourced
-- Factory expense daybook rows in the database, not only the application UI.

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
       OR EXISTS (
         SELECT 1 FROM vouchers v
         JOIN voucher_entries ve ON ve.voucher_id=v.id
         WHERE ve.id=NEW.voucher_entry_id AND v.company_id=NEW.company_id
           AND (v.reversal_of_voucher_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM vouchers rev
               WHERE rev.reversal_of_voucher_id=v.id AND rev.deleted_at IS NULL))
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
    AND v.reversal_of_voucher_id IS NULL
    AND upper(coalesce(v.source_module,'')) NOT LIKE 'INTERCOMPANY%'
    AND NOT EXISTS (
      SELECT 1 FROM vouchers rev
      WHERE rev.reversal_of_voucher_id=v.id AND rev.deleted_at IS NULL
    );
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

CREATE OR REPLACE FUNCTION cost_center_factory_daybook_change_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_factory_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cost_center_allocations WHERE factory_daybook_entry_id=OLD.id)
     AND (
       NEW.company_id IS DISTINCT FROM OLD.company_id OR
       NEW.tx_date IS DISTINCT FROM OLD.tx_date OR
       NEW.effective_date IS DISTINCT FROM OLD.effective_date OR
       NEW.reference_table IS DISTINCT FROM OLD.reference_table OR
       NEW.reference_id IS DISTINCT FROM OLD.reference_id OR
       NEW.tx_type IS DISTINCT FROM OLD.tx_type OR
       NEW.currency_code IS DISTINCT FROM OLD.currency_code OR
       NEW.amount_currency IS DISTINCT FROM OLD.amount_currency OR
       NEW.amount_usd IS DISTINCT FROM OLD.amount_usd OR
       NEW.fx_rate_to_usd IS DISTINCT FROM OLD.fx_rate_to_usd
     ) THEN
    RAISE EXCEPTION 'Factory daybook entry is allocated; clear cost centers before modifying the source';
  END IF;
  RETURN NEW;
END
$cc_factory_guard$;
