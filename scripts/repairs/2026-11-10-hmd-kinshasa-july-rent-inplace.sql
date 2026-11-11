-- HMD KINSHASA / ERP Shops — PHASE 2, existing vouchers only.
-- DANGER: This file mutates accounting ledger classifications if and only if
-- every source, settlement, and current-balance invariant still holds.
-- Run once on the production ERP database using an authorized SQL session.
-- Never run on another company; do not substitute accounts or voucher IDs.
-- NO INSERT into vouchers, voucher_entries, payments, or monthly ledgers.
-- This transaction keeps original voucher IDs, line IDs, cash, dates, guarantees,
-- prepaid rent, and original amounts unchanged. Only three ledger_account_id
-- references change; audit_log records are required inside the same transaction.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('app.company_scope_maintenance', 'off', true);
SELECT set_config('app.current_company_id', '8', true);
SELECT set_config('app.authorized_company_ids', '', true);
SELECT set_config('app.current_actor', 'system:hmd-kinshasa-july-rent-20261110', true);
SELECT set_config('app.current_actor_name', 'Owner-approved rental voucher correction', true);
SELECT set_config('app.audit_reason', 'Owner-approved in-place correction of three July 2026 HMD KINSHASA rent payment vouchers; no new vouchers or cash changes', true);

DO $repair$
DECLARE
  v_count int;
  v_status text;
  expense_before numeric;
  payable_before numeric;
  expense_after numeric;
  payable_after numeric;
  cash_before numeric;
  cash_after numeric;
  updated_count int;
  target record;
BEGIN
  IF current_database() <> 'erp_db_qscj_64lv_e7rz_8744_2lm3'
    OR current_setting('app.current_company_id', true) <> '8'
    OR current_setting('app.company_scope_maintenance', true) <> 'off'
  THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_WRONG_DATABASE_OR_TENANT';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('hmd-kinshasa-rent-20260713-entry-reclass'));

  IF NOT EXISTS (SELECT 1 FROM companies WHERE id=8 AND name='HMD KINSHASA' AND active=TRUE) THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_COMPANY_CHANGED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM fiscal_period_closures
    WHERE company_id=8 AND status='CLOSED' AND period_end_date >= DATE '2026-07-13'
  ) THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_CLOSED_PERIOD';
  END IF;

  -- Verify all ledger-account identities; no substitute or auto-created account.
  SELECT COUNT(*) INTO v_count FROM ledger_accounts a
  WHERE a.company_id=8 AND a.deleted_at IS NULL AND (
    (a.id=877 AND a.name='Rent Expense - ERP Shops' AND a.account_type='Indirect Expense'
      AND COALESCE(a.opening_balance,0)=0)
    OR (a.id=1401 AND a.name='Accrued Rent Payable' AND a.account_type='Liability'
      AND COALESCE(a.opening_balance,0)=0)
    OR (a.id=352 AND a.name='CASH')
  );
  IF v_count<>3 THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_ACCOUNTS_CHANGED';
  END IF;

  -- Lock the four original voucher headers and ten original journal lines.
  PERFORM 1 FROM vouchers
  WHERE company_id=8 AND id IN (9960,10579,10580,10581)
  ORDER BY id FOR UPDATE;
  PERFORM 1 FROM voucher_entries
  WHERE company_id=8 AND voucher_id IN (9960,10579,10580,10581)
  ORDER BY id FOR UPDATE;

  SELECT COUNT(*) INTO v_count FROM vouchers v WHERE v.company_id=8
    AND v.deleted_at IS NULL AND v.optional=FALSE AND v.currency='USD' AND (
      (v.id=9960  AND v.voucher_type='Journal' AND v.voucher_date=DATE '2026-07-02'
          AND v.voucher_number='ACCR-RENT-1782986400048-mtod' AND v.total_amount=13560)
      OR (v.id=10579 AND v.voucher_type='Payment' AND v.voucher_date=DATE '2026-07-13'
          AND v.voucher_number='RENT-1783946644356-o4aoz-15' AND v.total_amount=4400)
      OR (v.id=10580 AND v.voucher_type='Payment' AND v.voucher_date=DATE '2026-07-13'
          AND v.voucher_number='RENT-1783946644530-vnt3e-16' AND v.total_amount=6660)
      OR (v.id=10581 AND v.voucher_type='Payment' AND v.voucher_date=DATE '2026-07-13'
          AND v.voucher_number='RENT-1783946644827-2sx6z-17' AND v.total_amount=2500)
    );
  IF v_count<>4 THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_ORIGINAL_VOUCHERS_CHANGED';
  END IF;

  -- Original accrual is valid and must NOT be reversed or replaced.
  SELECT COUNT(*) INTO v_count FROM voucher_entries e WHERE e.company_id=8
    AND e.voucher_id=9960 AND (
      (e.id=45610 AND e.ledger_account_id=877  AND e.debit_amount=6660  AND e.credit_amount=0)
      OR (e.id=45611 AND e.ledger_account_id=877  AND e.debit_amount=2500  AND e.credit_amount=0)
      OR (e.id=45612 AND e.ledger_account_id=877  AND e.debit_amount=4400  AND e.credit_amount=0)
      OR (e.id=45613 AND e.ledger_account_id=1401 AND e.debit_amount=0 AND e.credit_amount=13560)
    );
  IF v_count<>4 OR (SELECT COUNT(*) FROM voucher_entries
                     WHERE company_id=8 AND voucher_id=9960)<>4 THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_JULY_ACCRUAL_CHANGED';
  END IF;

  -- The rental-month references are still the three original fully paid July rows.
  SELECT COUNT(*) INTO v_count
  FROM property_monthly_ledger m
  JOIN (VALUES
    (637546,15,40,4400::numeric),
    (113144,16,41,6660::numeric),
    (637539,17,42,2500::numeric)
  ) AS expected(id,contract_id,unit_id,rent)
  ON m.id=expected.id
  WHERE m.company_id=8 AND m.module='ERP'
    AND m.contract_id=expected.contract_id AND m.unit_id=expected.unit_id
    AND m.year=2026 AND m.month=7
    AND m.expected_amount=expected.rent AND m.paid_amount=expected.rent
    AND m.accrual_voucher_id=9960 AND m.used_prepaid_account=FALSE
    AND m.used_advance_account=FALSE;
  IF v_count<>3 THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_MONTHLY_ROWS_CHANGED';
  END IF;

  -- Every payment must still point to its original voucher, July month and lease.
  SELECT COUNT(*) INTO v_count FROM property_payments p
  JOIN (VALUES
    (303,15,637546,10579,4400::numeric),
    (304,16,113144,10580,6660::numeric),
    (305,17,637539,10581,2500::numeric)
  ) AS expected(id,contract_id,ledger_row_id,voucher_id,amount)
    ON p.id=expected.id
  WHERE p.company_id=8 AND p.module='ERP'
    AND p.contract_id=expected.contract_id
    AND p.ledger_row_id=expected.ledger_row_id
    AND p.voucher_id=expected.voucher_id
    AND p.amount=expected.amount AND p.payment_date=DATE '2026-07-13'
    AND p.for_year=2026 AND p.for_month=7 AND p.posting_status='POSTED';
  IF v_count<>3 THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_PAYMENT_LINKS_CHANGED';
  END IF;

  -- The unchanged credits on original Payment vouchers must still be to CASH.
  SELECT COUNT(*) INTO v_count FROM voucher_entries e
  JOIN (VALUES
    (37981,10579,4400::numeric),
    (37983,10580,6660::numeric),
    (37985,10581,2500::numeric)
  ) AS expected(id,voucher_id,amount) ON e.id=expected.id
  WHERE e.company_id=8 AND e.voucher_id=expected.voucher_id
    AND e.ledger_account_id=352 AND e.debit_amount=0 AND e.credit_amount=expected.amount;
  IF v_count<>3
    OR (SELECT COUNT(*) FROM voucher_entries WHERE company_id=8 AND voucher_id IN(10579,10580,10581))<>6
  THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_PAYMENT_CASH_OR_LINE_COUNT_CHANGED';
  END IF;

  SELECT COUNT(*) INTO v_count FROM voucher_entries e
  JOIN (VALUES
    (37980,10579,4400::numeric),
    (37982,10580,6660::numeric),
    (37984,10581,2500::numeric)
  ) AS expected(id,voucher_id,amount) ON e.id=expected.id
  WHERE e.company_id=8 AND e.voucher_id=expected.voucher_id
    AND e.debit_amount=expected.amount AND e.credit_amount=0
    AND e.ledger_account_id IN (877,1401);

  IF v_count<>3 THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_TARGET_ENTRIES_CHANGED';
  END IF;

  SELECT CASE
    WHEN COUNT(*) FILTER (WHERE e.ledger_account_id=877)=3 THEN 'before'
    WHEN COUNT(*) FILTER (WHERE e.ledger_account_id=1401)=3 THEN 'after'
    ELSE 'partial'
  END INTO v_status
  FROM voucher_entries e WHERE e.company_id=8 AND e.id IN (37980,37982,37984);
  IF v_status='partial' THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_PARTIAL_STATE';
  END IF;

  -- Only active, non-optional vouchers are included in the GL balances.
  SELECT
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=877),0),
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1401),0),
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=352),0)
  INTO expense_before,payable_before,cash_before
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=8
  WHERE e.company_id=8 AND v.deleted_at IS NULL AND v.optional=FALSE
    AND e.ledger_account_id IN(877,1401,352);

  IF v_status='after' THEN
    IF expense_before<>149160 OR payable_before<>0 THEN
      RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_PREVIOUS_RUN_STATE_DRIFT';
    END IF;
    RAISE NOTICE 'HMD KINSHASA July rent already corrected; no updates or audit duplicates.';
    RETURN;
  END IF;

  IF expense_before<>162720 OR payable_before<>-13560 THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_PRE_BALANCES_DRIFT: expense=%, payable=%',
      expense_before,payable_before;
  END IF;

  -- Apply ONLY a change of debit account; the original debit amounts stay intact.
  UPDATE voucher_entries e SET ledger_account_id=1401
  FROM (VALUES
    (37980,10579,4400::numeric),
    (37982,10580,6660::numeric),
    (37984,10581,2500::numeric)
  ) AS expected(id,voucher_id,amount)
  WHERE e.id=expected.id AND e.company_id=8
    AND e.voucher_id=expected.voucher_id AND e.ledger_account_id=877
    AND e.debit_amount=expected.amount AND e.credit_amount=0;
  GET DIAGNOSTICS updated_count=ROW_COUNT;
  IF updated_count<>3 THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_UPDATE_COUNT_%',updated_count;
  END IF;

  SELECT
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=877),0),
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1401),0),
    COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=352),0)
  INTO expense_after,payable_after,cash_after
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=8
  WHERE e.company_id=8 AND v.deleted_at IS NULL AND v.optional=FALSE
    AND e.ledger_account_id IN(877,1401,352);

  IF expense_after<>149160 OR payable_after<>0 OR cash_after<>cash_before THEN
    RAISE EXCEPTION 'HMD_KINSHASA_REPAIR_AFTER_BALANCES_DRIFT: expense=%, payable=%, cashDiff=%',
      expense_after,payable_after,cash_after-cash_before;
  END IF;

  -- Required audit rows. Database voucher-entry triggers also see the actor/reason.
  FOR target IN SELECT * FROM (VALUES
    (37980,10579,4400::numeric),
    (37982,10580,6660::numeric),
    (37984,10581,2500::numeric)
  ) AS t(line_id,voucher_id,amount) LOOP
    INSERT INTO audit_log(
      user_id,username,company_id,action,table_name,record_id,
      record_identifier,reason,changes
    ) VALUES (
      'system:hmd-kinshasa-july-rent-20261110',
      'Owner-approved rental voucher correction',
      8,'repair','voucher_entries',target.line_id,
      'HMD KINSHASA July 2026 payment voucher '||target.voucher_id::text,
      'Existing July accrual voucher #9960; reclassify duplicate expense payment debit to Accrued Rent Payable; original voucher/cash retained',
      jsonb_build_object(
        'ledger_account_id',jsonb_build_object('old',877,'new',1401),
        'debit_amount',jsonb_build_object('old',target.amount,'new',target.amount),
        'voucher_id',jsonb_build_object('old',target.voucher_id,'new',target.voucher_id),
        'cash_unchanged',jsonb_build_object('new',true)
      )
    );
  END LOOP;

  RAISE NOTICE 'HMD KINSHASA July rent corrected in place: entries 37980,37982,37984; expense=%, payable=%; CASH unchanged. No new vouchers.',
    expense_after,payable_after;
END
$repair$;
COMMIT;
