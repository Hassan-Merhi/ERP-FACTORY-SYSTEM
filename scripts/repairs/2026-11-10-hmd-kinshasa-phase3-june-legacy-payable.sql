-- Phase 3 / HMD KINSHASA ERP Shops — June 2026 legacy payable-account cleanup.
-- EXACT ORIGINAL VOUCHER EDITS ONLY; no new vouchers, journal entries, payments or cash changes.
-- Production database: erp_db_qscj_64lv_e7rz_8744_2lm3, company 8.
-- This June-only correction is independent of the later January-May hold deployment.
-- To apply: review the assertions, execute the ENTIRE file as one script in TablePlus.
-- Re-running an already completed repair is harmless; mixed/unexpected states fail closed.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.company_scope_maintenance','off',true);
SELECT set_config('app.current_company_id','8',true);
SELECT set_config('app.authorized_company_ids','',true);
SELECT set_config('app.current_actor','system:hmd-kinshasa-phase3-june-payable-20261110',true);
SELECT set_config('app.current_actor_name','Owner-approved historical payable reconciliation',true);
SELECT set_config('app.audit_reason','Phase 3: replace missing June historical account 918 with existing Accrued Rent Payable 1401 on four original voucher entries; no new journals',true);

DO $phase3_june$
DECLARE
  n integer;
  account_before numeric;
  account_after numeric;
  expense_net numeric;
  legacy_debit numeric;
  legacy_credit numeric;
  current_lines integer;
  old_lines integer;
  changed integer;
  target record;
BEGIN
  IF current_database()<>'erp_db_qscj_64lv_e7rz_8744_2lm3'
     OR current_setting('app.current_company_id',true)<>'8'
  THEN RAISE EXCEPTION 'KIN_PHASE3_JUNE_WRONG_DB_COMPANY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hmd-kinshasa-phase3-june-legacy-918'));

  IF NOT EXISTS (SELECT 1 FROM companies WHERE id=8 AND name='HMD KINSHASA' AND active=TRUE)
  THEN RAISE EXCEPTION 'KIN_PHASE3_JUNE_COMPANY_CHANGED'; END IF;

  -- Source vouchers are original June accrual, June payment and AP-clearing journals.
  PERFORM 1 FROM vouchers WHERE company_id=8 AND id IN(8537,8722,8802,8804)
    ORDER BY id FOR UPDATE;
  PERFORM 1 FROM voucher_entries WHERE company_id=8 AND
    voucher_id IN(8537,8722,8802,8804) ORDER BY id FOR UPDATE;

  SELECT COUNT(*) INTO n FROM vouchers v WHERE v.company_id=8
    AND v.deleted_at IS NULL AND v.optional=FALSE AND v.currency='USD' AND (
      (v.id=8537 AND v.voucher_type='Journal'
         AND v.voucher_number='ACCR-RENT-1780387860875-5z7h'
         AND v.voucher_date=DATE '2026-06-02' AND v.total_amount=13560)
      OR (v.id=8722 AND v.voucher_type='Payment'
         AND v.voucher_number='RENT-1780583181856-fj64c-15'
         AND v.voucher_date=DATE '2026-06-04' AND v.total_amount=4400)
      OR (v.id=8802 AND v.voucher_type='Journal'
         AND v.voucher_number='AP-CLEAR-8801'
         AND v.voucher_date=DATE '2026-06-05' AND v.total_amount=6660)
      OR (v.id=8804 AND v.voucher_type='Journal'
         AND v.voucher_number='AP-CLEAR-8803'
         AND v.voucher_date=DATE '2026-06-05' AND v.total_amount=2500)
    );
  IF n<>4 THEN RAISE EXCEPTION 'KIN_PHASE3_JUNE_VOUCHERS_CHANGED'; END IF;

  -- Existing target payable and rent-expense identity must be unchanged.
  SELECT COUNT(*) INTO n FROM ledger_accounts a
  WHERE a.company_id=8 AND a.deleted_at IS NULL AND a.active=TRUE AND (
    (a.id=1401 AND a.name='Accrued Rent Payable' AND a.account_type='Liability')
    OR (a.id=877 AND a.name='Rent Expense - ERP Shops')
    OR (a.id=352 AND a.name='CASH')
  );
  IF n<>3 THEN RAISE EXCEPTION 'KIN_PHASE3_JUNE_ACCOUNT_IDENTITY_CHANGED'; END IF;
  -- June legacy account 918 no longer resolves in the company-8 account list.
  IF EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.company_id=8 AND a.id=918
       AND a.deleted_at IS NULL)
  THEN RAISE EXCEPTION 'KIN_PHASE3_JUNE_LEGACY_ACCOUNT_STILL_LIVE_REVIEW'; END IF;

  IF EXISTS (
    SELECT 1 FROM fiscal_period_closures f
    WHERE f.company_id=8 AND f.status='CLOSED' AND f.period_end_date >= DATE '2026-06-02'
  ) THEN RAISE EXCEPTION 'KIN_PHASE3_JUNE_CLOSED_PERIOD'; END IF;

  -- All four exact lines must be EITHER legacy 918 or corrected 1401; no partial runs.
  SELECT COUNT(*) FILTER(WHERE e.ledger_account_id=918),
         COUNT(*) FILTER(WHERE e.ledger_account_id=1401),
         COUNT(*)
    INTO old_lines,current_lines,n
  FROM voucher_entries e JOIN (VALUES
    (29370,8537,0::numeric,13560::numeric),
    (30027,8722,4400::numeric,0::numeric),
    (30308,8802,6660::numeric,0::numeric),
    (30312,8804,2500::numeric,0::numeric)
  ) AS x(id,voucher_id,dr,cr) ON e.id=x.id
  WHERE e.company_id=8 AND e.voucher_id=x.voucher_id
    AND e.debit_amount=x.dr AND e.credit_amount=x.cr
    AND e.ledger_account_id IN (918,1401);
  IF n<>4 OR NOT ((old_lines=4 AND current_lines=0)
               OR (old_lines=0 AND current_lines=4)) THEN
    RAISE EXCEPTION 'KIN_PHASE3_JUNE_TARGET_LINE_STATE_CHANGED';
  END IF;

  -- Original voucher entry counts and other parties of all four journal postings.
  SELECT COUNT(*) INTO n FROM voucher_entries e WHERE e.company_id=8
    AND e.voucher_id IN(8537,8722,8802,8804);
  IF n<>10 THEN RAISE EXCEPTION 'KIN_PHASE3_JUNE_UNEXPECTED_VOUCHER_LINES'; END IF;
  SELECT COUNT(*) INTO n FROM voucher_entries e WHERE e.company_id=8 AND (
    (e.id=30028 AND e.voucher_id=8722 AND e.ledger_account_id=352 AND e.credit_amount=4400 AND e.debit_amount=0)
    OR (e.id=30309 AND e.voucher_id=8802 AND e.ledger_account_id=877 AND e.credit_amount=6660 AND e.debit_amount=0)
    OR (e.id=30313 AND e.voucher_id=8804 AND e.ledger_account_id=877 AND e.credit_amount=2500 AND e.debit_amount=0)
  );
  IF n<>3 THEN RAISE EXCEPTION 'KIN_PHASE3_JUNE_COUNTERPARTS_CHANGED'; END IF;

  SELECT SUM(e.debit_amount-e.credit_amount)
    INTO expense_net
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=8
  WHERE e.company_id=8 AND e.ledger_account_id=877 AND v.deleted_at IS NULL AND v.optional=FALSE;
  SELECT COALESCE(SUM(e.debit_amount-e.credit_amount),0)
    INTO account_before
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=8
  WHERE e.company_id=8 AND e.ledger_account_id=1401 AND v.deleted_at IS NULL AND v.optional=FALSE;
  IF expense_net<>149160 OR account_before<>0 THEN
    RAISE EXCEPTION 'KIN_PHASE3_JUNE_BALANCES_DRIFT: expense=%, payable=%',expense_net,account_before;
  END IF;

  SELECT COALESCE(SUM(debit_amount),0),COALESCE(SUM(credit_amount),0)
    INTO legacy_debit,legacy_credit
  FROM voucher_entries WHERE company_id=8 AND ledger_account_id=918;
  IF old_lines=4 AND (legacy_debit<>13560 OR legacy_credit<>13560) THEN
    RAISE EXCEPTION 'KIN_PHASE3_JUNE_LEGACY_CONTROL_NOT_BALANCED';
  END IF;

  -- Already applied: verify and return without adding duplicate audit rows.
  IF current_lines=4 THEN
    IF legacy_debit<>0 OR legacy_credit<>0 THEN
      RAISE EXCEPTION 'KIN_PHASE3_JUNE_STILL_HAS_LEGACY_LINES';
    END IF;
    RAISE NOTICE 'HMD KINSHASA Phase 3 June payable account already reconciled; no change.';
    RETURN;
  END IF;

  UPDATE voucher_entries e SET ledger_account_id=1401
  FROM (VALUES
    (29370,8537,0::numeric,13560::numeric),
    (30027,8722,4400::numeric,0::numeric),
    (30308,8802,6660::numeric,0::numeric),
    (30312,8804,2500::numeric,0::numeric)
  ) AS x(id,voucher_id,dr,cr)
  WHERE e.company_id=8 AND e.id=x.id AND e.voucher_id=x.voucher_id
    AND e.debit_amount=x.dr AND e.credit_amount=x.cr AND e.ledger_account_id=918;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>4 THEN RAISE EXCEPTION 'KIN_PHASE3_JUNE_WRONG_UPDATE_COUNT'; END IF;

  SELECT COALESCE(SUM(e.debit_amount-e.credit_amount),0)
    INTO account_after
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=8
  WHERE e.company_id=8 AND e.ledger_account_id=1401 AND v.deleted_at IS NULL AND v.optional=FALSE;
  IF account_after<>0 OR EXISTS (
      SELECT 1 FROM voucher_entries WHERE company_id=8 AND ledger_account_id=918
  ) THEN
    RAISE EXCEPTION 'KIN_PHASE3_JUNE_AFTER_BALANCE_OR_LEGACY_ACCOUNT_DRIFT';
  END IF;

  FOR target IN SELECT * FROM (VALUES
    (29370,8537,13560::numeric,'credit'),
    (30027,8722,4400::numeric,'debit'),
    (30308,8802,6660::numeric,'debit'),
    (30312,8804,2500::numeric,'debit')
  ) AS t(entry_id,voucher_id,amount,side)
  LOOP
    INSERT INTO audit_log(user_id,username,company_id,action,table_name,
                          record_id,record_identifier,reason,changes)
    VALUES (
      'system:hmd-kinshasa-phase3-june-payable-20261110',
      'Owner-approved historical payable reconciliation',8,'repair','voucher_entries',
      target.entry_id, 'Original June rent voucher '||target.voucher_id,
      'Account 918 not present among company-8 ledger accounts; reclassify balanced legacy payable controls to existing account 1401 without new journal',
      jsonb_build_object(
        'ledger_account_id',jsonb_build_object('old',918,'new',1401),
        'amount',jsonb_build_object('old',target.amount,'new',target.amount),
        'side',jsonb_build_object('old',target.side,'new',target.side),
        'voucher_id',jsonb_build_object('old',target.voucher_id,'new',target.voucher_id)
      )
    );
  END LOOP;
  RAISE NOTICE 'HMD KINSHASA June 2026 legacy payable account corrected on FOUR old entries; payable net=%, Rent Expense unchanged; no new vouchers or cash changes.',account_after;
END
$phase3_june$;
COMMIT;
