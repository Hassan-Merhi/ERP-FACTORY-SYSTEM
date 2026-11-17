-- Phase 3 — Heavy factory read acceleration
--
-- Purpose:
--   Reduce the database work and temporary memory required by:
--     GET /api/factory/raw-stock
--     GET /api/factory/net-position
--
-- Safety:
--   * Index-only migration; no data or accounting logic is changed.
--   * Every statement is idempotent.
--   * Partial indexes exclude soft-deleted rows where the production queries do.
--   * Run outside a transaction because CREATE INDEX CONCURRENTLY is used.

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_raw_stock_company_live_container_idx
  ON factory_raw_stock (company_id, container_id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_containers_company_live_supplier_created_idx
  ON factory_containers (company_id, supplier_id, created_at DESC)
  WHERE deleted_at IS NULL AND status <> 'DELETED';

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_suppliers_company_category_idx
  ON factory_suppliers (company_id, supplier_category_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_raw_material_adjustments_company_live_supplier_type_idx
  ON factory_raw_material_adjustments (company_id, supplier_id, type, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_mix_batches_company_live_status_idx
  ON factory_mix_batches (company_id, status, id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_mix_batch_sources_batch_supplier_idx
  ON factory_mix_batch_sources (mix_batch_id, supplier_id)
  INCLUDE (weight_kg, total_cost);

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_mix_batch_sources_supplier_batch_idx
  ON factory_mix_batch_sources (supplier_id, mix_batch_id)
  INCLUDE (weight_kg, total_cost);

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_supplier_payments_company_date_supplier_idx
  ON factory_supplier_payments (company_id, date, supplier_id)
  INCLUDE (amount, currency_code, amount_usd);

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_supplier_fx_transfers_company_date_from_idx
  ON factory_supplier_fx_transfers (company_id, date, from_supplier_id)
  INCLUDE (to_supplier_id, from_currency_code, from_amount, to_amount_usd);

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_supplier_fx_transfers_company_date_to_idx
  ON factory_supplier_fx_transfers (company_id, date, to_supplier_id)
  INCLUDE (from_supplier_id, from_currency_code, from_amount, to_amount_usd);

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_offload_additional_charges_company_supplier_idx
  ON factory_offload_additional_charges (company_id, supplier_id)
  INCLUDE (amount, currency_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_container_other_charges_company_container_idx
  ON factory_container_other_charges (company_id, container_id)
  INCLUDE (amount, currency_code);

CREATE INDEX CONCURRENTLY IF NOT EXISTS vouchers_effective_date_live_idx
  ON vouchers ((COALESCE(effective_date, voucher_date)), id)
  WHERE optional IS NOT TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS voucher_entries_factory_supplier_debit_idx
  ON voucher_entries (factory_supplier_id, voucher_id)
  INCLUDE (debit_amount)
  WHERE factory_supplier_id IS NOT NULL AND debit_amount::numeric > 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_fx_rates_company_manual_currency_date_idx
  ON factory_fx_rates (company_id, currency_code, effective_date DESC)
  INCLUDE (rate_to_usd)
  WHERE source = 'manual';

ANALYZE factory_raw_stock;
ANALYZE factory_containers;
ANALYZE factory_suppliers;
ANALYZE factory_raw_material_adjustments;
ANALYZE factory_mix_batches;
ANALYZE factory_mix_batch_sources;
ANALYZE factory_supplier_payments;
ANALYZE factory_supplier_fx_transfers;
ANALYZE factory_offload_additional_charges;
ANALYZE factory_container_other_charges;
ANALYZE vouchers;
ANALYZE voucher_entries;
ANALYZE factory_fx_rates;
