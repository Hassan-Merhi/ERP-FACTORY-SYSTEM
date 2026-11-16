-- Move additive startup-warning schema operations into the controlled runner.
-- Deliberately do NOT delete duplicate exchange_rates or any historical data.
-- If existing rows violate the unique key, abort and require reviewed remediation.
DO $migration$
BEGIN
  IF to_regclass('public.vouchers') IS NULL OR
     to_regclass('public.voucher_entries') IS NULL OR
     to_regclass('public.sp_containers') IS NULL OR
     to_regclass('public.ledger_accounts') IS NULL OR
     to_regclass('public.user_preferences') IS NULL OR
     to_regclass('public.exchange_rates') IS NULL THEN
    RAISE EXCEPTION 'Required core table missing; refusing startup-warning schema migration';
  END IF;

  ALTER TABLE public.vouchers ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
  ALTER TABLE public.voucher_entries ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
  ALTER TABLE public.sp_containers ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
  ALTER TABLE public.sp_containers ADD COLUMN IF NOT EXISTS goods_otw_voucher_id INTEGER;
  ALTER TABLE public.ledger_accounts ADD COLUMN IF NOT EXISTS sub_type TEXT;
  ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS factory_net_position_valuation_mode TEXT NOT NULL DEFAULT 'cost';
END
$migration$;

-- Fail on duplicates instead of the legacy startup routine's destructive cleanup.
CREATE UNIQUE INDEX IF NOT EXISTS exchange_rates_company_date_pair_unique
  ON public.exchange_rates (company_id, effective_date, from_currency, to_currency);
