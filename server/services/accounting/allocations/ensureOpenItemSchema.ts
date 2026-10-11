/**
 * Boot-time schema of the open-item allocations (phase 25; same statements as
 * migrations/20261011_025_open_item_allocations.sql). Additive and idempotent;
 * no data is changed. Production may run with RUN_STARTUP_MIGRATIONS=false,
 * so this is ensured during database warmup like the recurring journals.
 */
import type { DatabasePool } from "../../../db";
import { logger } from "../../../lib/logger";
import { OPEN_ITEM_ENABLEMENT_SCHEMA_SQL } from "./allocationEnablement";

export const OPEN_ITEM_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS party_open_item_allocations (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    party_kind VARCHAR(20) NOT NULL,
    party_id INTEGER NOT NULL,
    invoice_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
    payment_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
    amount NUMERIC(20, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    method VARCHAR(20) NOT NULL,
    reason TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ,
    released_by TEXT,
    release_reason TEXT,
    CONSTRAINT party_open_item_allocations_amount_positive CHECK (amount > 0),
    CONSTRAINT party_open_item_allocations_kind_valid
      CHECK (party_kind IN ('customer', 'supplier', 'employee', 'factorySupplier')),
    CONSTRAINT party_open_item_allocations_method_valid CHECK (method IN ('auto_fifo', 'manual', 'note')),
    CONSTRAINT party_open_item_allocations_sides_differ CHECK (invoice_voucher_id IS DISTINCT FROM payment_voucher_id)
  )`,
  `CREATE INDEX IF NOT EXISTS party_open_item_allocations_party_idx
     ON party_open_item_allocations (company_id, party_kind, party_id)`,
  `CREATE INDEX IF NOT EXISTS party_open_item_allocations_invoice_idx
     ON party_open_item_allocations (invoice_voucher_id)`,
  `CREATE INDEX IF NOT EXISTS party_open_item_allocations_payment_idx
     ON party_open_item_allocations (payment_voucher_id)`,
  `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER`,
  `ALTER TABLE factory_suppliers
     ADD COLUMN IF NOT EXISTS opening_balance_side VARCHAR(2),
     ADD COLUMN IF NOT EXISTS opening_balance_currency VARCHAR(3),
     ADD COLUMN IF NOT EXISTS opening_balance_native_amount NUMERIC(20, 4),
     ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER`,
  // Integration review: the per-company enablement marker of the automatic run (allocationEnablement.ts).
  OPEN_ITEM_ENABLEMENT_SCHEMA_SQL,
] as const;

export async function ensureOpenItemSchema(pool: DatabasePool): Promise<void> {
  for (const statement of OPEN_ITEM_SCHEMA_SQL) {
    await pool.query(statement);
  }
  logger.info("[startup] ✓ Open-item allocation schema ensured");
}
