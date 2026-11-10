-- HMD KINSHASA company 8: read-only pre/post June gross repair verification.
-- Run against production after the guarded correction script in TablePlus.
-- These queries do not alter any ledger, cash, voucher, or rental payment.
BEGIN READ ONLY;
SELECT set_config('app.current_company_id','8',true);
SELECT set_config('app.authorized_company_ids','',true);

-- Expected after correction:
-- Expense #877: Jan 54240/0, May 13560/0, June 13560/0,
-- July-Nov 13560/0 each, grand Dr 149160 / Cr 0 / net 149160 Dr.
-- Payable #1401 grand Dr 90520 / Cr 90520 / net 0.
SELECT a.id, a.name,
       SUM(e.debit_amount) AS debit,
       SUM(e.credit_amount) AS credit,
       SUM(e.debit_amount - e.credit_amount) AS net_debit
FROM ledger_accounts a
JOIN voucher_entries e ON e.ledger_account_id=a.id AND e.company_id=a.company_id
JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
WHERE a.company_id=8 AND a.id IN(877,1401)
  AND v.deleted_at IS NULL AND v.optional=FALSE
GROUP BY a.id,a.name ORDER BY a.id;

SELECT EXTRACT(MONTH FROM v.voucher_date)::int AS month,
       SUM(e.debit_amount) AS expense_debit,
       SUM(e.credit_amount) AS expense_credit,
       SUM(e.debit_amount-e.credit_amount) AS net_debit
FROM voucher_entries e JOIN vouchers v
  ON v.id=e.voucher_id AND v.company_id=e.company_id
WHERE e.company_id=8 AND e.ledger_account_id=877
  AND v.deleted_at IS NULL AND v.optional=FALSE
  AND v.voucher_date BETWEEN DATE '2026-01-01' AND DATE '2026-11-30'
GROUP BY 1 ORDER BY 1;

-- Original 4 June voucher lines reclassified; payment cash credits untouched.
SELECT e.id,e.voucher_id,e.ledger_account_id,e.debit_amount,e.credit_amount
FROM voucher_entries e
WHERE e.company_id=8 AND e.id IN(30306,30307,30308,30309,30310,30311,30312,30313)
ORDER BY e.id;

-- Exact balancing of all affected original vouchers.
SELECT v.id,v.voucher_number,v.voucher_date,v.total_amount,
       SUM(e.debit_amount) AS debit,
       SUM(e.credit_amount) AS credit
FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=v.company_id
WHERE v.company_id=8 AND v.id IN(8801,8802,8803,8804)
GROUP BY v.id ORDER BY v.id;

-- The original Jan-Apr payments remain dated Jan 1 and CASH #352 entries unchanged.
SELECT v.id,v.voucher_date,v.voucher_number,v.total_amount,
       e.id AS cash_entry_id,e.credit_amount AS cash_credit,e.ledger_account_id
FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=v.company_id
WHERE v.company_id=8 AND v.id IN(6470,6475,6476)
  AND e.ledger_account_id=352 ORDER BY v.id;

COMMIT;
