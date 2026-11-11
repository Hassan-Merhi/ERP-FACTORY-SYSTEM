-- PHASE 3 / HMD KINSHASA — read-only period, voucher and account reconciliation.
-- No repairs or data writes; safe before and after each guarded Phase 3 SQL file.
BEGIN READ ONLY;
SELECT set_config('app.company_scope_maintenance','off',true);
SELECT set_config('app.current_company_id','8',true);

-- 33 rental months, 3 contracts, each fully paid: expected and posted rent $149,160.
SELECT m.contract_id,m.year,m.month,m.id AS ledger_row_id,
       m.expected_amount, m.paid_amount AS cached_paid,
       COALESCE(SUM(p.amount) FILTER(WHERE p.posting_status='POSTED'
         AND p.ledger_row_id=m.id),0) AS posted_paid,
       COALESCE(SUM(p.amount) FILTER(WHERE p.posting_status='SCHEDULED'),0) AS scheduled,
       m.accrual_voucher_id,
       CASE WHEN m.notes LIKE '[RENT_RECOGNITION_HOLD]%' THEN TRUE ELSE FALSE END AS recognition_held,
       CASE WHEN m.accrual_voucher_id IS NULL THEN 'NO_ACCRUAL_LINK'
            WHEN EXISTS (
              SELECT 1 FROM vouchers v WHERE v.id=m.accrual_voucher_id
                AND v.company_id=8 AND v.deleted_at IS NULL AND v.optional=FALSE
            ) THEN 'VALID_LIVE_ACCRUAL' ELSE 'DELETED_OR_MISSING_ACCRUAL' END AS voucher_link_status
FROM property_monthly_ledger m
LEFT JOIN property_payments p ON p.company_id=8 AND p.ledger_row_id=m.id
WHERE m.company_id=8 AND m.module='ERP'
  AND m.contract_id IN(15,16,17) AND m.year=2026 AND m.month BETWEEN 1 AND 11
GROUP BY m.id,m.contract_id,m.year,m.month,m.expected_amount,m.paid_amount,
         m.accrual_voucher_id,m.notes
ORDER BY m.contract_id,m.month;

-- Operational rent reconciliation (all 33 months).
WITH details AS (
  SELECT m.id,m.expected_amount,m.paid_amount,
         COALESCE((SELECT SUM(p.amount) FROM property_payments p
            WHERE p.company_id=8 AND p.ledger_row_id=m.id
               AND p.posting_status='POSTED'),0) AS posted,
         m.notes,m.accrual_voucher_id
  FROM property_monthly_ledger m
  WHERE m.company_id=8 AND m.module='ERP'
    AND m.contract_id IN(15,16,17) AND m.year=2026 AND m.month BETWEEN 1 AND 11
)
SELECT COUNT(*) AS due_months,SUM(expected_amount) AS expected_rent,
       SUM(paid_amount) AS cached_paid,SUM(posted) AS actual_paid,
       SUM(GREATEST(expected_amount-posted,0)) AS outstanding,
       COUNT(*) FILTER(WHERE ABS(paid_amount-posted)>0.01) AS cache_mismatches,
       COUNT(*) FILTER(WHERE notes LIKE '[RENT_RECOGNITION_HOLD]%') AS protected_historical_months,
       COUNT(*) FILTER(WHERE accrual_voucher_id=8534) AS old_deleted_links
FROM details;

-- Canonical payable and expense: after July correction both should be right.
-- Account 1401 gross debit/credit are $67,800 each before June fix and $81,360
-- each after June fix; net remains $0. Account 877 net remains $149,160 Dr.
SELECT a.id AS account_id,a.name,
  COALESCE(SUM(e.debit_amount),0) AS debit,
  COALESCE(SUM(e.credit_amount),0) AS credit,
  COALESCE(SUM(e.debit_amount-e.credit_amount),0) AS net_dr_minus_cr
FROM ledger_accounts a
LEFT JOIN voucher_entries e ON e.company_id=8 AND e.ledger_account_id=a.id
LEFT JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=8
WHERE a.company_id=8 AND a.id IN(877,1401)
  AND (v.id IS NULL OR (v.deleted_at IS NULL AND v.optional=FALSE))
GROUP BY a.id,a.name ORDER BY a.id;

-- Legacy June payable: before correction 4 entries and net zero; after 0.
SELECT COUNT(*) AS old_lines,
       COALESCE(SUM(debit_amount),0) AS old_debit,
       COALESCE(SUM(credit_amount),0) AS old_credit
FROM voucher_entries
WHERE company_id=8 AND ledger_account_id=918;

-- All 4 original June entries must still exist with same amounts, old/new account.
SELECT id,voucher_id,ledger_account_id,debit_amount,credit_amount
FROM voucher_entries
WHERE company_id=8 AND id IN(29370,30027,30308,30312)
ORDER BY id;

-- The original July payment debit corrections must remain on canonical payable.
SELECT id,voucher_id,ledger_account_id,debit_amount,credit_amount
FROM voucher_entries WHERE company_id=8 AND id IN(37980,37982,37984)
ORDER BY id;

-- The original 3 January–April payment vouchers and 3 May vouchers are untouched.
SELECT id,voucher_number,voucher_date,total_amount,voucher_type,deleted_at
FROM vouchers WHERE company_id=8 AND id IN(6470,6475,6476,7478,7479,7480)
ORDER BY id;

-- Deleted accrual provenance remains audited; the deleted voucher is NOT recreated.
SELECT id,action,record_id,record_identifier,created_at
FROM audit_log WHERE company_id=8 AND id=1549 AND action='delete'
  AND table_name='vouchers' AND record_id=8534;

-- Explicit Phase 2 and Phase 3 repairs (database row-update triggers may add
-- more audit rows with the same record IDs).
SELECT action,table_name,COUNT(*) AS records,
       MIN(created_at) AS first_audit,MAX(created_at) AS last_audit
FROM audit_log WHERE company_id=8 AND action='repair'
  AND ((table_name='voucher_entries' AND record_id IN
      (37980,37982,37984,29370,30027,30308,30312))
  OR (table_name='property_monthly_ledger' AND record_id IN
      (SELECT id FROM property_monthly_ledger WHERE company_id=8 AND module='ERP'
       AND contract_id IN(15,16,17) AND year=2026 AND month BETWEEN 1 AND 5)))
GROUP BY action,table_name ORDER BY table_name;

-- Guarantees remain separate: 26,400 + 39,600 + 7,500 = 73,500.
SELECT contract_id,SUM(amount) AS guarantee
FROM property_payments
WHERE company_id=8 AND module='ERP' AND contract_id IN(15,16,17)
  AND ledger_row_id IS NULL AND posting_status='POSTED'
GROUP BY contract_id ORDER BY contract_id;

ROLLBACK;
