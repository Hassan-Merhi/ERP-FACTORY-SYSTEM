-- Factory French catalog and linked-name snapshots
-- Additive text-only migration. Existing English/Arabic values and all numeric
-- business data remain unchanged.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '90s';

ALTER TABLE factory_categories ADD COLUMN IF NOT EXISTS name_fr VARCHAR(100);
ALTER TABLE factory_bale_products
  ADD COLUMN IF NOT EXISTS name_fr TEXT,
  ADD COLUMN IF NOT EXISTS description_fr TEXT;
ALTER TABLE factory_bales
  ADD COLUMN IF NOT EXISTS product_name_fr TEXT,
  ADD COLUMN IF NOT EXISTS category_fr TEXT;
ALTER TABLE customer_proforma_lines ADD COLUMN IF NOT EXISTS product_name_fr TEXT;
ALTER TABLE customer_order_lines ADD COLUMN IF NOT EXISTS bale_name_fr TEXT;
ALTER TABLE customer_order_bales ADD COLUMN IF NOT EXISTS bale_name_fr TEXT;
ALTER TABLE customer_order_bales_history ADD COLUMN IF NOT EXISTS bale_name_fr TEXT;
ALTER TABLE customer_order_expected_lines ADD COLUMN IF NOT EXISTS product_name_fr TEXT;

DO $$
BEGIN
  IF to_regclass('public.factory_pos_sale_items') IS NOT NULL THEN
    ALTER TABLE factory_pos_sale_items ADD COLUMN IF NOT EXISTS product_name_fr TEXT;
  END IF;
  IF to_regclass('public.customer_order_bale_removals') IS NOT NULL THEN
    ALTER TABLE customer_order_bale_removals ADD COLUMN IF NOT EXISTS product_name_fr TEXT;
  END IF;
  IF to_regclass('public.factory_v3_load_bales') IS NOT NULL THEN
    ALTER TABLE factory_v3_load_bales ADD COLUMN IF NOT EXISTS product_name_fr TEXT;
  END IF;
  IF to_regclass('public.factory_invoice_loading_bales') IS NOT NULL THEN
    ALTER TABLE factory_invoice_loading_bales ADD COLUMN IF NOT EXISTS product_name_fr TEXT;
  END IF;
  IF to_regclass('public.customer_dispatch_bale_scans') IS NOT NULL THEN
    ALTER TABLE customer_dispatch_bale_scans ADD COLUMN IF NOT EXISTS product_name_fr TEXT;
  END IF;
  IF to_regclass('public.bale_recode_items') IS NOT NULL THEN
    ALTER TABLE bale_recode_items ADD COLUMN IF NOT EXISTS product_name_fr TEXT;
  END IF;
END
$$;

COMMIT;
