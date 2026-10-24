-- ERP/Factory: guarded fiscal_period_closures schema catch-up.
-- Production state inspected 2026-10-24: zero fiscal closings.
-- IMPORTANT: Run manually via TablePlus with a verified backup.
-- Preserves original legacy columns and never synthesizes financial transactions.
--
-- This repairs a legacy physical table carrying period_start/period_end and
-- closed_at, but missing fields of the current Drizzle table definition.
-- The original legacy period_start / period_end columns are made nullable,
-- NOT removed: otherwise the modern INSERT cannot populate the table.
--
-- Refuse any mutation if there are already fiscal closures. In that case a
-- data-preserving row-by-row conversion must be reviewed independently.

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.fiscal_period_closures') IS NULL THEN
    RAISE EXCEPTION 'fiscal_period_closures is missing; this catch-up is not applicable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fiscal_period_closures LIMIT 1) THEN
    RAISE EXCEPTION 'Fiscal closures exist. Refusing automated schema conversion.';
  END IF;
END
$guard$;

LOCK TABLE public.fiscal_period_closures IN ACCESS EXCLUSIVE MODE;

-- Canonical writer columns. The empty-table precondition lets us safely add
-- NOT NULL fields without invented defaults or backfilled amounts.
ALTER TABLE public.fiscal_period_closures
    ADD COLUMN IF NOT EXISTS closed_by_user_id VARCHAR,
    ADD COLUMN IF NOT EXISTS retained_earnings_account_id INTEGER,
    ADD COLUMN IF NOT EXISTS total_income DECIMAL(15,2),
    ADD COLUMN IF NOT EXISTS total_expense DECIMAL(15,2),
    ADD COLUMN IF NOT EXISTS net_income DECIMAL(15,2),
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();

-- The table had these columns already but they were optional; the new writer
-- always populates them. Preserve the date/value types.
ALTER TABLE public.fiscal_period_closures
    ALTER COLUMN period_start_date SET NOT NULL,
    ALTER COLUMN period_end_date SET NOT NULL,
    ALTER COLUMN closing_voucher_id SET NOT NULL,
    ALTER COLUMN closed_by_user_id SET NOT NULL,
    ALTER COLUMN retained_earnings_account_id SET NOT NULL,
    ALTER COLUMN total_income SET NOT NULL,
    ALTER COLUMN total_expense SET NOT NULL,
    ALTER COLUMN net_income SET NOT NULL;

-- The old application required period_start and period_end on INSERT. Keep
-- their columns for history, but do not require them from the new writer.
DO $legacy$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='fiscal_period_closures'
      AND column_name='period_start'
  ) THEN
    ALTER TABLE public.fiscal_period_closures
      ALTER COLUMN period_start DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='fiscal_period_closures'
      AND column_name='period_end'
  ) THEN
    ALTER TABLE public.fiscal_period_closures
      ALTER COLUMN period_end DROP NOT NULL;
  END IF;
END
$legacy$;

-- Preserve current unique fiscal period protection and add the expected
-- unique closing-voucher identity.
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_closures_closing_voucher_unique
    ON public.fiscal_period_closures (closing_voucher_id);

COMMIT;

-- Post-fix verification: should return no missing required canonical columns.
WITH expected(column_name) AS (
 VALUES ('id'),('company_id'),('period_start_date'),('period_end_date'),
 ('closure_date'),('closed_by_user_id'),('closing_voucher_id'),
 ('retained_earnings_account_id'),('total_income'),('total_expense'),
 ('net_income'),('status'),('notes'),('opening_balance_snapshot'),('created_at')
)
SELECT e.column_name AS missing_column
FROM expected e
LEFT JOIN information_schema.columns c
 ON c.table_schema='public' AND c.table_name='fiscal_period_closures'
 AND c.column_name=e.column_name
WHERE c.column_name IS NULL
ORDER BY e.column_name;
