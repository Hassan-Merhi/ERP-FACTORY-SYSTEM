-- Phase 6: READ-ONLY provenance and account reconciliation diagnostics.
-- Run separately for each APPROVED company, with an account-scoped read role.
-- Set app.current_company_id in a transaction-local, permissioned DB session
-- BEFORE running each query. All statements fail closed to zero rows if unset.
-- Does not repair/merge duplicates, post journals, update openings or alter FX.
--
-- Example psql session (replace the approved ID):
-- BEGIN READ ONLY;
-- SET LOCAL app.current_company_id = '<approved numeric company ID>';
-- <run each SELECT below>
-- ROLLBACK;
-- Render's query console already wraps each request read-only: it may not
-- preserve SET LOCAL across requests. Use an app-scoped read-only diagnostic
-- session or explicitly bind a reviewed numeric company ID to each query.

-- 1. Opening FX provenance and consistency by eligible financial account.
-- No names or user-identifying customer details are exported.
WITH scope AS (
  SELECT NULLIF(CURRENT_SETTING('app.current_company_id', true),'')::integer AS company_id
), customer_links AS (
  SELECT c.company_id, c.ledger_account_id, MIN(c.id) AS customer_id
  FROM customers c JOIN ledger_accounts la ON la.id=c.ledger_account_id AND la.company_id=c.company_id
  WHERE c.ledger_account_id IS NOT NULL
  GROUP BY c.company_id,c.ledger_account_id
), masters AS (
  SELECT la.company_id,'ledger'::text AS kind, la.id,
    CASE WHEN LOWER(TRIM(la.account_type)) IN ('cash','bank') THEN 'CASH_BANK'
      WHEN LOWER(TRIM(la.account_type)) IN ('loan','loans') THEN 'LOAN'
      WHEN LOWER(TRIM(la.account_type)) IN ('asset','current asset') THEN 'MONETARY_ASSET_NEEDS_REVIEW'
      ELSE 'EXCLUDED' END AS policy,
    la.opening_balance::numeric AS book,
    la.opening_balance_base_amount::numeric AS base_amount,
    la.opening_balance_native_amount::numeric AS native_amount,
    la.opening_balance_currency AS native_currency
  FROM ledger_accounts la JOIN scope s ON s.company_id=la.company_id
  WHERE NOT EXISTS(SELECT 1 FROM customer_links cl
    WHERE cl.company_id=la.company_id AND cl.ledger_account_id=la.id)
  UNION ALL
  SELECT b.company_id, 'bank', b.id, 'CASH_BANK',
    b.opening_balance::numeric, b.opening_balance_base_amount::numeric,
    b.opening_balance_native_amount::numeric,b.opening_balance_currency
  FROM bank_accounts b JOIN scope s ON s.company_id=b.company_id
  UNION ALL
  SELECT c.company_id, 'customer', c.id, 'CUSTOMER',
    c.opening_balance::numeric,c.opening_balance_base_amount::numeric,
    c.opening_balance_native_amount::numeric,c.opening_balance_currency
  FROM customers c JOIN scope s ON s.company_id=c.company_id
)
SELECT company_id, kind,policy,COUNT(*) AS account_count,
       COUNT(*) FILTER(WHERE COALESCE(book,0)<>0 AND
         (base_amount IS NULL OR native_amount IS NULL OR TRIM(COALESCE(native_currency,''))=''))
         AS unresolved_openings,
       COUNT(*) FILTER(WHERE COALESCE(book,0)<>0 AND base_amount IS NOT NULL AND
         ABS(ABS(book)-ABS(base_amount))>0.03) AS opening_book_base_mismatches,
       COUNT(*) FILTER(WHERE UPPER(TRIM(COALESCE(native_currency,''))) IN ('CFA','XOF','ZMW','CDF','EUR','AUD','GBP'))
         AS foreign_openings
FROM masters
WHERE policy<>'EXCLUDED'
GROUP BY company_id,kind,policy
ORDER BY company_id,kind,policy;

-- 2. Posted voucher metadata coverage. This deliberately uses the canonical
-- balance-engine attribution order, not all lines tagged with a customer.
-- Only grouped diagnostics, not voucher line amounts, leave the database.
WITH scope AS (
  SELECT NULLIF(CURRENT_SETTING('app.current_company_id', true),'')::integer AS company_id
), customer_links AS (
  SELECT c.company_id,c.ledger_account_id,MIN(c.id) AS customer_id
  FROM customers c JOIN ledger_accounts la ON la.id=c.ledger_account_id AND la.company_id=c.company_id
  WHERE c.ledger_account_id IS NOT NULL
  GROUP BY c.company_id,c.ledger_account_id
), owned AS (
  SELECT v.company_id,
    CASE
      WHEN ve.ledger_account_id IS NOT NULL AND la.id IS NULL THEN 'missingAccount'
      WHEN ve.ledger_account_id IS NOT NULL AND cl.customer_id IS NOT NULL THEN 'customer'
      WHEN ve.ledger_account_id IS NOT NULL THEN 'ledger'
      WHEN ve.bank_account_id IS NOT NULL THEN 'bank'
      WHEN ve.fixed_asset_id IS NOT NULL THEN 'fixedAsset'
      WHEN ve.supplier_id IS NOT NULL THEN 'supplier'
      WHEN ve.employee_id IS NOT NULL THEN 'employee'
      WHEN ve.factory_supplier_id IS NOT NULL THEN 'factorySupplier'
      WHEN ve.customer_id IS NOT NULL THEN 'customer'
      ELSE 'unassigned' END AS owning_kind,
    COALESCE(UPPER(NULLIF(TRIM(ve.transaction_currency),'')),UPPER(NULLIF(TRIM(v.currency),'')),'USD') AS cc,
    ve.transaction_currency,
    ve.transaction_debit_amount,ve.transaction_credit_amount,
    ve.base_debit_amount,ve.base_credit_amount,
    ve.debit_amount,ve.credit_amount,
    CASE WHEN v.effective_date>v.voucher_date THEN TRUE ELSE FALSE END AS future_effective
  FROM voucher_entries ve JOIN vouchers v ON v.id=ve.voucher_id
  JOIN scope s ON s.company_id=v.company_id
  LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=v.company_id
  LEFT JOIN customer_links cl ON cl.ledger_account_id=la.id AND cl.company_id=v.company_id
  WHERE v.optional=FALSE AND v.deleted_at IS NULL
)
SELECT company_id, owning_kind,
       COUNT(*) AS posted_lines,
       COUNT(*) FILTER(WHERE cc<>'USD') AS foreign_lines,
       COUNT(*) FILTER(WHERE cc<>'USD' AND
          (transaction_currency IS NULL OR transaction_debit_amount IS NULL OR
           transaction_credit_amount IS NULL OR base_debit_amount IS NULL OR base_credit_amount IS NULL))
          AS unresolved_foreign_lines,
       COUNT(*) FILTER(WHERE base_debit_amount IS NOT NULL AND
          ABS(COALESCE(debit_amount,0)::numeric-base_debit_amount::numeric)>0.03) AS legacy_book_base_differences,
       COUNT(*) FILTER(WHERE base_credit_amount IS NOT NULL AND
          ABS(COALESCE(credit_amount,0)::numeric-base_credit_amount::numeric)>0.03) AS legacy_credit_base_differences,
       COUNT(*) FILTER(WHERE future_effective) AS forward_effective_lines
FROM owned
WHERE owning_kind IN ('ledger','bank','customer')
GROUP BY company_id,owning_kind
ORDER BY company_id,owning_kind;

-- 3. Multi-customer linked-ledger ownership conflicts. These may be legitimate
-- but require verification of lowest-ID ownership and the second master opening.
WITH scope AS (
  SELECT NULLIF(CURRENT_SETTING('app.current_company_id', true),'')::integer AS company_id
)
SELECT c.company_id,COUNT(*) AS duplicate_linked_ledger_keys
FROM (
  SELECT customer.company_id, customer.ledger_account_id
  FROM customers customer JOIN scope s ON s.company_id=customer.company_id
  WHERE customer.ledger_account_id IS NOT NULL
  GROUP BY customer.company_id,customer.ledger_account_id
  HAVING COUNT(*)>1
) c
GROUP BY c.company_id;
