/**
 * Realized FX recognition is deliberately a separate, opt-in posting.
 * A Phase 3 match is the immutable evidence; the existing double-entry
 * engine writes its USD residual against the party and FX-REVALUATION.
 */
import type { Pool } from "pg";
export async function ensureMonetaryFxSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounting_fx_realizations (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      match_id BIGINT NOT NULL REFERENCES accounting_open_item_matches(id) ON DELETE RESTRICT,
      voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
      native_currency VARCHAR(10) NOT NULL,
      native_amount NUMERIC(20,6) NOT NULL,
      historical_charge_base NUMERIC(20,6) NOT NULL,
      historical_settlement_base NUMERIC(20,6) NOT NULL,
      realized_gain_base NUMERIC(20,6) NOT NULL,
      recognized_date DATE NOT NULL,
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT accounting_fx_realizations_match_unique UNIQUE(company_id,match_id),
      CONSTRAINT accounting_fx_realizations_voucher_unique UNIQUE(company_id,voucher_id)
    );
    CREATE INDEX IF NOT EXISTS accounting_fx_realizations_company_idx
      ON accounting_fx_realizations(company_id,recognized_date);
    ALTER TABLE accounting_fx_realizations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounting_fx_realizations FORCE ROW LEVEL SECURITY;
    DO $fx_company_rls$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema()
        AND tablename='accounting_fx_realizations'
        AND policyname='accounting_fx_realizations_company_scope') THEN
        CREATE POLICY accounting_fx_realizations_company_scope ON accounting_fx_realizations
          USING(company_id=NULLIF(current_setting('app.current_company_id',true),'')::integer)
          WITH CHECK(company_id=NULLIF(current_setting('app.current_company_id',true),'')::integer);
      END IF;
    END $fx_company_rls$;
  `);
}
