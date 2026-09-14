/**
 * Always-running startup schema repairs.
 *
 * Contains critical idempotent schema catch-up that must run even when the bulk
 * startup migration pass is disabled in production.
 */
import type { Pool } from "pg";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";

export async function ensureRuntimeSchema(pool: Pool): Promise<void> {
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS exchange_rates_company_date_pair_unique
       ON exchange_rates (company_id, effective_date, from_currency, to_currency)`
    );
  } catch (idxErr: unknown) {
    logger.warn("[startup] Could not ensure exchange_rates unique index:", { error: getErrorMessage(idxErr) });
  }

  try {
    await pool.query(`
    ALTER TABLE vouchers
      ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';

    ALTER TABLE user_preferences
      ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(10);

    ALTER TABLE voucher_entries
      ADD COLUMN IF NOT EXISTS transaction_currency        VARCHAR(3),
      ADD COLUMN IF NOT EXISTS transaction_debit_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS transaction_credit_amount   NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS base_debit_amount           NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS base_credit_amount          NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS historical_exchange_rate    NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS rate_convention             VARCHAR(30);

    ALTER TABLE ledger_accounts
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS category                         TEXT;

    ALTER TABLE bank_accounts
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6);

    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6);

    ALTER TABLE suppliers
      ADD COLUMN IF NOT EXISTS opening_balance_side             VARCHAR(2) DEFAULT 'Cr',
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6);

    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS opening_balance_side             VARCHAR(2) DEFAULT 'Cr',
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6);

    ALTER TABLE fixed_assets
      ADD COLUMN IF NOT EXISTS purchase_native_amount           NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS purchase_currency                VARCHAR(10),
      ADD COLUMN IF NOT EXISTS purchase_historical_rate         NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS purchase_base_amount             NUMERIC(20,6);

    ALTER TABLE salary_advances
      ADD COLUMN IF NOT EXISTS remaining_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS fully_paid        BOOLEAN       NOT NULL DEFAULT false;

    ALTER TABLE suppliers
      ADD COLUMN IF NOT EXISTS stock_group_id INTEGER;

    ALTER TABLE user_preferences
      ADD COLUMN IF NOT EXISTS show_chat_widget BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS show_notes_panel BOOLEAN NOT NULL DEFAULT true;

    ALTER TABLE factory_containers
      ADD COLUMN IF NOT EXISTS otw_note TEXT,
      ADD COLUMN IF NOT EXISTS otw_docs_received BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE factory_containers
      ADD COLUMN IF NOT EXISTS json_cargo_last_checked_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS json_cargo_tracking_status  TEXT,
      ADD COLUMN IF NOT EXISTS json_cargo_error            TEXT;

    CREATE TABLE IF NOT EXISTS fiscal_period_closures (
      id                          SERIAL PRIMARY KEY,
      company_id                  INTEGER      NOT NULL,
      period_start_date           DATE         NOT NULL,
      period_end_date             DATE         NOT NULL,
      closure_date                TIMESTAMP    NOT NULL DEFAULT NOW(),
      closed_by_user_id           VARCHAR      NOT NULL,
      closing_voucher_id          INTEGER      NOT NULL,
      retained_earnings_account_id INTEGER     NOT NULL,
      total_income                DECIMAL(15,2) NOT NULL,
      total_expense               DECIMAL(15,2) NOT NULL,
      net_income                  DECIMAL(15,2) NOT NULL,
      status                      TEXT         NOT NULL DEFAULT 'CLOSED',
      notes                       TEXT,
      created_at                  TIMESTAMP    NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fiscal_closures_company_period_unique
      ON fiscal_period_closures (company_id, period_end_date);

    CREATE TABLE IF NOT EXISTS factory_status_builder_log (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER NOT NULL,
      sheet_id     INTEGER NOT NULL,
      sheet_name   TEXT NOT NULL,
      row_label    TEXT NOT NULL DEFAULT '',
      column_label TEXT NOT NULL DEFAULT '',
      old_value    TEXT,
      new_value    TEXT,
      changed_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sb_log_company_created
      ON factory_status_builder_log (company_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sb_log_sheet
      ON factory_status_builder_log (sheet_id);

    ALTER TABLE ledger_accounts
      ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE ledger_accounts
      ADD COLUMN IF NOT EXISTS sub_type  TEXT,
      ADD COLUMN IF NOT EXISTS parent_id INTEGER;
  `);
    logger.info("[startup] ✓ Multi-currency schema columns ensured");
  } catch (colErr: unknown) {
    logger.error("[startup] ✗ Could not ensure multi-currency columns:", { error: getErrorMessage(colErr) });
  }

  // Phase 3 historical repairs are part of the blocking pre-listen path. Both
  // passes are idempotent and evidence-gated; ambiguous accounting causes a
  // throw so Render keeps the previous healthy instance live.
  const { runPhase3HistoricalRepair } = await import("../services/accounting/phase3HistoricalRepair");
  await runPhase3HistoricalRepair();
  const { runPhase3PayrollDaybookRepair } = await import("../services/accounting/phase3PayrollDaybookRepair");
  await runPhase3PayrollDaybookRepair();

  // Stock valuation uses an immutable cutover snapshot plus append-only canonical
  // movements. Capture the baseline only after accounting/daybook repair, while
  // startup is still blocking traffic to the new instance.
  const { ensurePhase3InventoryValuationSchema } = await import(
    "../services/accounting/ensurePhase3InventoryValuationSchema"
  );
  const baselinesCreated = await ensurePhase3InventoryValuationSchema(pool);
  logger.info("[startup] ✓ Phase 3 inventory valuation cutovers ensured", { baselinesCreated });
}
