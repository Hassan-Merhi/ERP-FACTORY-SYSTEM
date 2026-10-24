-- Render ERP production diagnostics — 24 Oct 2026
-- READ ONLY. Paste into TablePlus for production inspection.
-- This script does not add/alter/delete any financial or stock data.

-- A. Check collision that caused POST /api/locations to fail.
-- "locations_code_unique" is GLOBAL (not per company).
SELECT id, company_id, code, name, deleted_at
FROM public.locations
WHERE upper(code) LIKE 'TEST%'
ORDER BY code, company_id, id
LIMIT 100;

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.locations'::regclass
  AND contype IN ('u','p')
ORDER BY conname;

-- B. Find missing columns required by the deployed Drizzle models.
-- Legacy fiscal_period_closures is known to lack "closure_date".
WITH expected(table_name, column_name) AS (
  VALUES
    ('locations','id'), ('locations','company_id'),
    ('locations','code'), ('locations','name'),
    ('locations','city'), ('locations','state'),
    ('locations','country'), ('locations','active'),
    ('locations','deleted_at'), ('locations','created_at'),
    ('locations','whatsapp_group_chat_id'),
    ('locations','transfer_wa_group_chat_id'),
    ('locations','supplier_partner_payable_deduction_per_qty'),
    ('fiscal_period_closures','id'),
    ('fiscal_period_closures','company_id'),
    ('fiscal_period_closures','period_start_date'),
    ('fiscal_period_closures','period_end_date'),
    ('fiscal_period_closures','closure_date'),
    ('fiscal_period_closures','closed_by_user_id'),
    ('fiscal_period_closures','closing_voucher_id'),
    ('fiscal_period_closures','retained_earnings_account_id'),
    ('fiscal_period_closures','total_income'),
    ('fiscal_period_closures','total_expense'),
    ('fiscal_period_closures','net_income'),
    ('fiscal_period_closures','status'),
    ('fiscal_period_closures','notes'),
    ('fiscal_period_closures','opening_balance_snapshot'),
    ('fiscal_period_closures','created_at')
)
SELECT e.table_name, e.column_name,
       CASE WHEN to_regclass('public.' || e.table_name) IS NULL
            THEN 'TABLE MISSING' ELSE 'COLUMN MISSING' END AS finding
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema='public'
 AND c.table_name=e.table_name
 AND c.column_name=e.column_name
WHERE c.column_name IS NULL
ORDER BY e.table_name, e.column_name;

-- C. Look for legacy fiscal names that may safely map to canonical fields.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='fiscal_period_closures'
ORDER BY ordinal_position;

-- D. Audit reported missing stock journal evidence; do not insert
-- synthetic movements merely to clear a warning.
SELECT company_id, source_type, source_id,
       COUNT(*) AS movement_count,
       SUM(quantity_delta) AS total_quantity_delta
FROM public.canonical_stock_movements
WHERE (company_id=1 AND source_type='stock-adjustment' AND source_id='245')
   OR (company_id=9 AND source_type='stock-transfer' AND source_id='889')
GROUP BY company_id, source_type, source_id
ORDER BY company_id, source_type, source_id;
