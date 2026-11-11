-- PHASE 3 / HMD KINSHASA — safely retire 15 stale Jan–May 2026 accrual references.
--
-- CRITICAL ORDER:
-- 1. Deploy the branch's updated rent accrual and re-accrue guards FIRST.
-- 2. ONLY AFTER confirming production runs those guards, change DEPLOY_NOT_CONFIRMED
--    to DEPLOY_CONFIRMED on the set_config line below.
-- 3. Run the WHOLE file as one transaction in production TablePlus.
-- This file intentionally REFUSES to run before explicit deployment confirmation.
-- No new voucher, journal, receipt, cash entry or guarantee is created or changed.
-- Existing direct-expense payment vouchers remain the source of Jan–May recognized rent.
-- Do not run the generic --apply Type E historical repair script for this company.

BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT set_config('app.company_scope_maintenance','off',true);
SELECT set_config('app.current_company_id','8',true);
SELECT set_config('app.authorized_company_ids','',true);
SELECT set_config('app.current_actor','system:hmd-kinshasa-phase3-stale-links-20261110',true);
SELECT set_config('app.current_actor_name','Owner-approved historical rental reference reconciliation',true);
SELECT set_config('app.audit_reason','Phase 3: safely clear 15 deleted accrual #8534 links after deployment of persisted recognition-hold guards; preserve original direct rent expenses',true);
-- CHANGE THIS VALUE TO DEPLOY_CONFIRMED **ONLY** AFTER THE RENT-GUARD CODE IS LIVE.
SELECT set_config('app.hmd_kinshasa_hold_guard_deployed','DEPLOY_NOT_CONFIRMED',true);

DO $phase3_janmay$
DECLARE
  n integer;
  before_rows integer;
  after_rows integer;
  changed integer;
  exp_before numeric;
  ap_before numeric;
  exp_after numeric;
  ap_after numeric;
  rec record;
  note_text constant text :=
    '[RENT_RECOGNITION_HOLD] Jan-May 2026 directly expensed in original posted rent payment vouchers 6470/6475/6476/7478/7479/7480; deleted duplicate accrual 8534 on 2026-06-02; historical reconciliation 2026-11-10; do not re-accrue.';
BEGIN
  IF current_database()<>'erp_db_qscj_64lv_e7rz_8744_2lm3'
     OR current_setting('app.current_company_id',true)<>'8'
     OR current_setting('app.hmd_kinshasa_hold_guard_deployed',true)<>'DEPLOY_CONFIRMED'
  THEN RAISE EXCEPTION 'KIN_PHASE3_JANMAY_WRONG_DB_OR_RENT_HOLD_GUARD_NOT_DEPLOYED'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('hmd-kinshasa-phase3-january-may-hold'));
  IF NOT EXISTS(SELECT 1 FROM companies WHERE id=8 AND name='HMD KINSHASA' AND active=TRUE)
  THEN RAISE EXCEPTION 'KIN_PHASE3_JANMAY_COMPANY_CHANGED'; END IF;
  IF EXISTS(SELECT 1 FROM fiscal_period_closures
     WHERE company_id=8 AND status='CLOSED' AND period_end_date>=DATE '2026-01-01')
  THEN RAISE EXCEPTION 'KIN_PHASE3_JANMAY_CLOSED_PERIOD'; END IF;

  -- The historical $67,800 accrual voucher was deleted. Audit record proves
  -- its identity/intent; do not re-create it or link to an unrelated payment voucher.
  IF EXISTS(SELECT 1 FROM vouchers WHERE company_id=8 AND id=8534 AND deleted_at IS NULL)
     OR NOT EXISTS(
       SELECT 1 FROM audit_log
       WHERE company_id=8 AND id=1549 AND action='delete'
         AND table_name='vouchers' AND record_id=8534
     )
  THEN RAISE EXCEPTION 'KIN_PHASE3_JANMAY_DELETED_VOUCHER_PROVENANCE_CHANGED'; END IF;

  PERFORM 1 FROM property_monthly_ledger m
    WHERE m.company_id=8 AND m.module='ERP' AND m.year=2026
      AND m.month BETWEEN 1 AND 5 AND m.contract_id IN(15,16,17)
    ORDER BY id FOR UPDATE;

  -- Require exactly 15 contractual rows with source amount completely settled.
  SELECT COUNT(*) INTO n FROM property_monthly_ledger m
  JOIN (VALUES(15,40,4400::numeric),(16,41,6660::numeric),(17,42,2500::numeric))
      AS x(contract_id,unit_id,monthly) ON m.contract_id=x.contract_id
  WHERE m.company_id=8 AND m.module='ERP' AND m.year=2026 AND m.month BETWEEN 1 AND 5
    AND m.unit_id=x.unit_id AND m.expected_amount=x.monthly
    AND m.paid_amount=x.monthly AND m.used_prepaid_account=FALSE
    AND m.used_advance_account=FALSE;
  IF n<>15 THEN RAISE EXCEPTION 'KIN_PHASE3_JANMAY_MONTH_ROWS_CHANGED'; END IF;

  -- Every month has one posted rent allocation with a live original payment voucher.
  SELECT COUNT(*) INTO n
  FROM property_monthly_ledger m
  JOIN property_payments p ON p.ledger_row_id=m.id AND p.company_id=8
    AND p.contract_id=m.contract_id AND p.for_year=m.year AND p.for_month=m.month
  JOIN vouchers v ON v.id=p.voucher_id AND v.company_id=8
  WHERE m.company_id=8 AND m.module='ERP' AND m.year=2026
    AND m.month BETWEEN 1 AND 5 AND m.contract_id IN(15,16,17)
    AND p.posting_status='POSTED' AND p.amount=m.expected_amount
    AND v.id IN(6470,6475,6476,7478,7479,7480)
    AND v.deleted_at IS NULL AND v.optional=FALSE;
  IF n<>15 THEN RAISE EXCEPTION 'KIN_PHASE3_JANMAY_PAYMENT_ALLOCATIONS_CHANGED'; END IF;

  -- Six original vouchers directly expense $67,800 and credit CASH $67,800.
  SELECT COUNT(*),COALESCE(SUM(e.debit_amount) FILTER(WHERE e.ledger_account_id=877),0),
       COALESCE(SUM(e.credit_amount) FILTER(WHERE e.ledger_account_id=352),0)
  INTO n,exp_before,ap_before
  FROM voucher_entries e WHERE e.company_id=8
     AND e.voucher_id IN(6470,6475,6476,7478,7479,7480);
  IF n<>12 OR exp_before<>67800 OR ap_before<>67800
  THEN RAISE EXCEPTION 'KIN_PHASE3_JANMAY_HISTORICAL_PAYMENTS_CHANGED'; END IF;

  -- Do not alter a cent of expense or payable. They were repaired in Phase 2.
  SELECT COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=877),0),
         COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1401),0)
   INTO exp_before,ap_before
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=8
  WHERE e.company_id=8 AND e.ledger_account_id IN(877,1401)
      AND v.deleted_at IS NULL AND v.optional=FALSE;
  IF exp_before<>149160 OR ap_before<>0
  THEN RAISE EXCEPTION 'KIN_PHASE3_JANMAY_GL_DRIFT'; END IF;

  SELECT COUNT(*) FILTER(WHERE accrual_voucher_id=8534 AND notes IS NULL),
         COUNT(*) FILTER(WHERE accrual_voucher_id IS NULL AND notes=note_text)
  INTO before_rows,after_rows
  FROM property_monthly_ledger
  WHERE company_id=8 AND module='ERP' AND year=2026 AND month BETWEEN 1 AND 5
     AND contract_id IN(15,16,17);
  IF before_rows=0 AND after_rows=15 THEN
    RAISE NOTICE 'Phase 3 Jan-May historical links already reconciled; no changes.';
    RETURN;
  END IF;
  IF before_rows<>15 OR after_rows<>0 THEN
    RAISE EXCEPTION 'KIN_PHASE3_JANMAY_PARTIAL_OR_UNEXPECTED_REFERENCES';
  END IF;

  UPDATE property_monthly_ledger SET accrual_voucher_id=NULL, notes=note_text
  WHERE company_id=8 AND module='ERP' AND year=2026 AND month BETWEEN 1 AND 5
    AND contract_id IN(15,16,17) AND accrual_voucher_id=8534
    AND notes IS NULL AND expected_amount=paid_amount;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>15 THEN RAISE EXCEPTION 'KIN_PHASE3_JANMAY_WRONG_UPDATE_COUNT'; END IF;

  FOR rec IN SELECT id,contract_id,year,month FROM property_monthly_ledger
   WHERE company_id=8 AND module='ERP' AND year=2026 AND month BETWEEN 1 AND 5
    AND contract_id IN(15,16,17) ORDER BY contract_id,month LOOP
    INSERT INTO audit_log(user_id,username,company_id,action,table_name,record_id,
                          record_identifier,reason,changes)
    VALUES(
      'system:hmd-kinshasa-phase3-stale-links-20261110',
      'Owner-approved historical rental reference reconciliation',
      8,'repair','property_monthly_ledger',rec.id,
      'HMD KINSHASA contract '||rec.contract_id||' '||rec.year||'-'||LPAD(rec.month::text,2,'0'),
      'Deleted accrual voucher #8534 already removed from GL; direct expense recorded by existing payment vouchers; persistent recognition hold prevents re-accrual',
      jsonb_build_object(
        'accrual_voucher_id',jsonb_build_object('old',8534,'new',NULL),
        'notes',jsonb_build_object('old',NULL,'new',note_text),
        'payment_and_expense_unchanged',jsonb_build_object('new',true)
      )
    );
  END LOOP;

  SELECT COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=877),0),
         COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE e.ledger_account_id=1401),0)
    INTO exp_after,ap_after
  FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=8
  WHERE e.company_id=8 AND e.ledger_account_id IN(877,1401)
    AND v.deleted_at IS NULL AND v.optional=FALSE;
  IF exp_after<>exp_before OR ap_after<>ap_before THEN
    RAISE EXCEPTION 'KIN_PHASE3_JANMAY_ACCOUNT_BALANCES_CHANGED';
  END IF;
  RAISE NOTICE 'Phase 3 Jan-May: 15 stale 8534 references replaced with persistent historical recognition holds; GL unchanged; no new vouchers.';
END
$phase3_janmay$;
COMMIT;
