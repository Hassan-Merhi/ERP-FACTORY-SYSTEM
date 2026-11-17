-- 0003_retail_selling_legacy_backfill.sql
--
-- Data backfill that server/startup/ensureRuntimeSchema.ts
-- (ensureRetailSellingSchema) ran on every boot after adding the Retail Wave 2
-- pricing/tax columns: rows written before those columns existed carry 0 and are
-- filled from the legacy amounts. Statements copied verbatim.
--
-- Idempotent and narrowly scoped: each UPDATE only touches rows whose new
-- columns are still at their 0 default while the legacy amount is non-zero. On
-- the deployed databases it has already run on every boot, so it changes
-- nothing there; it is kept so no database can skip it. No accounting, voucher
-- or stock-movement table is touched.

UPDATE public.retail_pos_sales
   SET list_subtotal = total_amount, subtotal = total_amount
 WHERE list_subtotal = 0 AND subtotal = 0 AND total_amount <> 0;

UPDATE public.retail_pos_sale_items
   SET original_unit_price = unit_price,
       gross_unit_price = unit_price,
       line_total = unit_price * quantity
 WHERE original_unit_price = 0 AND line_total = 0 AND unit_price <> 0;

UPDATE public.retail_pos_return_items
   SET gross_unit_price = unit_price
 WHERE gross_unit_price = 0 AND unit_price <> 0;
