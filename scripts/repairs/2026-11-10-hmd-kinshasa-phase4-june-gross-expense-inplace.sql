-- HMD KINSHASA #8 | June 2026 rent EXPENSE gross cleanup
-- Original posted voucher-entry account links ONLY. No new vouchers, no new
-- entries, no cash edits, no value/date changes, no deleted or optional vouchers.
--
-- Gross outcome: Rent Expense #877 Dr 149160 / Cr 0 = 149160 Dr.
-- Accrued Rent Payable #1401 Dr 90520 / Cr 90520 = 0.
-- June rent expense Dr 13560 / Cr 0 = 13560 Dr.
--
-- Two old AP-CLEAR vouchers become Dr/Cr to the SAME payable control account.
-- That makes them net-zero historical clearing records, not new settlement.
-- Their gross debit/credit volumes remain visible in payable #1401.
-- This is an in-place historical book-keeping compromise, not a conventional
-- reversing journal. Review with your accountant before running.
--
-- Execute whole script on production database erp_db_qscj_64lv_e7rz_8744_2lm3
-- under authorized company 8 context via TablePlus. Any mismatch -> ROLLBACK.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';
SELECT set_config('app.company_scope_maintenance', 'off', true);
SELECT set_config('app.current_company_id', '8', true);
SELECT set_config('app.authorized_company_ids', '', true);
SELECT set_config('app.current_actor', 'system:hmd-kinshasa-june-gross-20261110', true);
SELECT set_config('app.current_actor_name', 'Owner-approved June gross rent repair', true);
SELECT set_config('app.audit_reason', 'June gross rent: original voucher account-link corrections; preserve cash and all account net balances', true);

DO $rent_june$
DECLARE
  n integer;
  old_n integer;
  fixed_n integer;
  expense_dr numeric; expense_cr numeric;
  payable_dr numeric; payable_cr numeric;
  cash_before text; cash_after text;
  changed integer;
  target record;
BEGIN
  IF current_database() <> 'erp_db_qscj_64lv_e7rz_8744_2lm3'
     OR current_setting('app.current_company_id', true) <> '8'
  THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_WRONG_DATABASE_OR_COMPANY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hmd-kinshasa-june-gross-repair-20261110'));

  IF NOT EXISTS (SELECT 1 FROM companies WHERE id=8 AND name='HMD KINSHASA' AND active=TRUE)
  THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_WRONG_COMPANY'; END IF;

  -- Do not change a closed historic fiscal period.
  IF EXISTS (
    SELECT 1 FROM fiscal_period_closures f
    WHERE f.company_id=8 AND f.status='CLOSED'
      AND COALESCE(f.period_start_date,f.period_start) <= DATE '2026-06-05'
      AND COALESCE(f.period_end_date,f.period_end) >= DATE '2026-06-05'
  ) THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_FISCAL_PERIOD_CLOSED'; END IF;

  PERFORM 1 FROM vouchers
    WHERE company_id=8 AND id IN (8801,8802,8803,8804)
    ORDER BY id FOR UPDATE;
  PERFORM 1 FROM voucher_entries
    WHERE company_id=8 AND voucher_id IN (8801,8802,8803,8804)
    ORDER BY id FOR UPDATE;

  -- Check all four existing voucher headers; never modify any of them.
  SELECT COUNT(*) INTO n FROM vouchers v WHERE v.company_id=8
  AND v.deleted_at IS NULL AND v.optional=FALSE
  AND v.voucher_date=DATE '2026-06-05' AND v.currency='USD'
  AND (
    (v.id=8801 AND v.voucher_type='Payment' AND v.voucher_number='RENT-1780672038725-4tkyk-16' AND v.total_amount=6660)
 OR (v.id=8802 AND v.voucher_type='Journal' AND v.voucher_number='AP-CLEAR-8801' AND v.total_amount=6660)
 OR (v.id=8803 AND v.voucher_type='Payment' AND v.voucher_number='RENT-1780672038755-elcs5-17' AND v.total_amount=2500)
 OR (v.id=8804 AND v.voucher_type='Journal' AND v.voucher_number='AP-CLEAR-8803' AND v.total_amount=2500)
  );
  IF n<>4 THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_VOUCHER_IDENTITIES_CHANGED'; END IF;

  SELECT COUNT(*) INTO n FROM voucher_entries
  WHERE company_id=8 AND voucher_id IN(8801,8802,8803,8804);
  IF n<>8 THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_UNEXPECTED_VOUCHER_LINES'; END IF;

  SELECT COUNT(*) INTO n FROM ledger_accounts WHERE company_id=8 AND deleted_at IS NULL
  AND (
    (id=877 AND name='Rent Expense - ERP Shops')
    OR (id=1401 AND name='Accrued Rent Payable' AND account_type='Liability')
    OR (id=352 AND name='CASH')
  );
  IF n<>3 THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_ACCOUNT_IDENTITIES_CHANGED'; END IF;

  -- Original immutable cash credits and already-repaired June payable debits.
  SELECT COUNT(*) INTO n FROM voucher_entries e WHERE e.company_id=8 AND (
     (e.id=30307 AND e.voucher_id=8801 AND e.ledger_account_id=352 AND e.debit_amount=0 AND e.credit_amount=6660)
  OR (e.id=30311 AND e.voucher_id=8803 AND e.ledger_account_id=352 AND e.debit_amount=0 AND e.credit_amount=2500)
  OR (e.id=30308 AND e.voucher_id=8802 AND e.ledger_account_id=1401 AND e.debit_amount=6660 AND e.credit_amount=0)
  OR (e.id=30312 AND e.voucher_id=8804 AND e.ledger_account_id=1401 AND e.debit_amount=2500 AND e.credit_amount=0)
  );
  IF n<>4 THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_CASH_OR_AP_COUNTERPART_CHANGED'; END IF;

  -- Only four exact existing lines may move 877 -> 1401, never amounts.
  SELECT COUNT(*) FILTER(WHERE e.ledger_account_id=877),
         COUNT(*) FILTER(WHERE e.ledger_account_id=1401), COUNT(*)
    INTO old_n,fixed_n,n
  FROM voucher_entries e JOIN (VALUES
    (30306,8801,6660::numeric,0::numeric),
    (30309,8802,0::numeric,6660::numeric),
    (30310,8803,2500::numeric,0::numeric),
    (30313,8804,0::numeric,2500::numeric)
  ) x(entry_id,voucher_id,dr,cr) ON e.id=x.entry_id
  WHERE e.company_id=8 AND e.voucher_id=x.voucher_id
    AND e.debit_amount=x.dr AND e.credit_amount=x.cr
    AND e.ledger_account_id IN(877,1401);
  IF n<>4 OR NOT ((old_n=4 AND fixed_n=0) OR (old_n=0 AND fixed_n=4))
  THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_TARGET_STATE_CHANGED'; END IF;

  -- Each June payment is already posted against its real month.
  SELECT COUNT(*) INTO n FROM property_payments p
    JOIN property_monthly_ledger m ON m.id=p.ledger_row_id AND m.company_id=p.company_id
  WHERE p.company_id=8 AND p.posting_status='POSTED'
    AND m.year=2026 AND m.month=6 AND (
    (p.id=246 AND p.voucher_id=8801 AND p.contract_id=16 AND p.amount=6660)
 OR (p.id=247 AND p.voucher_id=8803 AND p.contract_id=17 AND p.amount=2500)
  );
  IF n<>2 THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_MONTHLY_PAYMENT_LINK_CHANGED'; END IF;

  SELECT COALESCE(SUM(e.debit_amount),0), COALESCE(SUM(e.credit_amount),0)
    INTO expense_dr,expense_cr FROM voucher_entries e JOIN vouchers v
    ON v.id=e.voucher_id AND v.company_id=e.company_id
  WHERE e.company_id=8 AND e.ledger_account_id=877
    AND v.deleted_at IS NULL AND v.optional=FALSE;
  SELECT COALESCE(SUM(e.debit_amount),0), COALESCE(SUM(e.credit_amount),0)
    INTO payable_dr,payable_cr FROM voucher_entries e JOIN vouchers v
    ON v.id=e.voucher_id AND v.company_id=e.company_id
  WHERE e.company_id=8 AND e.ledger_account_id=1401
    AND v.deleted_at IS NULL AND v.optional=FALSE;

  IF (old_n=4 AND NOT (expense_dr=158320 AND expense_cr=9160 AND payable_dr=81360 AND payable_cr=81360))
  OR (fixed_n=4 AND NOT (expense_dr=149160 AND expense_cr=0 AND payable_dr=90520 AND payable_cr=90520))
  THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_UNEXPECTED_BEFORE_BALANCES exp:%/% payable:%/%',
    expense_dr,expense_cr,payable_dr,payable_cr; END IF;

  SELECT string_agg(e.id||':'||e.ledger_account_id||':'||e.debit_amount||':'||e.credit_amount,',' ORDER BY e.id)
    INTO cash_before FROM voucher_entries e
  WHERE e.company_id=8 AND e.id IN(30307,30311);

  IF fixed_n=4 THEN
    RAISE NOTICE 'Already corrected: expense Dr 149160/Cr 0, payable 0 net, CASH unchanged';
    RETURN;
  END IF;

  UPDATE voucher_entries e SET ledger_account_id=1401
  FROM (VALUES (30306,8801),(30309,8802),(30310,8803),(30313,8804)) x(entry_id,voucher_id)
  WHERE e.company_id=8 AND e.id=x.entry_id AND e.voucher_id=x.voucher_id
    AND e.ledger_account_id=877;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>4 THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_UPDATE_COUNT_%',changed; END IF;

  SELECT COALESCE(SUM(e.debit_amount),0), COALESCE(SUM(e.credit_amount),0)
    INTO expense_dr,expense_cr FROM voucher_entries e JOIN vouchers v
    ON v.id=e.voucher_id AND v.company_id=e.company_id
  WHERE e.company_id=8 AND e.ledger_account_id=877
    AND v.deleted_at IS NULL AND v.optional=FALSE;
  SELECT COALESCE(SUM(e.debit_amount),0), COALESCE(SUM(e.credit_amount),0)
    INTO payable_dr,payable_cr FROM voucher_entries e JOIN vouchers v
    ON v.id=e.voucher_id AND v.company_id=e.company_id
  WHERE e.company_id=8 AND e.ledger_account_id=1401
    AND v.deleted_at IS NULL AND v.optional=FALSE;
  SELECT string_agg(e.id||':'||e.ledger_account_id||':'||e.debit_amount||':'||e.credit_amount,',' ORDER BY e.id)
    INTO cash_after FROM voucher_entries e
  WHERE e.company_id=8 AND e.id IN(30307,30311);
  IF expense_dr<>149160 OR expense_cr<>0
    OR payable_dr<>90520 OR payable_cr<>90520
    OR cash_before IS DISTINCT FROM cash_after
  THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_FAILED_POST_VERIFICATION'; END IF;

  -- Verify each original journal and payment remains debit/credit balanced.
  IF EXISTS (
    SELECT 1 FROM voucher_entries WHERE company_id=8 AND voucher_id IN(8801,8802,8803,8804)
    GROUP BY voucher_id HAVING SUM(debit_amount)<>SUM(credit_amount)
  ) THEN RAISE EXCEPTION 'KIN_JUNE_GROSS_UNBALANCED_ORIGINAL_VOUCHERS'; END IF;

  FOR target IN SELECT * FROM (VALUES
    (30306,8801,6660::numeric,'debit'),
    (30309,8802,6660::numeric,'credit'),
    (30310,8803,2500::numeric,'debit'),
    (30313,8804,2500::numeric,'credit')
  ) x(entry_id,voucher_id,amount,side)
  LOOP
    INSERT INTO audit_log(user_id,username,company_id,action,table_name,
      record_id,record_identifier,reason,changes)
    VALUES ('system:hmd-kinshasa-june-gross-20261110',
     'Owner-approved June gross rent repair',8,'repair','voucher_entries',
     target.entry_id,'Original June rent voucher '||target.voucher_id,
     'Reclassify historical duplicate expense/payable clearing to same liability while preserving original voucher, amount, cash, and GL net balances',
     jsonb_build_object(
       'ledger_account_id',jsonb_build_object('old',877,'new',1401),
       'amount',target.amount,'side',target.side,'voucher_id',target.voucher_id));
  END LOOP;
  RAISE NOTICE 'June gross rent corrected in-place: Dr expense 13560 Cr 0; all account net balances unchanged; CASH untouched; 0 new vouchers';
END
$rent_june$;

COMMIT;
