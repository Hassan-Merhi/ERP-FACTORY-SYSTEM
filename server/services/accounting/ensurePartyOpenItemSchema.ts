/**
 * Additive Phase 3 matching metadata. This is NOT a new accounting ledger.
 * Source voucher entries remain unchanged. A match can be voided with audit
 * details; it is never silently deleted or used to create balancing entries.
 */
import type { Pool } from "pg";

export async function ensurePartyOpenItemSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounting_open_item_matches (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      domain VARCHAR(24) NOT NULL CHECK (domain IN ('customer', 'supplier', 'factory_supplier')),
      party_id INTEGER NOT NULL CHECK (party_id > 0),
      charge_entry_id INTEGER NOT NULL REFERENCES voucher_entries(id) ON DELETE RESTRICT,
      settlement_entry_id INTEGER NOT NULL REFERENCES voucher_entries(id) ON DELETE RESTRICT,
      amount NUMERIC(20,6) NOT NULL CHECK (amount > 0),
      currency VARCHAR(10) NOT NULL,
      applied_on DATE NOT NULL,
      idempotency_key VARCHAR(191) NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reason TEXT,
      voided_at TIMESTAMPTZ,
      voided_by TEXT,
      void_reason TEXT,
      CONSTRAINT accounting_open_item_matches_distinct_entries CHECK (charge_entry_id <> settlement_entry_id),
      CONSTRAINT accounting_open_item_matches_void_consistent CHECK (
        (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR
        (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)
      ),
      CONSTRAINT accounting_open_item_matches_idempotency UNIQUE (company_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS accounting_open_item_matches_charge_idx
      ON accounting_open_item_matches(company_id,charge_entry_id) WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS accounting_open_item_matches_settlement_idx
      ON accounting_open_item_matches(company_id,settlement_entry_id) WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS accounting_open_item_matches_party_idx
      ON accounting_open_item_matches(company_id,domain,party_id,applied_on);

    -- Company isolation in the database, as for the other unified-accounting
    -- metadata tables; every reader runs in a company-scoped transaction.
    ALTER TABLE accounting_open_item_matches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounting_open_item_matches FORCE ROW LEVEL SECURITY;
    DO $open_item_rls$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname = current_schema()
        AND tablename = 'accounting_open_item_matches'
        AND policyname = 'open_item_matches_company_scope') THEN
        CREATE POLICY open_item_matches_company_scope ON accounting_open_item_matches
          USING (company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer)
          WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer);
      END IF;
    END $open_item_rls$;
  `);
}
