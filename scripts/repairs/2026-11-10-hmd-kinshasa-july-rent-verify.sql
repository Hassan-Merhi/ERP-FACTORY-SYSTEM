-- HMD KINSHASA / ERP Shops — Phase 2 READ ONLY verification.
-- Safe before or after the in-place correction; never changes vouchers.
BEGIN READ ONLY;
SELECT set_config('app.company_scope_maintenance','off',true);
SELECT set_config('app.current_company_id','8',true);

-- Expected BEFORE: expense 162720 Dr, payable 13560 Cr, 3 misclassified debit lines.
-- Expected AFTER: expense 149160 Dr, payable 0, 3 corrected lines.
SELECT a.id AS account_id,a.name,
  COALESCE(SUM(e.debit_amount) FILTER(WHERE v.id IS NOT NULL AND v.deleted_at IS NULL AND v.optional=FALSE),0) AS debit,
  COALESCE(SUM(e.credit_amount) FILTER(WHERE v.id IS NOT NULL AND v.deleted_at IS NULL AND v.optional=FALSE),0) AS credit,
  COALESCE(SUM(e.debit_amount-e.credit_amount) FILTER(WHERE v.id IS NOT NULL AND v.deleted_at IS NULL AND v.optional=FALSE),0) AS net_dr_minus_cr
FROM ledger_accounts a
LEFT JOIN voucher_entries e ON e.ledger_account_id=a.id AND e.company_id=8
LEFT JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=8
WHERE a.company_id=8 AND a.id IN (877,1401)
GROUP BY a.id,a.name ORDER BY a.id;

SELECT e.id AS entry_id,e.voucher_id,e.ledger_account_id,e.debit_amount,e.credit_amount,
  CASE WHEN e.ledger_account_id=1401 THEN 'CORRECTED'
       WHEN e.ledger_account_id=877 THEN 'NEEDS_CORRECTION'
       ELSE 'UNEXPECTED_ACCOUNT' END AS status
FROM voucher_entries e
WHERE e.company_id=8 AND e.id IN (37980,37982,37984)
ORDER BY e.id;

-- Original July Payment voucher cash credits must remain untouched.
SELECT e.id AS cash_entry_id,e.voucher_id,e.ledger_account_id,e.debit_amount,e.credit_amount
FROM voucher_entries e
WHERE e.company_id=8 AND e.id IN(37981,37983,37985)
ORDER BY e.id;

-- The July accrual and all POSTED July payments must still be intact.
SELECT m.contract_id,m.id AS july_ledger_row_id,m.expected_amount,m.paid_amount,
  m.accrual_voucher_id,p.id AS payment_id,p.voucher_id,p.amount,p.posting_status
FROM property_monthly_ledger m
JOIN property_payments p ON p.ledger_row_id=m.id AND p.company_id=8
WHERE m.company_id=8 AND m.module='ERP' AND m.year=2026 AND m.month=7
  AND m.contract_id IN(15,16,17)
ORDER BY m.contract_id;

-- Expect 3 repair audit rows AFTER correction; 0 beforehand.
SELECT record_id,record_identifier,created_at,reason
FROM audit_log
WHERE company_id=8 AND action='repair' AND table_name='voucher_entries'
  AND record_id IN(37980,37982,37984)
ORDER BY id;
ROLLBACK;
