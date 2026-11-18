-- Factory bilingual bale catalog and document snapshots (2026-07-31)
--
-- This migration is additive and text-only. Existing English names, article
-- codes, quantities, weights, prices, costs, stock, vouchers, journals, and
-- balances are not changed or backfilled.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '90s';

-- Core Factory catalog and document tables are required by the active feature.
ALTER TABLE factory_categories
  ADD COLUMN IF NOT EXISTS name_ar VARCHAR(100);

ALTER TABLE factory_bale_products
  ADD COLUMN IF NOT EXISTS name_ar TEXT,
  ADD COLUMN IF NOT EXISTS description_ar TEXT;

ALTER TABLE factory_bales
  ADD COLUMN IF NOT EXISTS product_name_ar TEXT,
  ADD COLUMN IF NOT EXISTS category_ar TEXT;

ALTER TABLE customer_proforma_lines
  ADD COLUMN IF NOT EXISTS product_name_ar TEXT;

ALTER TABLE customer_order_lines
  ADD COLUMN IF NOT EXISTS bale_name_ar TEXT;

ALTER TABLE customer_order_bales
  ADD COLUMN IF NOT EXISTS bale_name_ar TEXT;

ALTER TABLE customer_order_bales_history
  ADD COLUMN IF NOT EXISTS bale_name_ar TEXT;

ALTER TABLE customer_order_expected_lines
  ADD COLUMN IF NOT EXISTS product_name_ar TEXT;

-- Some linked operational tables are installed only in deployments that use
-- those modules. Guard the table itself, not only the column, so an older or
-- partially provisioned database can still receive all required core columns.
DO $$
BEGIN
  IF to_regclass('public.factory_pos_sale_items') IS NOT NULL THEN
    ALTER TABLE factory_pos_sale_items
      ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
  END IF;

  IF to_regclass('public.customer_order_bale_removals') IS NOT NULL THEN
    ALTER TABLE customer_order_bale_removals
      ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
  END IF;

  IF to_regclass('public.factory_v3_load_bales') IS NOT NULL THEN
    ALTER TABLE factory_v3_load_bales
      ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
  END IF;

  IF to_regclass('public.factory_invoice_loading_bales') IS NOT NULL THEN
    ALTER TABLE factory_invoice_loading_bales
      ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
  END IF;

  IF to_regclass('public.customer_dispatch_bale_scans') IS NOT NULL THEN
    ALTER TABLE customer_dispatch_bale_scans
      ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
  END IF;

  IF to_regclass('public.bale_recode_items') IS NOT NULL THEN
    ALTER TABLE bale_recode_items
      ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
  END IF;
END
$$;

-- Supports company-scoped exact matching after the approved conservative
-- normalization (trim surrounding whitespace, then uppercase). The existing raw
-- company/article-code unique index remains authoritative and unchanged.
CREATE INDEX IF NOT EXISTS factory_bale_products_company_article_code_normalized_idx
  ON factory_bale_products (company_id, UPPER(BTRIM(article_code)));

COMMIT;
