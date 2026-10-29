/**
 * Phase 5/6 - direct payments of the Phase 4 immutable Production Targets reviews.
 * On standalone feature branches the reviews may not yet be installed; the payment
 * table is installed as soon as the reviews phase and this phase share a release.
 */
import type { Pool } from "pg";

export async function ensureProductionTargetBonusPaymentSchema(pool: Pick<Pool, "query">): Promise<void> {
  const reviews = await pool.query("SELECT to_regclass('public.factory_target_bonus_reviews') AS review_table");
  if (!(reviews as { rows?: Array<{ review_table: string | null }> }).rows?.[0]?.review_table) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_target_bonus_payments (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      review_id INTEGER NOT NULL REFERENCES factory_target_bonus_reviews(id) ON DELETE RESTRICT,
      worker_id INTEGER NOT NULL REFERENCES factory_workers(id) ON DELETE RESTRICT,
      production_date DATE NOT NULL,
      bonus_amount NUMERIC(18,2) NOT NULL CHECK (bonus_amount > 0),
      currency_code VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency_code = 'USD'),
      payment_date DATE NOT NULL,
      cash_ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      expense_ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      payment_voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
      status VARCHAR(12) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
      posted_by VARCHAR(255) NOT NULL,
      posted_at TIMESTAMP NOT NULL DEFAULT NOW(),
      reversal_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE RESTRICT,
      reversed_by VARCHAR(255),
      reversed_at TIMESTAMP,
      reversal_reason TEXT,
      CONSTRAINT factory_target_bonus_payments_review_unique UNIQUE(company_id, review_id),
      CONSTRAINT factory_target_bonus_payments_voucher_unique UNIQUE(payment_voucher_id),
      CONSTRAINT factory_target_bonus_payments_reversal_consistency CHECK (
        (status = 'POSTED' AND reversal_voucher_id IS NULL AND reversed_at IS NULL)
        OR (status = 'REVERSED' AND reversal_voucher_id IS NOT NULL AND reversed_at IS NOT NULL)
      )
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_target_bonus_payments_worker_day
      ON factory_target_bonus_payments(company_id, worker_id, production_date)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_target_bonus_payments_date
      ON factory_target_bonus_payments(company_id, payment_date DESC)
  `);
}
