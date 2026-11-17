-- Idempotent migration: extend factory_offload_additional_charges for edit/undo support.
-- Run via direct psql; do NOT execute during development with drizzle-kit push.

ALTER TABLE factory_offload_additional_charges
  ADD COLUMN IF NOT EXISTS fx_rate_date date,
  ADD COLUMN IF NOT EXISTS voucher_id integer REFERENCES vouchers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS daybook_entry_id integer,
  ADD COLUMN IF NOT EXISTS reversal_daybook_entry_id integer,
  ADD COLUMN IF NOT EXISTS supplier_locked_rate_before decimal(20, 8),
  ADD COLUMN IF NOT EXISTS supplier_locked_rate_after decimal(20, 8),
  ADD COLUMN IF NOT EXISTS supplier_remaining_kg_at_apply decimal(20, 3),
  ADD COLUMN IF NOT EXISTS full_container_value_delta_usd decimal(20, 6),
  ADD COLUMN IF NOT EXISTS supplier_inventory_value_delta_usd decimal(20, 6),
  ADD COLUMN IF NOT EXISTS remaining_fraction_at_apply decimal(20, 8),
  ADD COLUMN IF NOT EXISTS created_by_user_id text,
  ADD COLUMN IF NOT EXISTS updated_by_user_id text,
  ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamp,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS factory_offload_addl_charges_co_ctr_del_idx
  ON factory_offload_additional_charges (company_id, container_id, deleted_at);
