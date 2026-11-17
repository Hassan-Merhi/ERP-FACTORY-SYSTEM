-- 0004_widen_numeric_precision_to_declared.sql
--
-- Widen numeric columns whose deployed precision is narrower than the
-- application's declared (shared/schema, Drizzle) precision, so values the code
-- computes are no longer rounded or rejected by the database.
--
-- Every change is a pure widening: the new type keeps the larger number of
-- integer digits AND the larger scale of the deployed and declared types
-- (numeric(max(int digits) + max(scale), max(scale))). No stored value can be
-- rounded, truncated or rejected. Where the declared type has fewer integer
-- digits than production (mix_batches.cost_per_kg, sales_items.selling_price),
-- production's integer digits are kept. Text/varchar -> numeric and
-- unconstrained numeric -> bounded numeric differences are NOT changed (not
-- widenings). Existing values are unchanged; only future writes may store
-- more digits.
--
-- Rewrites the listed tables (ACCESS EXCLUSIVE lock while it runs); apply in a
-- maintenance window on large databases.

-- public.factory_bales: weight_kg numeric(12,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.factory_bales
  ALTER COLUMN weight_kg TYPE numeric(15,3);

-- public.factory_containers: commission_amount numeric(16,2) -> numeric(20,2) (declared numeric(20,2)); duty_amount numeric(16,2) -> numeric(20,2) (declared numeric(20,2)); final_payable_amount_usd numeric(16,2) -> numeric(20,4) (declared numeric(20,4)); freight numeric(16,2) -> numeric(20,2) (declared numeric(20,2)); fx_rate_to_usd_import numeric(16,6) -> numeric(20,8) (declared numeric(20,8)); fx_rate_to_usd_offload numeric(16,6) -> numeric(20,8) (declared numeric(20,8)); other_charges numeric(16,2) -> numeric(20,2) (declared numeric(20,2)); total_kg numeric(12,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.factory_containers
  ALTER COLUMN commission_amount TYPE numeric(20,2),
  ALTER COLUMN duty_amount TYPE numeric(20,2),
  ALTER COLUMN final_payable_amount_usd TYPE numeric(20,4),
  ALTER COLUMN freight TYPE numeric(20,2),
  ALTER COLUMN fx_rate_to_usd_import TYPE numeric(20,8),
  ALTER COLUMN fx_rate_to_usd_offload TYPE numeric(20,8),
  ALTER COLUMN other_charges TYPE numeric(20,2),
  ALTER COLUMN total_kg TYPE numeric(15,3);

-- public.factory_mix_batch_sources: quantity_kg numeric(12,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.factory_mix_batch_sources
  ALTER COLUMN quantity_kg TYPE numeric(15,3);

-- public.factory_mix_batches: total_weight_kg numeric(12,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.factory_mix_batches
  ALTER COLUMN total_weight_kg TYPE numeric(15,3);

-- public.factory_offload_additional_charges: fx_rate_to_usd numeric(20,8) -> numeric(22,8) (declared numeric(20,6))
ALTER TABLE public.factory_offload_additional_charges
  ALTER COLUMN fx_rate_to_usd TYPE numeric(22,8);

-- public.factory_suppliers: current_raw_material_cost_per_kg_usd numeric(18,6) -> numeric(20,8) (declared numeric(20,8)); opening_balance numeric(15,2) -> numeric(20,4) (declared numeric(20,4))
-- The opening-balance lock trigger names opening_balance (UPDATE OF), which
-- blocks ALTER TYPE. It is dropped and recreated with its exact definition in
-- this same transaction; the ALTER holds an ACCESS EXCLUSIVE lock on the table
-- throughout, so no write can ever run without the guard.
DROP TRIGGER factory_suppliers_opening_balance_lock ON public.factory_suppliers;
ALTER TABLE public.factory_suppliers
  ALTER COLUMN current_raw_material_cost_per_kg_usd TYPE numeric(20,8),
  ALTER COLUMN opening_balance TYPE numeric(20,4);
CREATE TRIGGER factory_suppliers_opening_balance_lock
  BEFORE INSERT OR DELETE OR UPDATE OF opening_balance, company_id ON public.factory_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.erp_opening_balance_lock_guard();

-- public.mix_batches: cost_per_kg numeric(20,2) -> numeric(22,4) (declared numeric(20,4))
ALTER TABLE public.mix_batches
  ALTER COLUMN cost_per_kg TYPE numeric(22,4);

-- public.sales_items: selling_price numeric(15,2) -> numeric(19,6) (declared numeric(15,6))
ALTER TABLE public.sales_items
  ALTER COLUMN selling_price TYPE numeric(19,6);

-- public.supplier_container_loaded_items: price_per_bale numeric(14,2) -> numeric(15,2) (declared numeric(15,2)); weight_per_bale numeric(14,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.supplier_container_loaded_items
  ALTER COLUMN price_per_bale TYPE numeric(15,2),
  ALTER COLUMN weight_per_bale TYPE numeric(15,3);

-- public.supplier_proforma_lines: price_per_bale numeric(14,2) -> numeric(15,2) (declared numeric(15,2)); weight_per_bale numeric(14,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.supplier_proforma_lines
  ALTER COLUMN price_per_bale TYPE numeric(15,2),
  ALTER COLUMN weight_per_bale TYPE numeric(15,3);
