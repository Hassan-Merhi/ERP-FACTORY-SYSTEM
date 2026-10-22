-- Phase 8 / Factory Net Position historical query indexes.
-- AUTHOR ONLY: DO NOT execute during the branch implementation.
-- Apply separately during an approved database-maintenance window after
-- reviewing pg_stat_user_indexes, table sizes and EXPLAIN query plans.
--
-- No voucher, journal, amount, category or historical source record is changed.
-- CREATE INDEX CONCURRENTLY cannot run within a transaction block.
-- Idempotent names: existing equivalent indexes should be reviewed first.
--
-- Company + event date + actual recording time are the two primary lookup
-- dimensions of the historical as-of engine.
CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_receipts_company_cutoff_idx
  ON public.factory_container_receipts
  (company_id, receipt_date, created_at, container_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_raw_stock_company_cutoff_idx
  ON public.factory_raw_stock (company_id, created_at, container_id, offloaded_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_mix_source_batch_recorded_idx
  ON public.factory_mix_batch_sources (mix_batch_id, created_at, container_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_mix_batches_company_cutoff_idx
  ON public.factory_mix_batches (company_id, batch_date, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_bales_company_cutoff_idx
  ON public.factory_bales (company_id, created_at, stock_entry_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_order_company_cutoff_idx
  ON public.customer_orders (company_id, order_date, created_at);

-- Trigger-installed scanned_at must exist BEFORE these two indexes.
-- customerOrderBaleScanAuditBridge.mjs installs the columns for new scans
-- but does NOT invent timestamps on pre-bridge archived records.
CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_order_bale_scan_idx
  ON public.customer_order_bales (order_id, bale_id, scanned_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_order_bale_cancel_idx
  ON public.customer_order_bales_history (order_id, bale_id, cancelled_at, scanned_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_daybook_order_transitions_idx
  ON public.factory_daybook_entries (company_id, reference_table, reference_id, tx_type, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_worker_advances_company_cutoff_idx
  ON public.factory_worker_advances (company_id, advance_date, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_worker_repayments_company_cutoff_idx
  ON public.factory_advance_repayments (company_id, repayment_date, created_at, advance_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_rent_payments_company_cutoff_idx
  ON public.property_payments (company_id, module, contract_id, payment_date, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS np_hist_manual_fx_company_cutoff_idx
  ON public.factory_fx_rates (company_id, source, currency_code, effective_date DESC, created_at DESC);
