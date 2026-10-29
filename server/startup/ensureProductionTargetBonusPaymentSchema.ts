/**
 * Independent accounting record for a finalized, approved production bonus.
 * One allocation can never be posted twice, including after a reversal.
 * Do not run CREATE TABLE in an HTTP request or in a background job.
 */
import type { Pool } from "pg";

export async function ensureProductionTargetBonusPaymentSchema(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_production_target_bonus_payments (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      allocation_id INTEGER NOT NULL REFERENCES factory_production_bonus_allocations(id) ON DELETE RESTRICT,
      worker_id INTEGER NOT NULL REFERENCES factory_workers(id) ON DELETE RESTRICT,
      amount NUMERIC(20,2) NOT NULL CHECK (amount > 0),
      currency_code VARCHAR(3) NOT NULL DEFAULT 'USD',
      cash_ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      expense_ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      payment_date DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
      voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
      reversal_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE RESTRICT,
      posted_by TEXT NOT NULL,
      reversed_by TEXT,
      reversal_reason TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      reversed_at TIMESTAMP,
      CONSTRAINT factory_production_target_bonus_payment_unique UNIQUE(company_id, allocation_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_prod_target_bonus_payments_worker_date_idx
      ON factory_production_target_bonus_payments(company_id, worker_id, payment_date)
  `);
}
