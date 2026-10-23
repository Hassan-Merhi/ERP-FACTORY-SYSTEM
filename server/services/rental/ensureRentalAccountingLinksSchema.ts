/**
 * Phase 8 — additive attribution of already-posted property maintenance and
 * property-expense vouchers to a rental contract. NO accounting repost.
 *
 * Allocations are base USD. Native currency and historical voucher FX remain
 * untouched; this table cannot turn one currency into another or change GL.
 */
import type { Pool } from "pg";
export async function ensureRentalAccountingLinksSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounting_rental_expense_links (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      module VARCHAR(12) NOT NULL CHECK(module IN ('ERP','FACTORY','PROPERTIES')),
      contract_id INTEGER NOT NULL REFERENCES property_contracts(id) ON DELETE RESTRICT,
      unit_id INTEGER NOT NULL REFERENCES property_units(id) ON DELETE RESTRICT,
      voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
      category VARCHAR(32) NOT NULL CHECK(category IN
        ('maintenance','repairs','utilities','insurance','property_tax','other_property_cost')),
      allocated_usd NUMERIC(20,6) NOT NULL CHECK(allocated_usd>0),
      note TEXT,
      tagged_by TEXT NOT NULL,
      client_request_key VARCHAR(128),
      tagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      voided_at TIMESTAMPTZ,
      voided_by TEXT,
      void_reason TEXT,
      CONSTRAINT rental_expense_link_void_consistent CHECK(
        (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR
        (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS accounting_rental_expense_links_unit_idx
      ON accounting_rental_expense_links(company_id,module,unit_id)
      WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS accounting_rental_expense_links_contract_idx
      ON accounting_rental_expense_links(company_id,module,contract_id)
      WHERE voided_at IS NULL;
    ALTER TABLE accounting_rental_expense_links
      ADD COLUMN IF NOT EXISTS client_request_key VARCHAR(128);
    CREATE UNIQUE INDEX IF NOT EXISTS accounting_rental_expense_link_request_uq
      ON accounting_rental_expense_links(company_id,client_request_key)
      WHERE client_request_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS accounting_rental_expense_links_voucher_idx
      ON accounting_rental_expense_links(company_id,voucher_id)
      WHERE voided_at IS NULL;
    ALTER TABLE accounting_rental_expense_links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounting_rental_expense_links FORCE ROW LEVEL SECURITY;
    DO $rental_accounting_rls$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema()
        AND tablename='accounting_rental_expense_links'
        AND policyname='accounting_rental_expense_links_company') THEN
        CREATE POLICY accounting_rental_expense_links_company ON accounting_rental_expense_links
         USING(company_id=NULLIF(current_setting('app.current_company_id',true),'')::integer)
         WITH CHECK(company_id=NULLIF(current_setting('app.current_company_id',true),'')::integer);
      END IF;
    END $rental_accounting_rls$;
  `);
}
