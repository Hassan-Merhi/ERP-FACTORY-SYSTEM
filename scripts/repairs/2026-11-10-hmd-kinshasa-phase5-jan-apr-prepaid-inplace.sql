-- HMD KINSHASA (company 8) — Jan-Apr 2026 prepaid rent periodization.
-- REVIEWED OWNER-APPROVED HISTORICAL CORRECTION: preserves Jan 1 CASH, originals
-- and payment allocations; adjusts three original voucher debit lines in place,
-- adds THREE Prepaid Rent debit lines to those SAME vouchers, creates ONE noncash
-- recognition voucher per Feb/Mar/Apr. No reversal/cash voucher is created.
--
-- Effect on Rent Expense #877: Jan/Feb/Mar/Apr each Dr 13,560 / Cr 0.
-- Jan CASH #352 original voucher credits: 10,000 + 17,600 + 26,640 = 54,240
-- remain 100% unchanged, including voucher dates and original total_amount.
-- Jan Prepaid Rent asset: Dr 40,680. Feb-Mar-Apr: Cr 13,560 each, ending $0.
-- Year-to-date Rent Expense net and all other existing account balances are unchanged.
-- The related June gross correction is a SEPARATE SQL file (PR #3110).
--
-- After historical correction, original source payment numbers and payment records
-- are retained; the Feb-Apr recognition vouchers become each month's accrual link.
--
-- Execute ENTIRE file in TablePlus as one script against the exact production DB.
-- WARNING: pg trigger guards are active and must not be disabled. Any mismatch
-- aborts and rolls back; no bypass of ledger integrity or fiscal period closures.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';
SELECT set_config('app.company_scope_maintenance', 'off', true);
SELECT set_config('app.current_company_id', '8', true);
SELECT set_config('app.authorized_company_ids', '', true);
SELECT set_config('app.current_actor', 'system:hmd-kinshasa-jan-apr-prepaid-20261110', true);
SELECT set_config('app.current_actor_name', 'Owner-approved historic rent periodization', true);
SELECT set_config('app.audit_reason',
 'Jan-Apr 2026: split rent expense/prepaid in ORIGINAL payment vouchers and recognize Feb-Apr with cash-free journals; preserve cash', true);

DO $jan_apr$
DECLARE
  v_count integer;
  v_changed integer;
  v_prepaid_id integer;
  v_month integer;
  v_month_date date;
  v_new_voucher integer;
  v_month_number text;
  v_cash_before text;
  v_cash_after text;
  v_cash_dr_before numeric;
  v_cash_cr_before numeric;
  v_cash_dr_after numeric;
  v_cash_cr_after numeric;
  v_877_before numeric;
  v_877_after numeric;
  v_1401_before numeric;
  v_1401_after numeric;
  v_expense_month record;
  v_prepaid_month record;
  v_pay record;
  v_log record;
BEGIN
  IF current_database() <> 'erp_db_qscj_64lv_e7rz_8744_2lm3'
    OR current_setting('app.current_company_id',true) <> '8'
  THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_WRONG_DATABASE_OR_COMPANY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hmd-kinshasa-2026-jan-apr-prepaid'));
  IF NOT EXISTS (
    SELECT 1 FROM companies WHERE id=8 AND name='HMD KINSHASA' AND active=TRUE
  ) THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_COMPANY_NOT_FOUND'; END IF;

  -- Closed periods must never be rewritten.
  IF EXISTS (
    SELECT 1 FROM fiscal_period_closures f WHERE f.company_id=8
     AND f.status='CLOSED'
     AND COALESCE(f.period_start_date,f.period_start) <= DATE '2026-04-30'
     AND COALESCE(f.period_end_date,f.period_end) >= DATE '2026-01-01'
  ) THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_FISCAL_PERIOD_CLOSED'; END IF;

  -- Do not create duplicate Prepaid Rent accounts or recognition journals.
  SELECT COUNT(*) INTO v_count FROM ledger_accounts
   WHERE company_id=8 AND (name='Prepaid Rent' OR code='PREP-RENT-HMDKIN-2026');
  IF v_count<>0 THEN RAISE EXCEPTION
   'KIN_RENT_JAN_APR_PREPAID_ACCOUNT_ALREADY_PRESENT_REVIEW_MANUALLY';
  END IF;
  SELECT COUNT(*) INTO v_count FROM vouchers
   WHERE voucher_number IN (
      'HMDKIN-RENT-REC-2026-02','HMDKIN-RENT-REC-2026-03',
      'HMDKIN-RENT-REC-2026-04');
  IF v_count<>0 THEN RAISE EXCEPTION
    'KIN_RENT_JAN_APR_RECOGNITION_VOUCHER_ALREADY_PRESENT_REVIEW_MANUALLY';
  END IF;

  -- Verify exact immutable source identities and timing.
  PERFORM 1 FROM vouchers WHERE company_id=8 AND id IN(6470,6475,6476)
    ORDER BY id FOR UPDATE;
  PERFORM 1 FROM voucher_entries
    WHERE company_id=8 AND voucher_id IN(6470,6475,6476)
    ORDER BY id FOR UPDATE;
  PERFORM 1 FROM property_monthly_ledger
    WHERE company_id=8 AND module='ERP' AND year=2026
      AND month BETWEEN 1 AND 4 AND contract_id IN(15,16,17)
    ORDER BY id FOR UPDATE;
  PERFORM 1 FROM property_payments WHERE company_id=8 AND id IN
      (81,82,83,84,92,93,94,95,96,97,98,99)
    ORDER BY id FOR UPDATE;

  SELECT COUNT(*) INTO v_count FROM vouchers v WHERE v.company_id=8
    AND v.deleted_at IS NULL AND v.optional=FALSE
    AND v.posted_by_engine=FALSE AND v.voucher_type='Payment'
    AND v.voucher_date=DATE '2026-01-01' AND v.effective_date IS NULL
    AND v.currency='USD' AND v.source_module='ERP' AND (
      (v.id=6470 AND v.voucher_number='RENT-1776936115329-17'
       AND v.total_amount=10000)
   OR (v.id=6475 AND v.voucher_number='RENT-1776936857209-15'
       AND v.total_amount=17600)
   OR (v.id=6476 AND v.voucher_number='RENT-1776936932852-16'
       AND v.total_amount=26640)
    );
  IF v_count<>3 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_SOURCE_VOUCHERS_CHANGED'; END IF;

  SELECT COUNT(*) INTO v_count FROM voucher_entries e
   WHERE e.company_id=8 AND e.voucher_id IN(6470,6475,6476);
  IF v_count<>6 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_SOURCE_LINE_COUNT_CHANGED'; END IF;

  -- Three original debit lines; original cash credit lines MUST NOT be edited.
  SELECT COUNT(*) INTO v_count FROM voucher_entries e WHERE e.company_id=8
   AND (
     (e.id=22659 AND e.voucher_id=6470 AND e.ledger_account_id=877
       AND e.debit_amount=10000 AND COALESCE(e.credit_amount,0)=0)
     OR (e.id=22675 AND e.voucher_id=6475 AND e.ledger_account_id=877
       AND e.debit_amount=17600 AND COALESCE(e.credit_amount,0)=0)
     OR (e.id=22677 AND e.voucher_id=6476 AND e.ledger_account_id=877
       AND e.debit_amount=26640 AND COALESCE(e.credit_amount,0)=0)
     OR (e.id=22660 AND e.voucher_id=6470 AND e.ledger_account_id=352
       AND e.credit_amount=10000 AND COALESCE(e.debit_amount,0)=0)
     OR (e.id=22676 AND e.voucher_id=6475 AND e.ledger_account_id=352
       AND e.credit_amount=17600 AND COALESCE(e.debit_amount,0)=0)
     OR (e.id=22678 AND e.voucher_id=6476 AND e.ledger_account_id=352
       AND e.credit_amount=26640 AND COALESCE(e.debit_amount,0)=0)
   );
  IF v_count<>6 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_ORIGINAL_DEBITS_OR_CASH_CHANGED'; END IF;

  SELECT COUNT(*) INTO v_count FROM ledger_accounts a
  WHERE a.company_id=8 AND a.deleted_at IS NULL AND a.active=TRUE
    AND ((a.id=877 AND a.name='Rent Expense - ERP Shops'
                  AND a.account_type='Indirect Expense'
                  AND COALESCE(a.opening_balance,0)=0)
      OR (a.id=352 AND a.name='CASH')
      OR (a.id=1401 AND a.name='Accrued Rent Payable'
                   AND a.account_type='Liability'));
  IF v_count<>3 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_GL_ACCOUNT_IDENTITIES_CHANGED'; END IF;

  -- Check all twelve Jan-Apr month rows and their one-time payment allocations.
  SELECT COUNT(*) INTO v_count FROM (
   SELECT m.id
   FROM property_monthly_ledger m
   JOIN property_payments p ON p.ledger_row_id=m.id
       AND p.company_id=8 AND p.module='ERP'
   WHERE m.company_id=8 AND m.module='ERP' AND m.year=2026
     AND m.month BETWEEN 1 AND 4 AND m.contract_id IN(15,16,17)
     AND m.accrual_voucher_id IS NULL AND m.used_prepaid_account=FALSE
     AND m.used_advance_account=FALSE
     AND m.notes LIKE '[RENT_RECOGNITION_HOLD]%'
     AND m.expected_amount=m.paid_amount
     AND (
       (m.contract_id=15 AND m.expected_amount=4400 AND p.voucher_id=6475)
    OR (m.contract_id=16 AND m.expected_amount=6660 AND p.voucher_id=6476)
    OR (m.contract_id=17 AND m.expected_amount=2500 AND p.voucher_id=6470)
     )
     AND p.posting_status='POSTED' AND p.payment_date=DATE '2026-01-01'
     AND p.amount=m.expected_amount
     AND p.for_year=2026 AND p.for_month=m.month
   GROUP BY m.id
   HAVING COUNT(*)=1
  ) v;
  IF v_count<>12 THEN RAISE EXCEPTION
    'KIN_RENT_JAN_APR_RENT_PAYMENT_LINKS_CHANGED_EXPECT_12_FOUND_%',v_count;
  END IF;

  SELECT COUNT(*) INTO v_count FROM property_payments p
   WHERE p.company_id=8 AND p.voucher_id IN(6470,6475,6476);
  IF v_count<>12 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_SOURCE_HAS_EXTRA_PAYMENT_LINKS'; END IF;

  SELECT COALESCE(SUM(e.debit_amount-e.credit_amount),0)
    INTO v_877_before FROM voucher_entries e
    JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
   WHERE e.company_id=8 AND e.ledger_account_id=877
     AND v.deleted_at IS NULL AND v.optional=FALSE;
  SELECT COALESCE(SUM(e.debit_amount-e.credit_amount),0)
    INTO v_1401_before FROM voucher_entries e
    JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
   WHERE e.company_id=8 AND e.ledger_account_id=1401
     AND v.deleted_at IS NULL AND v.optional=FALSE;
  IF v_877_before<>149160 OR v_1401_before<>0 THEN
    RAISE EXCEPTION 'KIN_RENT_JAN_APR_CURRENT_NET_BALANCES_DRIFT: expense %, payable %',
      v_877_before,v_1401_before;
  END IF;

  -- Capture exact CASH #352 company-wide entry identity + values. Fail if changed.
  SELECT md5(COALESCE(string_agg(
         e.id::text||':'||e.voucher_id||':'||COALESCE(e.debit_amount,0)
         ||':'||COALESCE(e.credit_amount,0)||':'||COALESCE(e.ledger_account_id,0)
         ||':'||COALESCE(e.transaction_debit_amount,0)||':'||COALESCE(e.transaction_credit_amount,0)
         ||':'||COALESCE(e.base_debit_amount,0)||':'||COALESCE(e.base_credit_amount,0),
         ',' ORDER BY e.id),'')),
         COALESCE(SUM(e.debit_amount),0),
         COALESCE(SUM(e.credit_amount),0)
    INTO v_cash_before,v_cash_dr_before,v_cash_cr_before
    FROM voucher_entries e WHERE e.company_id=8 AND e.ledger_account_id=352;

  -- A new zero-opening current asset is required; company 8 has no Prepaid Rent.
  INSERT INTO ledger_accounts(company_id,code,name,account_type,sub_type,
    opening_balance,opening_balance_side,active)
  VALUES(8,'PREP-RENT-HMDKIN-2026','Prepaid Rent','Asset','Current Asset',
         0,'Dr',TRUE)
  RETURNING id INTO v_prepaid_id;

  -- Allocate each ORIGINAL January payment into Jan's rent and Feb-Apr prepaid.
  -- Voucher ids/dates/total_amount/CASH entries are immutable.
  UPDATE voucher_entries e SET debit_amount=x.jan_expense
   FROM (VALUES (22659,6470,2500::numeric),
                (22675,6475,4400::numeric),
                (22677,6476,6660::numeric)
        ) x(entry_id,voucher_id,jan_expense)
  WHERE e.id=x.entry_id AND e.voucher_id=x.voucher_id
    AND e.company_id=8 AND e.ledger_account_id=877;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>3 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_ORIGINAL_DEBIT_UPDATE_FAILED'; END IF;

  INSERT INTO voucher_entries(company_id,voucher_id,ledger_account_id,
    debit_amount,credit_amount,narration)
  VALUES
    (8,6470,v_prepaid_id,7500,0,'Feb-Apr 2026 prepaid STAFF HOUSE (3 x $2,500)'),
    (8,6475,v_prepaid_id,13200,0,'Feb-Apr 2026 prepaid KINSHASA #1 (3 x $4,400)'),
    (8,6476,v_prepaid_id,19980,0,'Feb-Apr 2026 prepaid KINSHASA #2 (3 x $6,660)');
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>3 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_PREPAID_SPLIT_INSERT_FAILED'; END IF;

  -- Jan service month is directly expensed, with remaining 3 months prepaid.
  UPDATE property_monthly_ledger m
     SET notes='[RENT_RECOGNITION_HOLD] Jan 2026 directly expensed from original Jan 1 cash payment; Feb-Apr prepaid portion moved within the same original voucher; historical duplicate accrual 8534 remains deleted.'
   WHERE m.company_id=8 AND m.module='ERP' AND m.year=2026 AND m.month=1
     AND m.contract_id IN(15,16,17);
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>3 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_JAN_HOLD_UPDATE_FAILED'; END IF;

  -- The only new vouchers are noncash accrual/recognition journals dated per month.
  FOR v_month IN 2..4 LOOP
    v_month_date:=make_date(2026,v_month,1);
    v_month_number:=lpad(v_month::text,2,'0');
    INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,
        description,total_amount,optional,currency,source_module,posted_by_engine)
    VALUES (8,'HMDKIN-RENT-REC-2026-'||v_month_number,'Journal',v_month_date,
        'Historical rent expense recognition for '||to_char(v_month_date,'Mon YYYY')||
        ' from January original prepaid cash vouchers 6470/6475/6476',
        13560,FALSE,'USD','ERP',FALSE)
    RETURNING id INTO v_new_voucher;

    INSERT INTO voucher_entries(company_id,voucher_id,ledger_account_id,
          debit_amount,credit_amount,narration)
    VALUES
      (8,v_new_voucher,877,4400,0,'KINSHASA #1 - '||to_char(v_month_date,'Mon YYYY')),
      (8,v_new_voucher,877,6660,0,'KINSHASA #2 - '||to_char(v_month_date,'Mon YYYY')),
      (8,v_new_voucher,877,2500,0,'STAFF HOUSE - '||to_char(v_month_date,'Mon YYYY')),
      (8,v_new_voucher,v_prepaid_id,0,13560,
         'Release Jan cash prepaid asset: '||to_char(v_month_date,'Mon YYYY'));
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>4 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_RECOGNITION_LINES_WRONG'; END IF;

    UPDATE property_monthly_ledger m
       SET accrual_voucher_id=v_new_voucher,
           used_prepaid_account=TRUE,
           notes='[RENT_RECOGNITION_HOLD] Historical '||to_char(v_month_date,'Mon YYYY')||
                ' prepaid rent recognized once via '||
                'HMDKIN-RENT-REC-2026-'||v_month_number||
                '; original January rent payment/cash voucher retained unchanged; deleted accrual 8534 must not repost.'
     WHERE m.company_id=8 AND m.module='ERP' AND m.year=2026
       AND m.month=v_month AND m.contract_id IN(15,16,17)
       AND m.accrual_voucher_id IS NULL;
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>3 THEN RAISE EXCEPTION
       'KIN_RENT_JAN_APR_RECOGNITION_MONTH_LINK_FAILED_%',v_month; END IF;

    INSERT INTO audit_log(user_id,username,company_id,action,table_name,
       record_id,record_identifier,reason,changes)
    VALUES ('system:hmd-kinshasa-jan-apr-prepaid-20261110',
      'Owner-approved historic rent periodization',8,'repair','vouchers',v_new_voucher,
      'HMDKIN-RENT-REC-2026-'||v_month_number,
      'Cash-free monthly rent recognition from original January prepaid payment',
      jsonb_build_object('month',v_month,'amount',13560,'dr_account',877,
       'cr_prepaid_account',v_prepaid_id,'original_payment_vouchers',jsonb_build_array(6470,6475,6476)));
  END LOOP;

  -- ORIGINAL vouchers remain exactly balanced, with unchanged originals/cash.
  IF EXISTS (
    SELECT 1 FROM vouchers v JOIN voucher_entries e
      ON e.voucher_id=v.id AND e.company_id=v.company_id
    WHERE v.company_id=8 AND v.id IN(6470,6475,6476)
    GROUP BY v.id,v.total_amount
    HAVING COUNT(*)<>3 OR SUM(e.debit_amount)<>v.total_amount
         OR SUM(e.credit_amount)<>v.total_amount
  ) THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_ORIGINAL_PAYMENT_VOUCHERS_NOT_BALANCED'; END IF;

  -- New journals have three expense debits and one prepaid credit, no CASH.
  SELECT COUNT(*) INTO v_count FROM (
    SELECT v.id
    FROM vouchers v JOIN voucher_entries e
      ON e.voucher_id=v.id AND e.company_id=v.company_id
    WHERE v.company_id=8
      AND v.voucher_number IN (
        'HMDKIN-RENT-REC-2026-02','HMDKIN-RENT-REC-2026-03',
        'HMDKIN-RENT-REC-2026-04')
    GROUP BY v.id
    HAVING COUNT(*)=4 AND SUM(e.debit_amount)=13560
      AND SUM(e.credit_amount)=13560
      AND COUNT(*) FILTER(WHERE e.ledger_account_id=877 AND e.debit_amount>0)=3
      AND COUNT(*) FILTER(WHERE e.ledger_account_id=v_prepaid_id AND e.credit_amount=13560)=1
      AND COUNT(*) FILTER(WHERE e.ledger_account_id=352)=0
  ) v;
  IF v_count<>3 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_NEW_JOURNALS_NOT_BALANCED'; END IF;

  -- EXACT historic monthly rent ledger: Jan-Apr each gross Dr 13560/Cr 0.
  FOR v_expense_month IN
    SELECT EXTRACT(MONTH FROM v.voucher_date)::integer AS m,
       COALESCE(SUM(e.debit_amount),0) AS dr,
       COALESCE(SUM(e.credit_amount),0) AS cr
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=v.company_id
    WHERE v.company_id=8 AND v.deleted_at IS NULL AND v.optional=FALSE
      AND e.ledger_account_id=877
      AND v.voucher_date BETWEEN DATE '2026-01-01' AND DATE '2026-04-30'
    GROUP BY EXTRACT(MONTH FROM v.voucher_date)
  LOOP
    IF v_expense_month.m NOT BETWEEN 1 AND 4
       OR v_expense_month.dr<>13560 OR v_expense_month.cr<>0 THEN
       RAISE EXCEPTION 'KIN_RENT_JAN_APR_EXPENSE_MONTH_WRONG_%_%_%',
         v_expense_month.m,v_expense_month.dr,v_expense_month.cr;
    END IF;
  END LOOP;
  SELECT COUNT(*) INTO v_count FROM (
    SELECT EXTRACT(MONTH FROM v.voucher_date) AS m
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
    WHERE e.company_id=8 AND e.ledger_account_id=877
      AND v.deleted_at IS NULL AND v.optional=FALSE
      AND v.voucher_date BETWEEN DATE '2026-01-01' AND DATE '2026-04-30'
    GROUP BY 1
  ) q;
  IF v_count<>4 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_EXPENSE_MONTHS_MISSING'; END IF;

  SELECT COALESCE(SUM(e.debit_amount-e.credit_amount),0)
    INTO v_877_after FROM voucher_entries e
    JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
   WHERE e.company_id=8 AND e.ledger_account_id=877
     AND v.deleted_at IS NULL AND v.optional=FALSE;
  SELECT COALESCE(SUM(e.debit_amount-e.credit_amount),0)
    INTO v_1401_after FROM voucher_entries e
    JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
   WHERE e.company_id=8 AND e.ledger_account_id=1401
     AND v.deleted_at IS NULL AND v.optional=FALSE;
  IF v_877_after<>v_877_before OR v_1401_after<>v_1401_before
  THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_CHANGED_OTHER_BALANCE_EXP_%_TO_%_PAYABLE_%_TO_%',
      v_877_before,v_877_after,v_1401_before,v_1401_after; END IF;

  -- Prepaid Rent: +40680 in Jan, -13560 in each Feb-Apr, zero overall.
  -- Group first, then validate each grouped month. PostgreSQL cannot refer
  -- to the ungrouped voucher_date in HAVING when GROUP BY targets its month.
  SELECT COUNT(*) INTO v_count FROM (
    SELECT EXTRACT(MONTH FROM v.voucher_date)::integer AS m,
      SUM(e.debit_amount-e.credit_amount) AS net
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
    WHERE e.company_id=8 AND e.ledger_account_id=v_prepaid_id
      AND v.deleted_at IS NULL AND v.optional=FALSE
    GROUP BY 1
  ) months
  WHERE (m=1 AND net=40680)
     OR (m BETWEEN 2 AND 4 AND net=-13560);
  IF v_count<>4 THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_PREPAID_RECOGNITION_INCORRECT'; END IF;
  IF EXISTS (
    SELECT 1 FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
    WHERE e.company_id=8 AND e.ledger_account_id=v_prepaid_id
      AND v.deleted_at IS NULL AND v.optional=FALSE
    GROUP BY e.ledger_account_id
    HAVING SUM(e.debit_amount-e.credit_amount)<>0
  ) THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_PREPAID_FINAL_NOT_ZERO'; END IF;

  -- All company 8 CASH lines, gross balances and fingerprints are unchanged.
  SELECT md5(COALESCE(string_agg(
         e.id::text||':'||e.voucher_id||':'||COALESCE(e.debit_amount,0)
         ||':'||COALESCE(e.credit_amount,0)||':'||COALESCE(e.ledger_account_id,0)
         ||':'||COALESCE(e.transaction_debit_amount,0)||':'||COALESCE(e.transaction_credit_amount,0)
         ||':'||COALESCE(e.base_debit_amount,0)||':'||COALESCE(e.base_credit_amount,0),
         ',' ORDER BY e.id),'')),
         COALESCE(SUM(e.debit_amount),0),
         COALESCE(SUM(e.credit_amount),0)
    INTO v_cash_after,v_cash_dr_after,v_cash_cr_after
    FROM voucher_entries e WHERE e.company_id=8 AND e.ledger_account_id=352;
  IF v_cash_before IS DISTINCT FROM v_cash_after
      OR v_cash_dr_before<>v_cash_dr_after OR v_cash_cr_before<>v_cash_cr_after
  THEN RAISE EXCEPTION 'KIN_RENT_JAN_APR_CASH_CHANGED_ROLLBACK'; END IF;

  INSERT INTO audit_log(user_id,username,company_id,action,table_name,
      record_identifier,reason,changes)
  VALUES ('system:hmd-kinshasa-jan-apr-prepaid-20261110',
    'Owner-approved historic rent periodization',8,'repair','voucher_entries',
    'HMD KINSHASA Jan-Apr 2026 original rent payments 6470/6475/6476',
    'Original voucher expense debit split into Jan rent plus Feb-Apr Prepaid Rent; cash and all original voucher identity/dates/amount unchanged; 3 cash-free journals for Feb-Apr',
    jsonb_build_object('company_id',8,'original_vouchers',
      jsonb_build_array(6470,6475,6476),'original_cash_total',54240,
      'original_debits',jsonb_build_array(22659,22675,22677),
      'prepaid_account_id',v_prepaid_id,'jan_rent_expense',13560,
      'feb_apr_prepaid',40680,'new_recognition_vouchers',
      jsonb_build_array('HMDKIN-RENT-REC-2026-02','HMDKIN-RENT-REC-2026-03','HMDKIN-RENT-REC-2026-04'),
      'cash_hash_before',v_cash_before,'cash_hash_after',v_cash_after));

  RAISE NOTICE 'HMD KINSHASA Jan-Apr DONE: Jan, Feb, Mar, Apr rent expense each 13,560 Dr/0 Cr; existing 3 January cash vouchers preserved; 3 new NONCASH journals; Prepaid Rent zero as of Apr 30; GL yearly net unchanged; CASH %/% unchanged.',
      v_cash_dr_after,v_cash_cr_after;
END
$jan_apr$;
COMMIT;
