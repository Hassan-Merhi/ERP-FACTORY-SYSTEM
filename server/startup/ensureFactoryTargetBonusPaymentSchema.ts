/**
 * Phase 5/6 direct payment ledger. Each immutable Phase 4 review can be paid
 * exactly once; a reversal keeps the claim so retries cannot double-pay.
 * Registered after the production-review schema on every application boot.
 */
import type { Pool } from "pg";

export async function ensureFactoryTargetBonusPaymentSchema(pool: Pick<Pool, "query">): Promise<void> {
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
      status VARCHAR(12) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
      posted_by VARCHAR(255) NOT NULL,
      posted_at TIMESTAMP NOT NULL DEFAULT now(),
      reversal_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE RESTRICT,
      reversed_by VARCHAR(255),
      reversed_at TIMESTAMP,
      reversal_reason TEXT,
      CONSTRAINT factory_target_bonus_payments_review_unique UNIQUE (company_id, review_id),
      CONSTRAINT factory_target_bonus_payments_voucher_unique UNIQUE (payment_voucher_id),
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
  // Persist method and category breakdown without creating a second cash claim.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_target_bonus_checkout_details (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      review_id INTEGER NOT NULL REFERENCES factory_target_bonus_reviews(id) ON DELETE RESTRICT,
      method VARCHAR(12) NOT NULL CHECK (method IN ('standard','category')),
      breakdown JSONB NOT NULL CHECK (jsonb_typeof(breakdown)='array'),
      calculation_hash CHAR(64) NOT NULL CHECK (calculation_hash ~ '^[a-f0-9]{64}$'),
      created_by VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT factory_target_bonus_checkout_review_unique UNIQUE (company_id,review_id)
    )
  `);
  // When an approved daily bonus is repriced BEFORE payment, retain both the
  // original approval and new agreed amount. Paid/reversed rows never change.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_target_bonus_unpaid_rate_revisions (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      review_id INTEGER NOT NULL REFERENCES factory_target_bonus_reviews(id) ON DELETE RESTRICT,
      worker_id INTEGER NOT NULL REFERENCES factory_workers(id) ON DELETE RESTRICT,
      production_date DATE NOT NULL,
      method VARCHAR(12) NOT NULL CHECK (method IN ('standard','category')),
      old_amount NUMERIC(18,2) NOT NULL,
      new_amount NUMERIC(18,2) NOT NULL,
      old_rate NUMERIC(16,4) NOT NULL,
      new_rate NUMERIC(16,4) NOT NULL,
      old_breakdown JSONB,
      new_breakdown JSONB NOT NULL,
      repriced_by VARCHAR(255) NOT NULL,
      repriced_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_bonus_unpaid_rate_revisions_history
    ON factory_target_bonus_unpaid_rate_revisions (company_id,review_id,repriced_at DESC)
  `);
  // Phase 15: distinct one-time claim for an immutable worker/week review.
  // Reversed payments retain the claim and cannot be automatically repaid.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_target_bonus_weekly_payments (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      review_id BIGINT NOT NULL REFERENCES factory_target_bonus_weekly_reviews(id) ON DELETE RESTRICT,
      worker_id INTEGER NOT NULL REFERENCES factory_workers(id) ON DELETE RESTRICT,
      week_start DATE NOT NULL,
      week_end DATE NOT NULL,
      bonus_amount NUMERIC(18,2) NOT NULL CHECK (bonus_amount > 0),
      currency_code VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency_code = 'USD'),
      payment_date DATE NOT NULL,
      cash_ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      expense_ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      payment_voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
      status VARCHAR(12) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
      posted_by VARCHAR(255) NOT NULL,
      posted_at TIMESTAMP NOT NULL DEFAULT now(),
      reversal_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE RESTRICT,
      reversed_by VARCHAR(255),
      reversed_at TIMESTAMP,
      reversal_reason TEXT,
      CONSTRAINT factory_bonus_weekly_payment_review_unique UNIQUE (company_id, review_id),
      CONSTRAINT factory_bonus_weekly_payment_worker_week_unique UNIQUE (company_id, week_start, worker_id),
      CONSTRAINT factory_bonus_weekly_payment_voucher_unique UNIQUE (payment_voucher_id),
      CONSTRAINT factory_bonus_weekly_payment_end CHECK (week_end = week_start + 6),
      CONSTRAINT factory_bonus_weekly_payment_reversal CHECK (
        (status = 'POSTED' AND reversal_voucher_id IS NULL AND reversed_at IS NULL)
        OR (status = 'REVERSED' AND reversal_voucher_id IS NOT NULL AND reversed_at IS NOT NULL)
      )
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_bonus_weekly_payments_date_idx
    ON factory_target_bonus_weekly_payments (company_id, payment_date DESC, worker_id)
  `);
}
