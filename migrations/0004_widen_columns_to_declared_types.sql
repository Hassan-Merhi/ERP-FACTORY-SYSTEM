-- 0004_widen_columns_to_declared_types.sql
--
-- Widen columns whose deployed type is narrower than the application's declared
-- type (shared/schema, Drizzle), so values the code writes are no longer
-- rounded, truncated or rejected by the database. Testing against the deployed
-- schema showed real failures this fixes, e.g. factory daybook edits
-- (factory_daybook_entry_edits.edited_by was integer while the code writes user
-- ids) and SP stock movements (source_type varchar(20) too short).
--
-- Every change is a pure widening; no stored value can change, be rounded or be
-- rejected:
--   * numeric(p,s): numeric(max integer digits + max scale, max scale) of the
--     deployed and declared types (keeps production's integer digits where the
--     declaration has fewer);
--   * varchar(n) -> varchar(m >= n) / unbounded varchar / text;
--   * integer -> varchar (user-id columns; integers render to text exactly).
-- Narrowing differences (text -> varchar(n), timestamptz -> timestamp,
-- text -> numeric, unconstrained numeric -> numeric(p,s), numeric -> integer)
-- are deliberately NOT changed.
--
-- Triggers that name a changed column (UPDATE OF ...) block ALTER TYPE; they are
-- dropped and recreated with their exact definition in this same transaction,
-- while ALTER TABLE holds an ACCESS EXCLUSIVE lock, so no write ever runs
-- without them. Rewrites the listed tables: apply in a maintenance window.

-- public.bales: category character varying(255) -> text (declared text); grade character varying(10) -> text (declared text); origin character varying(10) -> text (declared text); status character varying(20) -> text (declared text)
ALTER TABLE public.bales
  ALTER COLUMN category TYPE text,
  ALTER COLUMN grade TYPE text,
  ALTER COLUMN origin TYPE text,
  ALTER COLUMN status TYPE text;

-- public.container_documents: uploaded_by integer -> character varying (declared character varying)
ALTER TABLE public.container_documents
  ALTER COLUMN uploaded_by TYPE character varying;

-- public.erp_user_page_access: user_id character varying(255) -> character varying (declared character varying)
ALTER TABLE public.erp_user_page_access
  ALTER COLUMN user_id TYPE character varying;

-- public.factory_bale_photos: uploaded_by integer -> character varying (declared character varying)
ALTER TABLE public.factory_bale_photos
  ALTER COLUMN uploaded_by TYPE character varying;

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

-- public.factory_daybook_entry_edits: edited_by integer -> character varying (declared character varying)
ALTER TABLE public.factory_daybook_entry_edits
  ALTER COLUMN edited_by TYPE character varying;

-- public.factory_mix_batch_sources: quantity_kg numeric(12,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.factory_mix_batch_sources
  ALTER COLUMN quantity_kg TYPE numeric(15,3);

-- public.factory_mix_batches: total_weight_kg numeric(12,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.factory_mix_batches
  ALTER COLUMN total_weight_kg TYPE numeric(15,3);

-- public.factory_offload_additional_charges: currency_code character varying(10) -> text (declared text); fx_rate_to_usd numeric(20,8) -> numeric(22,8) (declared numeric(20,6))
ALTER TABLE public.factory_offload_additional_charges
  ALTER COLUMN currency_code TYPE text,
  ALTER COLUMN fx_rate_to_usd TYPE numeric(22,8);

-- public.factory_supplier_fx_transfers: source_type character varying(20) -> text (declared text)
ALTER TABLE public.factory_supplier_fx_transfers
  ALTER COLUMN source_type TYPE text;

-- public.factory_suppliers: current_raw_material_cost_per_kg_usd numeric(18,6) -> numeric(20,8) (declared numeric(20,8)); opening_balance numeric(15,2) -> numeric(20,4) (declared numeric(20,4))
DROP TRIGGER factory_suppliers_opening_balance_lock ON public.factory_suppliers;
ALTER TABLE public.factory_suppliers
  ALTER COLUMN current_raw_material_cost_per_kg_usd TYPE numeric(20,8),
  ALTER COLUMN opening_balance TYPE numeric(20,4);
CREATE TRIGGER factory_suppliers_opening_balance_lock BEFORE INSERT OR DELETE OR UPDATE OF opening_balance, company_id ON public.factory_suppliers FOR EACH ROW EXECUTE FUNCTION public.erp_opening_balance_lock_guard();

-- public.mix_batches: cost_per_kg numeric(20,2) -> numeric(22,4) (declared numeric(20,4)); status character varying(20) -> text (declared text)
ALTER TABLE public.mix_batches
  ALTER COLUMN cost_per_kg TYPE numeric(22,4),
  ALTER COLUMN status TYPE text;

-- public.pending_barcodes: category character varying(255) -> text (declared text); grade character varying(50) -> text (declared text); origin character varying(100) -> text (declared text)
ALTER TABLE public.pending_barcodes
  ALTER COLUMN category TYPE text,
  ALTER COLUMN grade TYPE text,
  ALTER COLUMN origin TYPE text;

-- public.production_bales: category character varying(50) -> text (declared text); grade character varying(20) -> text (declared text); status character varying(20) -> text (declared text); warehouse_location character varying(100) -> text (declared text)
ALTER TABLE public.production_bales
  ALTER COLUMN category TYPE text,
  ALTER COLUMN grade TYPE text,
  ALTER COLUMN status TYPE text,
  ALTER COLUMN warehouse_location TYPE text;

-- public.sales_items: selling_price numeric(15,2) -> numeric(19,6) (declared numeric(15,6))
ALTER TABLE public.sales_items
  ALTER COLUMN selling_price TYPE numeric(19,6);

-- public.sp_stock_movements: source_type character varying(20) -> character varying(40) (declared character varying(40))
ALTER TABLE public.sp_stock_movements
  ALTER COLUMN source_type TYPE character varying(40);

-- public.stored_files: uploaded_by integer -> character varying (declared character varying)
ALTER TABLE public.stored_files
  ALTER COLUMN uploaded_by TYPE character varying;

-- public.supplier_container_loaded_items: item_name character varying(255) -> text (declared text); price_per_bale numeric(14,2) -> numeric(15,2) (declared numeric(15,2)); weight_per_bale numeric(14,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.supplier_container_loaded_items
  ALTER COLUMN item_name TYPE text,
  ALTER COLUMN price_per_bale TYPE numeric(15,2),
  ALTER COLUMN weight_per_bale TYPE numeric(15,3);

-- public.supplier_proforma_lines: item_name character varying(255) -> text (declared text); price_per_bale numeric(14,2) -> numeric(15,2) (declared numeric(15,2)); weight_per_bale numeric(14,3) -> numeric(15,3) (declared numeric(15,3))
ALTER TABLE public.supplier_proforma_lines
  ALTER COLUMN item_name TYPE text,
  ALTER COLUMN price_per_bale TYPE numeric(15,2),
  ALTER COLUMN weight_per_bale TYPE numeric(15,3);

-- public.user_locations: user_id text -> character varying (declared character varying)
ALTER TABLE public.user_locations
  ALTER COLUMN user_id TYPE character varying;

-- public.vouchers: location_name character varying(255) -> text (declared text)
ALTER TABLE public.vouchers
  ALTER COLUMN location_name TYPE text;
