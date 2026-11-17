-- Idempotent production migration for the 2026-07-21 database-pool incident.
-- Apply before deploying the matching application build when startup migrations
-- are disabled. These statements are safe to run more than once.

ALTER TABLE voucher_entries
  ADD COLUMN IF NOT EXISTS base_debit_amount NUMERIC(20,6);

ALTER TABLE voucher_entries
  ADD COLUMN IF NOT EXISTS base_credit_amount NUMERIC(20,6);

CREATE INDEX IF NOT EXISTS user_locations_user_company_location_idx
  ON user_locations (user_id, company_id, location_id);
