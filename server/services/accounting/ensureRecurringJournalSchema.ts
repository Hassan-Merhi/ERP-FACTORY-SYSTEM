import type { DatabasePool } from "../../db";
import { logger } from "../../lib/logger";

const RECURRING_JOURNAL_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS recurring_journals (
    id serial PRIMARY KEY,
    company_id integer NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    source_voucher_id integer NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
    name text NOT NULL,
    description_template text,
    frequency varchar(20) NOT NULL DEFAULT 'monthly',
    schedule_rule varchar(30) NOT NULL DEFAULT 'month_end',
    timezone text NOT NULL DEFAULT 'UTC',
    currency varchar(3) NOT NULL DEFAULT 'USD',
    exchange_rate numeric(20,10),
    entry_template jsonb NOT NULL,
    active boolean NOT NULL DEFAULT true,
    start_date date NOT NULL,
    end_date date,
    next_run_date date NOT NULL,
    last_run_date date,
    last_generated_voucher_id integer REFERENCES vouchers(id) ON DELETE SET NULL,
    last_attempt_at timestamptz,
    last_error text,
    created_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS recurring_journals_company_source_unique
     ON recurring_journals(company_id, source_voucher_id)`,
  `CREATE INDEX IF NOT EXISTS recurring_journals_due_idx
     ON recurring_journals(active, next_run_date)`,
  `CREATE INDEX IF NOT EXISTS recurring_journals_company_idx
     ON recurring_journals(company_id)`,
] as const;

/**
 * Production may run with RUN_STARTUP_MIGRATIONS=false, so this small additive
 * schema is ensured unconditionally during database warmup. The Drizzle schema
 * defines the same table for disposable CI databases.
 */
export async function ensureRecurringJournalSchema(pool: DatabasePool): Promise<void> {
  for (const statement of RECURRING_JOURNAL_SCHEMA_SQL) {
    await pool.query(statement);
  }

  logger.info("[startup] ✓ Recurring journal schema ensured", {
    module: "database",
    action: "ensureRecurringJournalSchema",
  });
}
