-- Factory Arabic catalog and normalized article index.
-- Additive only, no data changes; optional tables remain optional.
ALTER TABLE public.factory_categories ADD COLUMN IF NOT EXISTS name_ar VARCHAR(100);

ALTER TABLE public.factory_bale_products ADD COLUMN IF NOT EXISTS name_ar TEXT;

ALTER TABLE public.factory_bale_products ADD COLUMN IF NOT EXISTS description_ar TEXT;

ALTER TABLE public.factory_bales ADD COLUMN IF NOT EXISTS product_name_ar TEXT;

ALTER TABLE public.factory_bales ADD COLUMN IF NOT EXISTS category_ar TEXT;

ALTER TABLE public.customer_proforma_lines ADD COLUMN IF NOT EXISTS product_name_ar TEXT;

ALTER TABLE public.customer_order_lines ADD COLUMN IF NOT EXISTS bale_name_ar TEXT;

ALTER TABLE public.customer_order_bales ADD COLUMN IF NOT EXISTS bale_name_ar TEXT;

ALTER TABLE public.customer_order_bales_history ADD COLUMN IF NOT EXISTS bale_name_ar TEXT;

ALTER TABLE public.customer_order_expected_lines ADD COLUMN IF NOT EXISTS product_name_ar TEXT;

DO $optional$
BEGIN
 IF to_regclass('public.factory_pos_sale_items') IS NOT NULL THEN
  ALTER TABLE public.factory_pos_sale_items ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
 END IF;
END
$optional$;

DO $optional$
BEGIN
 IF to_regclass('public.customer_order_bale_removals') IS NOT NULL THEN
  ALTER TABLE public.customer_order_bale_removals ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
 END IF;
END
$optional$;

DO $optional$
BEGIN
 IF to_regclass('public.factory_invoice_loading_bales') IS NOT NULL THEN
  ALTER TABLE public.factory_invoice_loading_bales ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
 END IF;
END
$optional$;

DO $optional$
BEGIN
 IF to_regclass('public.customer_dispatch_bale_scans') IS NOT NULL THEN
  ALTER TABLE public.customer_dispatch_bale_scans ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
 END IF;
END
$optional$;

DO $optional$
BEGIN
 IF to_regclass('public.bale_recode_items') IS NOT NULL THEN
  ALTER TABLE public.bale_recode_items ADD COLUMN IF NOT EXISTS product_name_ar TEXT;
 END IF;
END
$optional$;

CREATE INDEX IF NOT EXISTS factory_bale_products_company_article_code_normalized_idx
  ON public.factory_bale_products (company_id, UPPER(BTRIM(article_code)));
