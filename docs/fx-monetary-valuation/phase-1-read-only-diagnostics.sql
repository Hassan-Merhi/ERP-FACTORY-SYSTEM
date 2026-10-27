-- Phase 1 FX monetary valuation — optional, READ-ONLY production diagnostic
-- Do not run automatically on production. DBA should review query plan and execute
-- under a restricted read-only role; results are aggregate counts, not customer PII.
-- No UPDATE / INSERT / DELETE / DDL / posting. This file does not revalue anything.
-- Company-specific FX rates use company business date, not database CURRENT_DATE.
-- All queries intentionally retain company_id and do not combine tenants.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- A. Company quote pairs; records configured choices, NOT a claim of today's rate.
SELECT
  c.id AS company_id,
  c.company_type,
  c.base_currency,
  c.display_currency,
  COUNT(er.id) AS recorded_rate_rows,
  MAX(er.effective_date) AS latest_recorded_effective_date
FROM companies c
LEFT JOIN exchange_rates er ON er.company_id = c.id
  AND UPPER(TRIM(er.from_currency)) = UPPER(TRIM(COALESCE(c.base_currency, 'USD')))
  AND UPPER(TRIM(er.to_currency)) = UPPER(TRIM(COALESCE(c.display_currency, '')))
GROUP BY c.id, c.company_type, c.base_currency, c.display_currency
ORDER BY c.id;

-- B. Ledger eligibility candidates and unresolved original-currency openings.
-- 'ASSET_NEEDS_REVIEW' MUST NOT be auto-enabled; it can be physical/nonmonetary.
WITH candidates AS (
  SELECT
    la.company_id, la.id,
    LOWER(TRIM(COALESCE(la.account_type, ''))) AS normalized_type,
    LOWER(TRIM(COALESCE(la.sub_type, ''))) AS normalized_subtype,
    la.opening_balance, la.opening_balance_native_amount,
    la.opening_balance_currency, la.opening_balance_base_amount,
    CASE
      WHEN LOWER(TRIM(COALESCE(la.account_type, ''))) IN ('cash','bank')
        OR (COALESCE(TRIM(la.account_type), '') = '' AND LOWER(TRIM(COALESCE(la.sub_type,''))) IN ('cash','bank'))
        THEN 'CASH_BANK_CANDIDATE'
      WHEN LOWER(TRIM(COALESCE(la.account_type, ''))) IN ('loan','loans')
        OR (COALESCE(TRIM(la.account_type), '') = '' AND LOWER(TRIM(COALESCE(la.sub_type,''))) IN ('loan','loans'))
        THEN 'LOAN_CANDIDATE'
      WHEN LOWER(TRIM(COALESCE(la.account_type, ''))) IN ('asset','current asset')
        OR (COALESCE(TRIM(la.account_type), '') = '' AND LOWER(TRIM(COALESCE(la.sub_type,''))) IN ('asset','current asset'))
        THEN 'ASSET_NEEDS_REVIEW'
      ELSE 'EXCLUDED_OR_OTHER'
    END AS policy_bucket
  FROM ledger_accounts la
  WHERE la.deleted_at IS NULL
)
SELECT
  company_id,
  policy_bucket,
  COUNT(*) AS accounts,
  COUNT(*) FILTER (
    WHERE COALESCE(opening_balance, 0)::numeric <> 0
      AND (opening_balance_currency IS NULL
        OR opening_balance_native_amount IS NULL
        OR opening_balance_base_amount IS NULL)
  ) AS unresolved_nonzero_openings,
  COUNT(*) FILTER (
    WHERE opening_balance_currency IS NOT NULL
      AND UPPER(TRIM(opening_balance_currency)) <> 'USD'
  ) AS non_usd_openings
FROM candidates
GROUP BY company_id, policy_bucket
ORDER BY company_id, policy_bucket;

-- C. Customer master opening provenance and linked-ledger exposure.
SELECT
  c.company_id,
  COUNT(*) AS customers,
  COUNT(*) FILTER (WHERE c.ledger_account_id IS NOT NULL) AS customers_with_ledger_links,
  COUNT(*) FILTER (
    WHERE COALESCE(c.opening_balance, 0)::numeric <> 0
      AND (c.opening_balance_native_amount IS NULL
        OR c.opening_balance_currency IS NULL
        OR c.opening_balance_base_amount IS NULL)
  ) AS unresolved_nonzero_customer_openings,
  COUNT(*) FILTER (
    WHERE c.opening_balance_currency IS NOT NULL
      AND UPPER(TRIM(c.opening_balance_currency)) <> 'USD'
  ) AS non_usd_customer_openings
FROM customers c
WHERE c.deleted_at IS NULL
GROUP BY c.company_id
ORDER BY c.company_id;

-- D. Collision: several customers refer to same ledger.
-- Existing balance engine resolves ownership deterministically; these still
-- require review to ensure no customer/ledger double revaluation.
SELECT company_id, COUNT(*) AS linked_ledger_ids_with_multiple_customers
FROM (
  SELECT company_id, ledger_account_id
  FROM customers
  WHERE deleted_at IS NULL AND ledger_account_id IS NOT NULL
  GROUP BY company_id, ledger_account_id
  HAVING COUNT(*) > 1
) duplicate_links
GROUP BY company_id
ORDER BY company_id;

-- E. Bank master opening provenance / linking.
SELECT
  b.company_id,
  COUNT(*) AS bank_masters,
  COUNT(*) FILTER (WHERE b.linked_ledger_id IS NOT NULL) AS linked_to_ledger,
  COUNT(*) FILTER (
    WHERE COALESCE(b.opening_balance,0)::numeric <> 0
      AND (b.opening_balance_native_amount IS NULL
        OR b.opening_balance_currency IS NULL
        OR b.opening_balance_base_amount IS NULL)
  ) AS unresolved_nonzero_bank_openings,
  COUNT(*) FILTER (
    WHERE b.opening_balance_currency IS NOT NULL
      AND UPPER(TRIM(b.opening_balance_currency)) <> 'USD'
  ) AS non_usd_bank_openings
FROM bank_accounts b
WHERE b.deleted_at IS NULL
GROUP BY b.company_id
ORDER BY b.company_id;

-- F. Posted voucher currency evidence coverage. Source ownership of actual
-- customer/loan/cash lines must use ledgerBalanceEngine attribution, not this
-- simplified diagnostic. No dollar values are exported.
SELECT
  v.company_id,
  COUNT(*) AS posted_entries,
  COUNT(*) FILTER (
    WHERE COALESCE(UPPER(TRIM(ve.transaction_currency)),UPPER(TRIM(v.currency)),'USD') <> 'USD'
  ) AS foreign_currency_entries,
  COUNT(*) FILTER (
    WHERE COALESCE(UPPER(TRIM(ve.transaction_currency)),UPPER(TRIM(v.currency)),'USD') <> 'USD'
      AND (
        ve.transaction_currency IS NULL
        OR (COALESCE(ve.debit_amount,0)::numeric <> 0 AND ve.transaction_debit_amount IS NULL)
        OR (COALESCE(ve.credit_amount,0)::numeric <> 0 AND ve.transaction_credit_amount IS NULL)
        OR ve.base_debit_amount IS NULL
        OR ve.base_credit_amount IS NULL
      )
  ) AS foreign_entries_missing_required_evidence
FROM voucher_entries ve
JOIN vouchers v ON v.id = ve.voucher_id
WHERE v.deleted_at IS NULL AND v.optional = false
GROUP BY v.company_id
ORDER BY v.company_id;

-- G. Fixed-asset master count: a PHYSICAL ASSET is not a monetary FX target.
SELECT fa.company_id, COUNT(*) AS fixed_asset_masters_excluded_by_default
FROM fixed_assets fa
GROUP BY fa.company_id
ORDER BY fa.company_id;

ROLLBACK;
