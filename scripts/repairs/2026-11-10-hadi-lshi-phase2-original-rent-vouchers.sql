-- HADI L'SHI ERP RENT | PHASE 2 | COMPANY 1 | 2026-11-10
-- Original-voucher repair; run ENTIRE transaction in TablePlus. Do not change IDs.
-- NEVER creates a voucher or journal; no deletions; no prepaid or cash/bank edits.
-- THE TWO PROTECTED CLOSINGS ARE FIXED: #1022 PREPAID RENT $7,000 DR;
-- #1021 ACCRUED RENT PAYABLE $18,000 CR. #1007 rent expense remains $434,350 DR.
--
-- 11 original debit lines: $14,650 July payments + $54,000 existing August,
-- September, October rent-settlement journals => $68,650 Dr moved #1007 -> #1021.
-- Existing Oct clearing voucher #15659 is reduced from $70,650 to $2,000
-- on its TWO ORIGINAL LINES and existing voucher header.
-- The moved $68,650 and decreased $68,650 offset exactly: ZERO net movement.
-- The residual $2,000 is PRESERVED as existing historical settlement/adjustment;
-- this does not decide whether STAFF HOUSE July $2,000 is due or forgiven.
-- No company-13 landlord receipt or rental-month records are modified.
-- Hard account, voucher, amount, payment, period, protected-party and pre/post guards;
-- any changed fact or partial state fails CLOSED and rolls the transaction back.
-- A rerun in the exact AFTER state reports a no-op.
--
-- Important: this *changes historical turnover/classifications* within accounts
-- #1007 and #1021, but DOES NOT CHANGE their closing balances.

BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SELECT set_config('app.company_scope_maintenance','off',true);
SELECT set_config('app.current_company_id','1',true);
SELECT set_config('app.authorized_company_ids','',true);
SELECT set_config('app.current_actor','system:hadi-lshi-rent-phase2-20261110',true);
SELECT set_config('app.current_actor_name','Approved original-voucher rent reclassification',true);
SELECT set_config('app.audit_reason','HADI Phase 2: in-place linked-rent and July payment classification; preserve protected prepaid and accrued rent closing balances; no new vouchers',true);

DO $phase2$
DECLARE
  n integer;
  source_lines integer;
  corrected_lines integer;
  offset_dr numeric;
  offset_cr numeric;
  header_amount numeric;
  repair_state text;
  updated_rows integer;
  old_expense numeric;
  old_payable numeric;
  old_prepaid numeric;
  new_expense numeric;
  new_payable numeric;
  new_prepaid numeric;
  old_other_accounts_hash text;
  new_other_accounts_hash text;
  old_counterpart_hash text;
  new_counterpart_hash text;
  old_counterpart_count integer;
  new_counterpart_count integer;
  row_info record;
BEGIN
  IF current_database() <> 'erp_db_qscj_64lv_e7rz_8744_2lm3'
    OR current_setting('app.current_company_id',true) <> '1'
    OR current_setting('app.company_scope_maintenance',true) <> 'off'
  THEN
    RAISE EXCEPTION 'HADI_PHASE2_WRONG_DATABASE_OR_COMPANY';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hadi-lshi-rent-phase2-original-vouchers-20261110'));

  IF NOT EXISTS (SELECT 1 FROM companies WHERE id=1 AND name='HADI L''SHI' AND active=true) THEN
    RAISE EXCEPTION 'HADI_PHASE2_COMPANY_IDENTITY_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM fiscal_period_closures
             WHERE company_id=1 AND status='CLOSED' AND period_end_date >= DATE '2026-07-02') THEN
    RAISE EXCEPTION 'HADI_PHASE2_CLOSED_PERIOD_PRESENT';
  END IF;

  -- Exact existing ledger identities, no newly-created accounts or deleted accounts.
  SELECT COUNT(*) INTO n FROM ledger_accounts a WHERE a.company_id=1
    AND a.deleted_at IS NULL AND a.active=true AND (
      (a.id=1007 AND a.name='Rent Expense - ERP Shops'
       AND a.account_type='Indirect Expense'
       AND a.opening_balance=35000 AND a.opening_balance_side='Cr')
      OR (a.id=1021 AND a.name='Accrued Rent Payable'
       AND a.account_type='Liability' AND COALESCE(a.opening_balance,0)=0)
      OR (a.id=1022 AND a.name='Prepaid Rent'
       AND a.account_type='Asset' AND a.opening_balance=24500 AND a.opening_balance_side='Dr')
    );
  IF n<>3 THEN RAISE EXCEPTION 'HADI_PHASE2_ACCOUNTS_OR_OPENING_CHANGED'; END IF;

  -- Lock the original 12 headers and all 24 entry lines.
  PERFORM 1 FROM vouchers WHERE company_id=1
    AND id IN (9993,10234,10235,10236,10237,10238,10328,10703,13386,15110,15659,16664)
    ORDER BY id FOR UPDATE;
  PERFORM 1 FROM voucher_entries WHERE company_id=1
    AND voucher_id IN (9993,10234,10235,10236,10237,10238,10328,10703,13386,15110,15659,16664)
    ORDER BY id FOR UPDATE;

  SELECT COUNT(*) INTO n
  FROM vouchers v JOIN (VALUES
    (9993,200::numeric,'Payment'::text,DATE '2026-07-02'),
    (10234,1200::numeric,'Payment',DATE '2026-07-06'),
    (10235,2000::numeric,'Payment',DATE '2026-07-06'),
    (10236,1750::numeric,'Payment',DATE '2026-07-06'),
    (10237,1500::numeric,'Payment',DATE '2026-07-06'),
    (10238,1500::numeric,'Payment',DATE '2026-07-06'),
    (10328,4200::numeric,'Payment',DATE '2026-07-07'),
    (10703,2300::numeric,'Payment',DATE '2026-07-15'),
    (13386,18000::numeric,'Journal',DATE '2026-08-31'),
    (15110,18000::numeric,'Journal',DATE '2026-10-01'),
    (16664,18000::numeric,'Journal',DATE '2026-10-26')
  ) AS x(id,amount,kind,dated) ON v.id=x.id
  WHERE v.company_id=1 AND v.deleted_at IS NULL AND v.optional=false
    AND v.currency='USD' AND v.voucher_type=x.kind AND v.voucher_date=x.dated
    AND v.total_amount=x.amount;
  IF n<>11 THEN RAISE EXCEPTION 'HADI_PHASE2_ORIGINAL_HEADERS_CHANGED'; END IF;

  SELECT COUNT(*) INTO n FROM voucher_entries
    WHERE company_id=1 AND voucher_id IN
    (9993,10234,10235,10236,10237,10238,10328,10703,13386,15110,15659,16664);
  IF n<>24 THEN RAISE EXCEPTION 'HADI_PHASE2_ORIGINAL_LINE_COUNTS_CHANGED'; END IF;

  -- Each of the 8 July payments is STILL tied to its already posted accrual.
  SELECT COUNT(*) INTO n FROM (VALUES
    (9993,200::numeric,18,9919),
    (10234,1200::numeric,18,9919),
    (10235,2000::numeric,19,9919),
    (10236,1750::numeric,20,9919),
    (10237,1500::numeric,21,9919),
    (10238,1500::numeric,22,9919),
    (10328,4200::numeric,23,9919),
    (10703,2300::numeric,37,10701)
  ) AS x(voucher_id,amount,contract_id,accrual_voucher_id)
  JOIN property_payments p ON p.voucher_id=x.voucher_id
      AND p.company_id=1 AND p.contract_id=x.contract_id
      AND p.amount=x.amount AND p.for_year=2026 AND p.for_month=7
      AND p.posting_status='POSTED'
  JOIN property_monthly_ledger m ON m.id=p.ledger_row_id
      AND m.company_id=1 AND m.contract_id=x.contract_id
      AND m.accrual_voucher_id=x.accrual_voucher_id
      AND m.used_prepaid_account=false AND m.used_advance_account=false
  WHERE m.year=2026 AND m.month=7;
  IF n<>8 THEN RAISE EXCEPTION 'HADI_PHASE2_JULY_POSTED_RENT_LINKS_CHANGED'; END IF;

  -- Full fingerprint of the 11 ORIGINAL intended debit lines: either all old
  -- account #1007 OR all new account #1021. No partial state is acceptable.
  SELECT
    COUNT(*) FILTER(WHERE e.ledger_account_id=1007),
    COUNT(*) FILTER(WHERE e.ledger_account_id=1021),
    COUNT(*)
  INTO source_lines,corrected_lines,n
  FROM voucher_entries e JOIN (VALUES
    (34317,9993,200::numeric),
    (35045,10234,1200::numeric),
    (35047,10235,2000::numeric),
    (35049,10236,1750::numeric),
    (35051,10237,1500::numeric),
    (35053,10238,1500::numeric),
    (35383,10328,4200::numeric),
    (38389,10703,2300::numeric),
    (47200,13386,18000::numeric),
    (53014,15110,18000::numeric),
    (58242,16664,18000::numeric)
  ) AS x(entry_id,voucher_id,amount) ON e.id=x.entry_id
  WHERE e.company_id=1 AND e.voucher_id=x.voucher_id
    AND e.debit_amount=x.amount AND e.credit_amount=0
    AND e.ledger_account_id IN (1007,1021);
  IF n<>11 OR NOT ((source_lines=11 AND corrected_lines=0)
                 OR (source_lines=0 AND corrected_lines=11)) THEN
    RAISE EXCEPTION 'HADI_PHASE2_TARGET_LINES_CHANGED_OR_PARTIALLY_CORRECTED';
  END IF;

  SELECT
    (SELECT debit_amount FROM voucher_entries WHERE company_id=1 AND id=55192
      AND voucher_id=15659 AND ledger_account_id=1021 AND credit_amount=0),
    (SELECT credit_amount FROM voucher_entries WHERE company_id=1 AND id=55193
      AND voucher_id=15659 AND ledger_account_id=1007 AND debit_amount=0),
    (SELECT total_amount FROM vouchers WHERE company_id=1 AND id=15659
      AND voucher_type='Journal' AND voucher_date=DATE '2026-10-11'
      AND currency='USD' AND optional=false AND deleted_at IS NULL)
    INTO offset_dr,offset_cr,header_amount;
  IF source_lines=11 AND corrected_lines=0 AND
     offset_dr=70650 AND offset_cr=70650 AND header_amount=70650 THEN
    repair_state:='before';
  ELSIF source_lines=0 AND corrected_lines=11 AND
     offset_dr=2000 AND offset_cr=2000 AND header_amount=2000 THEN
    repair_state:='after';
  ELSE
    RAISE EXCEPTION 'HADI_PHASE2_MANUAL_CLEARING_JOURNAL_DRIFT_OR_PARTIAL_STATE';
  END IF;

  -- No cost centre allocations can be quietly invalidated by changing expense to liability.
  IF EXISTS (SELECT 1 FROM cost_center_allocations WHERE voucher_entry_id IN
    (34317,35045,35047,35049,35051,35053,35383,38389,47200,53014,58242,55192,55193)) THEN
    RAISE EXCEPTION 'HADI_PHASE2_COST_CENTER_LINK_PRESENT_REVIEW_FIRST';
  END IF;

  -- Preserve every unrelated side of the 12 vouchers, including 8 cash/bank
  -- credits, Transaction Account and HP's Rent Credit.
  SELECT COUNT(*),
         md5(COALESCE(string_agg(to_jsonb(e)::text,'|' ORDER BY e.id),''))
  INTO old_counterpart_count,old_counterpart_hash
  FROM voucher_entries e WHERE e.company_id=1
    AND e.voucher_id IN (9993,10234,10235,10236,10237,10238,10328,10703,13386,15110,15659,16664)
    AND e.id NOT IN(34317,35045,35047,35049,35051,35053,35383,38389,47200,53014,58242,55192,55193);
  IF old_counterpart_count<>11 THEN RAISE EXCEPTION 'HADI_PHASE2_UNEXPECTED_COUNTERPART_LINES'; END IF;

  -- All ledger accounts EXCEPT #1007 and #1021 must retain the identical debit
  -- and credit totals (not merely a net-zero difference).
  SELECT md5(COALESCE(string_agg(concat_ws(':',ledger_account_id,dr,cr),'|' ORDER BY ledger_account_id),''))
  INTO old_other_accounts_hash
  FROM (
    SELECT e.ledger_account_id,COALESCE(SUM(e.debit_amount),0) dr,COALESCE(SUM(e.credit_amount),0) cr
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=1
    WHERE e.company_id=1 AND v.deleted_at IS NULL AND v.optional=false
      AND e.ledger_account_id IS NOT NULL AND e.ledger_account_id NOT IN(1007,1021)
    GROUP BY e.ledger_account_id
  ) protected;

  SELECT
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1007),0)-35000,
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1021),0),
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1022),0)+24500
  INTO old_expense,old_payable,old_prepaid
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=1
  WHERE e.company_id=1 AND v.deleted_at IS NULL AND v.optional=false
    AND e.ledger_account_id IN(1007,1021,1022);

  -- Fail rather than touching a payable or prepaid amount that has changed.
  IF old_expense<>434350 OR old_payable<>-18000 OR old_prepaid<>7000 THEN
    RAISE EXCEPTION 'HADI_PHASE2_PROTECTED_PRE_BALANCE_DRIFT expense=% payable=% prepaid=%',
      old_expense,old_payable,old_prepaid;
  END IF;

  IF repair_state='after' THEN
    RAISE NOTICE 'HADI Phase 2 already applied. No updates. Expense % Dr, payable % Cr, prepaid % Dr.',
      old_expense,-old_payable,old_prepaid;
    RETURN;
  END IF;

  -- Actual old-voucher changes. The 11 debit amounts/dates/IDs never change.
  UPDATE voucher_entries e SET ledger_account_id=1021
  FROM (VALUES
    (34317,9993,200::numeric),
    (35045,10234,1200::numeric),
    (35047,10235,2000::numeric),
    (35049,10236,1750::numeric),
    (35051,10237,1500::numeric),
    (35053,10238,1500::numeric),
    (38389,10703,2300::numeric),
    (35383,10328,4200::numeric),
    (47200,13386,18000::numeric),
    (53014,15110,18000::numeric),
    (58242,16664,18000::numeric)
  ) x(entry_id,voucher_id,amount)
  WHERE e.company_id=1 AND e.id=x.entry_id AND e.voucher_id=x.voucher_id
    AND e.ledger_account_id=1007 AND e.debit_amount=x.amount AND e.credit_amount=0;
  GET DIAGNOSTICS updated_rows=ROW_COUNT;
  IF updated_rows<>11 THEN RAISE EXCEPTION 'HADI_PHASE2_RECLASS_UPDATE_COUNT_%',updated_rows; END IF;

  -- Reduce the EXISTING compensation voucher #15659, not a new journal.
  -- The original two entries are retained, the USD native/base fields are
  -- automatically normalized by the voucher-entry update trigger.
  UPDATE voucher_entries SET debit_amount=2000
  WHERE company_id=1 AND id=55192 AND voucher_id=15659
    AND ledger_account_id=1021 AND debit_amount=70650 AND credit_amount=0;
  GET DIAGNOSTICS updated_rows=ROW_COUNT;
  IF updated_rows<>1 THEN RAISE EXCEPTION 'HADI_PHASE2_CLEARING_DEBIT_UPDATE_FAILED'; END IF;

  UPDATE voucher_entries SET credit_amount=2000
  WHERE company_id=1 AND id=55193 AND voucher_id=15659
    AND ledger_account_id=1007 AND credit_amount=70650 AND debit_amount=0;
  GET DIAGNOSTICS updated_rows=ROW_COUNT;
  IF updated_rows<>1 THEN RAISE EXCEPTION 'HADI_PHASE2_CLEARING_CREDIT_UPDATE_FAILED'; END IF;

  UPDATE vouchers SET total_amount=2000 WHERE company_id=1 AND id=15659
    AND total_amount=70650 AND deleted_at IS NULL AND optional=false;
  GET DIAGNOSTICS updated_rows=ROW_COUNT;
  IF updated_rows<>1 THEN RAISE EXCEPTION 'HADI_PHASE2_CLEARING_HEADER_UPDATE_FAILED'; END IF;

  -- All affected vouchers remain balanced and have the same original entry IDs.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT v.id,v.total_amount,COUNT(e.id) AS n,
        COALESCE(SUM(e.debit_amount),0) AS dr,
        COALESCE(SUM(e.credit_amount),0) AS cr
      FROM vouchers v JOIN voucher_entries e ON e.company_id=v.company_id AND e.voucher_id=v.id
      WHERE v.company_id=1 AND v.id IN
        (9993,10234,10235,10236,10237,10238,10328,10703,13386,15110,15659,16664)
      GROUP BY v.id,v.total_amount
    ) t WHERE t.n<>2 OR t.dr<>t.cr OR t.dr<>t.total_amount
  ) THEN
    RAISE EXCEPTION 'HADI_PHASE2_ORIGINAL_VOUCHER_UNBALANCED_AFTER_RECLASS';
  END IF;

  -- No other entries were touched: 11 preserved counterpart rows, exactly.
  SELECT COUNT(*),
         md5(COALESCE(string_agg(to_jsonb(e)::text,'|' ORDER BY e.id),''))
  INTO new_counterpart_count,new_counterpart_hash
  FROM voucher_entries e WHERE e.company_id=1
    AND e.voucher_id IN (9993,10234,10235,10236,10237,10238,10328,10703,13386,15110,15659,16664)
    AND e.id NOT IN(34317,35045,35047,35049,35051,35053,35383,38389,47200,53014,58242,55192,55193);
  IF new_counterpart_count<>old_counterpart_count OR new_counterpart_hash<>old_counterpart_hash THEN
    RAISE EXCEPTION 'HADI_PHASE2_CASH_OR_COUNTERPART_ENTRY_CHANGED';
  END IF;

  SELECT md5(COALESCE(string_agg(concat_ws(':',ledger_account_id,dr,cr),'|' ORDER BY ledger_account_id),''))
  INTO new_other_accounts_hash
  FROM (
    SELECT e.ledger_account_id,COALESCE(SUM(e.debit_amount),0) dr,COALESCE(SUM(e.credit_amount),0) cr
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=1
    WHERE e.company_id=1 AND v.deleted_at IS NULL AND v.optional=false
      AND e.ledger_account_id IS NOT NULL AND e.ledger_account_id NOT IN(1007,1021)
    GROUP BY e.ledger_account_id
  ) protected;
  IF new_other_accounts_hash<>old_other_accounts_hash THEN
    RAISE EXCEPTION 'HADI_PHASE2_OTHER_LEDGER_ACCOUNT_DEBITS_OR_CREDITS_CHANGED';
  END IF;

  SELECT
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1007),0)-35000,
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1021),0),
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1022),0)+24500
  INTO new_expense,new_payable,new_prepaid
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=1
  WHERE e.company_id=1 AND v.deleted_at IS NULL AND v.optional=false
    AND e.ledger_account_id IN(1007,1021,1022);

  IF new_expense<>old_expense OR new_expense<>434350
    OR new_payable<>old_payable OR new_payable<>-18000
    OR new_prepaid<>old_prepaid OR new_prepaid<>7000 THEN
    RAISE EXCEPTION 'HADI_PHASE2_PROTECTED_POST_BALANCES_DRIFT expense=% payable=% prepaid=%',
       new_expense,new_payable,new_prepaid;
  END IF;

  -- Application audit records in addition to the immutable DB row-update triggers.
  FOR row_info IN SELECT * FROM (VALUES
    (34317,9993,200::numeric),(35045,10234,1200::numeric),
    (35047,10235,2000::numeric),(35049,10236,1750::numeric),
    (35051,10237,1500::numeric),(35053,10238,1500::numeric),
    (35383,10328,4200::numeric),(38389,10703,2300::numeric),
    (47200,13386,18000::numeric),(53014,15110,18000::numeric),
    (58242,16664,18000::numeric)
  ) AS x(entry_id,voucher_id,amount)
  LOOP
    INSERT INTO audit_log(user_id,username,company_id,action,table_name,record_id,
                          record_identifier,reason,changes)
    VALUES ('system:hadi-lshi-rent-phase2-20261110','Original rent voucher repair',
      1,'repair','voucher_entries',row_info.entry_id,
      'HADI original voucher '||row_info.voucher_id,
      'Phase 2: original rent already accrued, payment/settlement debit moved from expense 1007 to accrued payable 1021; compensating voucher 15659 reduced by same aggregate 68650; original cash/prepaid and final balances protected',
      jsonb_build_object('voucher_id',row_info.voucher_id,
        'ledger_account_id',jsonb_build_object('old',1007,'new',1021),
        'original_debit',row_info.amount, 'cash_counterpart_unchanged',true));
  END LOOP;
  INSERT INTO audit_log(user_id,username,company_id,action,table_name,record_id,
                        record_identifier,reason,changes)
  VALUES('system:hadi-lshi-rent-phase2-20261110','Original rent voucher repair',
    1,'repair','vouchers',15659,'HADI original clearing journal 15659',
    'Phase 2: 68650 prior compensating clearing allocated to 11 original July/Aug-Oct reclassified entries. Residual 2000 retained; prepaid and accrued closing unchanged; no replacement journal.',
    jsonb_build_object('amount',jsonb_build_object('old',70650,'new',2000),
      'clearing_debit_entry_id',55192,'clearing_credit_entry_id',55193,
      'opening_and_closing_balances_preserved',true));

  RAISE NOTICE 'HADI PHASE 2 DONE: 11 ORIGINAL debit lines reclassified ($68,650); ORIGINAL #15659 reduced to $2,000; original cash/other balances untouched; expense $434350 Dr, AP $18000 Cr, prepaid $7000 Dr; ZERO new vouchers.';
END
$phase2$;
COMMIT;

-- Read-only verification after COMMIT should show all eleven original debit
-- entries on #1021, #15659 debits/credits/header $2,000, and balances unchanged.
-- If anything fails before COMMIT, PostgreSQL rolls back the entire transaction.

-- End-of-script live check (read-only): no additional posting.
WITH ctx AS MATERIALIZED (SELECT set_config('app.current_company_id','1',true) AS cid),
entry_totals AS MATERIALIZED (
  SELECT e.ledger_account_id,
         COALESCE(SUM(e.debit_amount),0) AS dr,
         COALESCE(SUM(e.credit_amount),0) AS cr
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=1
  WHERE e.company_id=(SELECT cid::integer FROM ctx)
    AND e.ledger_account_id IN (1007,1021,1022)
    AND v.deleted_at IS NULL AND v.optional=false
  GROUP BY e.ledger_account_id
),
proof AS (
  SELECT
    (SELECT COUNT(*) FROM voucher_entries
      WHERE company_id=(SELECT cid::integer FROM ctx)
        AND id IN (34317,35045,35047,35049,35051,35053,35383,38389,47200,53014,58242)
        AND ledger_account_id=1021) AS corrected_original_lines,
    (SELECT total_amount FROM vouchers
      WHERE company_id=(SELECT cid::integer FROM ctx) AND id=15659) AS old_clearing_amount,
    (SELECT dr-cr-35000 FROM entry_totals WHERE ledger_account_id=1007) AS rent_expense_dr,
    (SELECT cr-dr FROM entry_totals WHERE ledger_account_id=1021) AS accrued_rent_payable_cr,
    (SELECT dr-cr+24500 FROM entry_totals WHERE ledger_account_id=1022) AS prepaid_rent_dr
)
SELECT
  CASE WHEN corrected_original_lines=11 AND old_clearing_amount=2000
    AND rent_expense_dr=434350 AND accrued_rent_payable_cr=18000
    AND prepaid_rent_dr=7000 THEN 'PASS' ELSE 'REVIEW' END AS phase2_status,
  corrected_original_lines,old_clearing_amount,
  rent_expense_dr,accrued_rent_payable_cr,prepaid_rent_dr
FROM proof;
