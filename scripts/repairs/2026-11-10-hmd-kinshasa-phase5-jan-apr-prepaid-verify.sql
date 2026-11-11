-- HMD KINSHASA company 8 -- Phase 5 READ-ONLY post-apply verification.
-- Run after the guard SQL has COMMITTED in TablePlus. All statements READ ONLY.
BEGIN READ ONLY;
SELECT set_config('app.current_company_id','8',true);
SELECT set_config('app.authorized_company_ids','',true);

-- A. January-April rent expense must be 13560 Dr and zero Cr in EACH month.
SELECT EXTRACT(MONTH FROM v.voucher_date)::integer AS month,
       COUNT(DISTINCT v.id) AS voucher_count,
       SUM(e.debit_amount) AS rent_expense_dr,
       SUM(e.credit_amount) AS rent_expense_cr,
       SUM(e.debit_amount-e.credit_amount) AS rent_expense_net_dr
FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=v.company_id
WHERE v.company_id=8 AND v.deleted_at IS NULL AND v.optional=FALSE
  AND e.ledger_account_id=877
  AND v.voucher_date BETWEEN DATE '2026-01-01' AND DATE '2026-04-30'
GROUP BY 1 ORDER BY 1;
-- EXPECT 4 rows: each month 13560 / 0 / 13560.

-- B. Original three cash vouchers remain dated Jan 1, with ORIGINAL amount,
--    exactly 3 lines after modification (Jan rent, Feb-Apr prepaid, cash).
SELECT v.id,v.voucher_number,v.voucher_date,v.total_amount,
       COUNT(e.id) AS lines,SUM(e.debit_amount) AS total_dr,
       SUM(e.credit_amount) AS total_cr,
       SUM(e.credit_amount) FILTER(WHERE e.ledger_account_id=352) AS original_cash_cr,
       SUM(e.debit_amount) FILTER(WHERE e.ledger_account_id=877) AS january_rent,
       SUM(e.debit_amount) FILTER(WHERE a.name='Prepaid Rent') AS future_rent_asset
FROM vouchers v
JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=v.company_id
LEFT JOIN ledger_accounts a ON a.id=e.ledger_account_id AND a.company_id=e.company_id
WHERE v.company_id=8 AND v.id IN(6470,6475,6476)
GROUP BY v.id ORDER BY v.id;
-- EXPECT: 6470: $10000 cash credit, $2500 rent, $7500 prepaid
--         6475: $17600 cash credit, $4400 rent, $13200 prepaid
--         6476: $26640 cash credit, $6660 rent, $19980 prepaid.

-- C. Company-wide Prepaid Rent must net 0 at end of April, by month:
-- Jan +40680, Feb -13560, Mar -13560, Apr -13560.
SELECT a.id,a.name,a.account_type,a.opening_balance,
       EXTRACT(MONTH FROM v.voucher_date)::integer AS month,
       SUM(e.debit_amount) AS prepaid_dr,
       SUM(e.credit_amount) AS prepaid_cr,
       SUM(e.debit_amount-e.credit_amount) AS prepaid_month_net
FROM ledger_accounts a
JOIN voucher_entries e ON e.ledger_account_id=a.id AND e.company_id=a.company_id
JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
WHERE a.company_id=8 AND a.name='Prepaid Rent' AND a.deleted_at IS NULL
  AND v.deleted_at IS NULL AND v.optional=FALSE
GROUP BY a.id,a.name,a.account_type,a.opening_balance,EXTRACT(MONTH FROM v.voucher_date)
ORDER BY month;

-- D. Source rent account net remains 149160 Dr; payable #1401 remains zero.
-- If June Phase 4 also ran, expense GROSS must be Dr 149160 / Cr 0.
-- Otherwise expense gross remains Dr 158320 / Cr 9160 pending June cleanup.
SELECT a.id,a.name,SUM(e.debit_amount) AS dr,SUM(e.credit_amount) AS cr,
       SUM(e.debit_amount-e.credit_amount) AS net_dr
FROM ledger_accounts a
JOIN voucher_entries e ON e.ledger_account_id=a.id AND e.company_id=a.company_id
JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
WHERE a.company_id=8 AND a.id IN (877,1401,352)
  AND v.deleted_at IS NULL AND v.optional=FALSE
GROUP BY a.id,a.name ORDER BY a.id;

-- E. All THREE new Feb-Mar-Apr journals are balanced and cash-free.
SELECT v.id,v.voucher_number,v.voucher_date,v.total_amount,
       SUM(e.debit_amount) AS dr,SUM(e.credit_amount) AS cr,
       COUNT(e.id) AS line_count,
       COUNT(e.id) FILTER(WHERE e.ledger_account_id=352) AS cash_line_count
FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=v.company_id
WHERE v.company_id=8 AND v.voucher_number IN (
  'HMDKIN-RENT-REC-2026-02','HMDKIN-RENT-REC-2026-03',
  'HMDKIN-RENT-REC-2026-04')
GROUP BY v.id ORDER BY v.voucher_date;
-- EXPECT 3 rows: every row Dr=Cr=13560; 4 lines; 0 cash lines.

-- F. All 12 paid months retain original January payment links and amounts;
--    Feb-Apr monthly rows additionally link to that month's recognition voucher.
SELECT m.year,m.month,m.contract_id,m.id AS rental_row_id,
       m.expected_amount,m.paid_amount,
       p.voucher_id AS untouched_cash_payment,
       p.posting_status,
       m.accrual_voucher_id,
       r.voucher_number AS recognition_voucher,
       m.used_prepaid_account,m.used_advance_account,
       LEFT(m.notes,120) AS recognition_hold_note
FROM property_monthly_ledger m
JOIN property_payments p ON p.ledger_row_id=m.id AND p.company_id=m.company_id
LEFT JOIN vouchers r ON r.id=m.accrual_voucher_id AND r.company_id=m.company_id
WHERE m.company_id=8 AND m.module='ERP' AND m.year=2026
  AND m.month BETWEEN 1 AND 4 AND m.contract_id IN(15,16,17)
ORDER BY m.month,m.contract_id;

-- G. Original six payment entry IDs never changed CASH account or values.
SELECT e.id,e.voucher_id,e.ledger_account_id,e.debit_amount,e.credit_amount,
       v.voucher_date
FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
WHERE e.company_id=8 AND e.id IN(22660,22676,22678,30307,30311)
ORDER BY e.id;

-- H. Historical audit trail (includes database row audit separately).
SELECT id,created_at,record_identifier,reason
FROM audit_log WHERE company_id=8 AND action='repair'
  AND user_id='system:hmd-kinshasa-jan-apr-prepaid-20261110'
ORDER BY id;

COMMIT;
