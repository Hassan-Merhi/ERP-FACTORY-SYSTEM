/**
 * Phase 4 — additive cash/bank statement reconciliation metadata.
 * It neither adjusts GL balances nor posts an accounting voucher.
 * Production may skip bulk migrations, so this is invoked by the existing
 * always-on runtime schema initializer before routes become available.
 */
import type { Pool } from "pg";

export async function ensureCashBankReconciliationSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounting_cash_bank_statements (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      account_kind VARCHAR(10) NOT NULL CHECK (account_kind IN ('bank','ledger')),
      account_id INTEGER NOT NULL CHECK (account_id > 0),
      currency VARCHAR(10) NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      opening_balance NUMERIC(20,6) NOT NULL,
      closing_balance NUMERIC(20,6) NOT NULL,
      file_hash VARCHAR(64) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      imported_by TEXT NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT cash_bank_statement_valid_period CHECK (period_start <= period_end),
      CONSTRAINT cash_bank_statement_file_unique UNIQUE(company_id,account_kind,account_id,file_hash)
    );
    CREATE INDEX IF NOT EXISTS accounting_cash_bank_statements_account_idx
      ON accounting_cash_bank_statements(company_id,account_kind,account_id,period_end DESC);
    CREATE TABLE IF NOT EXISTS accounting_cash_bank_statement_lines (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      statement_id BIGINT NOT NULL REFERENCES accounting_cash_bank_statements(id) ON DELETE RESTRICT,
      row_number INTEGER NOT NULL CHECK(row_number > 0),
      transaction_date DATE NOT NULL,
      amount NUMERIC(20,6) NOT NULL CHECK (amount <> 0),
      reference TEXT,
      description TEXT,
      running_balance NUMERIC(20,6),
      CONSTRAINT cash_bank_statement_line_unique UNIQUE(statement_id,row_number)
    );
    CREATE INDEX IF NOT EXISTS accounting_cash_bank_statement_lines_statement_idx
      ON accounting_cash_bank_statement_lines(company_id,statement_id,transaction_date);
    ALTER TABLE accounting_cash_bank_statement_lines
      ADD COLUMN IF NOT EXISTS review_category VARCHAR(32),
      ADD COLUMN IF NOT EXISTS review_note TEXT,
      ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
    DO $review_check$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint
          WHERE conname='cash_bank_line_review_category_check') THEN
        ALTER TABLE accounting_cash_bank_statement_lines
          ADD CONSTRAINT cash_bank_line_review_category_check
          CHECK(review_category IS NULL OR review_category IN (
            'bank_fee','transfer','unidentified_receipt','unidentified_payment','other'
          ));
      END IF;
    END $review_check$;
    CREATE TABLE IF NOT EXISTS accounting_cash_bank_matches (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      statement_line_id BIGINT NOT NULL REFERENCES accounting_cash_bank_statement_lines(id) ON DELETE RESTRICT,
      voucher_entry_id INTEGER NOT NULL REFERENCES voucher_entries(id) ON DELETE RESTRICT,
      matched_on DATE NOT NULL,
      matched_by TEXT NOT NULL,
      reason TEXT,
      matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      voided_at TIMESTAMPTZ,
      voided_by TEXT,
      void_reason TEXT,
      CONSTRAINT cash_bank_match_void_consistent CHECK (
        (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
        OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cash_bank_match_active_line_uq
      ON accounting_cash_bank_matches(statement_line_id) WHERE voided_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS cash_bank_match_active_entry_uq
      ON accounting_cash_bank_matches(voucher_entry_id) WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS cash_bank_match_company_idx
      ON accounting_cash_bank_matches(company_id,statement_line_id);
    -- Enforce the same company boundary as the existing accounting tables.
    -- Importers and readers first call assertTransactionCompanyScope(tx,...).
    ALTER TABLE accounting_cash_bank_statements ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounting_cash_bank_statements FORCE ROW LEVEL SECURITY;
    ALTER TABLE accounting_cash_bank_statement_lines ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounting_cash_bank_statement_lines FORCE ROW LEVEL SECURITY;
    ALTER TABLE accounting_cash_bank_matches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounting_cash_bank_matches FORCE ROW LEVEL SECURITY;

    DO $bank_rls$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname = current_schema()
        AND tablename = 'accounting_cash_bank_statements'
        AND policyname = 'cash_bank_statements_company_scope') THEN
        CREATE POLICY cash_bank_statements_company_scope ON accounting_cash_bank_statements
          USING (company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer)
          WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname = current_schema()
        AND tablename = 'accounting_cash_bank_statement_lines'
        AND policyname = 'cash_bank_lines_company_scope') THEN
        CREATE POLICY cash_bank_lines_company_scope ON accounting_cash_bank_statement_lines
          USING (company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer)
          WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname = current_schema()
        AND tablename = 'accounting_cash_bank_matches'
        AND policyname = 'cash_bank_matches_company_scope') THEN
        CREATE POLICY cash_bank_matches_company_scope ON accounting_cash_bank_matches
          USING (company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer)
          WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id',true),'')::integer);
      END IF;
    END $bank_rls$;

  `);
}
