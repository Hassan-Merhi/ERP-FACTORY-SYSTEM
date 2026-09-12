/**
 * Always-running startup schema repairs.
 *
 * Contains the exchange_rates upsert constraint index and the idempotent
 * multi-currency / fiscal / factory schema column-and-table repairs that run
 * on EVERY startup (even when RUN_STARTUP_MIGRATIONS=false), because
 * production never ran those migrations. Extracted verbatim from
 * server/index.ts; behaviour is unchanged.
 */
import type { Pool } from "pg";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";

export async function ensureRuntimeSchema(pool: Pool): Promise<void> {
  // ── Always-running critical index: exchange_rates upsert constraint ───────
  // This index is required for the exchange_rates upsert to work correctly.
  // It runs unconditionally (even when RUN_STARTUP_MIGRATIONS=false) so that
  // production environments that skipped the bulk migration still get it.
  // CREATE UNIQUE INDEX IF NOT EXISTS is a no-op if the index already exists.
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS exchange_rates_company_date_pair_unique
     ON exchange_rates (company_id, effective_date, from_currency, to_currency)`
    );
  } catch (idxErr: unknown) {
    // Non-fatal: upsertExchangeRate has a fallback that works without the index.
    logger.warn("[startup] Could not ensure exchange_rates unique index:", { error: getErrorMessage(idxErr) });
  }

  // ── Always-running multi-currency schema columns ──────────────────────────
  // These columns were added by migrations 0011, 0012, 20260720_002–006, but
  // production uses RUN_STARTUP_MIGRATIONS=false so those migrations never ran.
  // ALTER TABLE … ADD COLUMN IF NOT EXISTS is idempotent — safe to run every
  // startup.  Without these columns, /api/stats/net-profit returns 500 and the
  // dashboard shows the "Some financial data could not be loaded" error banner.
  try {
    await pool.query(`
    -- vouchers: currency column (migration 0011)
    ALTER TABLE vouchers
      ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';

    -- user_preferences: preferred_currency (migration 0012)
    ALTER TABLE user_preferences
      ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(10);

    -- voucher_entries: multi-currency audit columns (migration 20260720_002)
    ALTER TABLE voucher_entries
      ADD COLUMN IF NOT EXISTS transaction_currency        VARCHAR(3),
      ADD COLUMN IF NOT EXISTS transaction_debit_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS transaction_credit_amount   NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS base_debit_amount           NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS base_credit_amount          NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS historical_exchange_rate    NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS rate_convention             VARCHAR(30);

    -- ledger_accounts: opening balance currency (migrations 20260720_003 + 006)
    -- ledger_accounts: category column for net-profit classification
    ALTER TABLE ledger_accounts
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS category                         TEXT;

    -- bank_accounts: opening balance currency (migrations 20260720_004 + 006)
    ALTER TABLE bank_accounts
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6);

    -- customers: opening balance currency (migration 20260720_006)
    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6);

    -- suppliers: opening balance currency + side (migration 20260720_006)
    ALTER TABLE suppliers
      ADD COLUMN IF NOT EXISTS opening_balance_side             VARCHAR(2) DEFAULT 'Cr',
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6);

    -- employees: opening balance currency + side (migration 20260720_006)
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS opening_balance_side             VARCHAR(2) DEFAULT 'Cr',
      ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6);

    -- fixed_assets: purchase currency (migration 20260720_006)
    ALTER TABLE fixed_assets
      ADD COLUMN IF NOT EXISTS purchase_native_amount           NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS purchase_currency                VARCHAR(10),
      ADD COLUMN IF NOT EXISTS purchase_historical_rate         NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS purchase_base_amount             NUMERIC(20,6);

    -- salary_advances: remaining_balance + fully_paid (added in a later drizzle migration
    -- that never ran on production because RUN_STARTUP_MIGRATIONS=false).
    -- Without these columns /api/stats/net-profit throws "column does not exist" and
    -- the dashboard shows the financial-data error banner.
    ALTER TABLE salary_advances
      ADD COLUMN IF NOT EXISTS remaining_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS fully_paid        BOOLEAN       NOT NULL DEFAULT false;

    -- suppliers: stock_group_id added in Drizzle schema (startupSchema migration index
    -- ~2423) but that migration is disabled on production via RUN_STARTUP_MIGRATIONS=false.
    -- db.select().from(schema.suppliers) generates SQL that includes this column; if it
    -- doesn't exist in production the entire SELECT fails with "column does not exist"
    -- → 500 on GET /api/accounts/voucher-sidebar and anywhere else that lists suppliers.
    -- Added here without the FK constraint so it applies even if stock_groups isn't
    -- yet present; the FK is enforced by the startupSchema migration when it runs.
    ALTER TABLE suppliers
      ADD COLUMN IF NOT EXISTS stock_group_id INTEGER;

    -- user_preferences: per-user widget visibility toggles (added post-multicurrency
    -- Drizzle schema; never reached production because RUN_STARTUP_MIGRATIONS=false).
    -- Missing columns cause 500s on /api/user-preferences reads.
    ALTER TABLE user_preferences
      ADD COLUMN IF NOT EXISTS show_chat_widget BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS show_notes_panel BOOLEAN NOT NULL DEFAULT true;

    -- factory_containers: server-side shared OTW notes + docs-received flag.
    -- Previously stored in localStorage (per-browser); moved to DB so all users share
    -- the same state. Missing columns cause 500s on PATCH /api/factory/containers/:id
    -- when otwNote or otwDocsReceived are included in the request body.
    ALTER TABLE factory_containers
      ADD COLUMN IF NOT EXISTS otw_note TEXT,
      ADD COLUMN IF NOT EXISTS otw_docs_received BOOLEAN NOT NULL DEFAULT false;

    -- factory_containers: JSONCargo tracking columns.
    -- Drizzle enumerates every declared column in INSERT statements. These three
    -- columns were added to the schema but never applied to production (which runs
    -- with RUN_STARTUP_MIGRATIONS=false), so every new factory-container CREATE
    -- failed with a "column does not exist" error. Added here idempotently so
    -- production gets the columns on next startup regardless of migration mode.
    ALTER TABLE factory_containers
      ADD COLUMN IF NOT EXISTS json_cargo_last_checked_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS json_cargo_tracking_status  TEXT,
      ADD COLUMN IF NOT EXISTS json_cargo_error            TEXT;

    -- fiscal_period_closures: the startup migration at index 2673 only adds an FK
    -- constraint but never creates the table itself. Add it here idempotently so the
    -- table exists before the FK migration runs (it is a no-op if already present).
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

    -- factory_status_builder_log: added in a startupSchema migration (July 2026)
    -- that never ran on production because RUN_STARTUP_MIGRATIONS=false.
    -- Missing table causes "[StatusBuilder] history log failed" errors on every
    -- status-builder save and prevents the History tab from loading.
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

    -- ledger_accounts: is_hidden column (added in startup migration ~2419)
    -- Drizzle enumerates every declared column in SELECT statements. If this
    -- column is absent in production (RUN_STARTUP_MIGRATIONS=false), every
    -- getAllLedgerAccounts() call throws "column does not exist" → 500 →
    -- Pay From / Receive Into and all account pickers return empty.
    ALTER TABLE ledger_accounts
      ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;

    -- ledger_accounts: sub_type and parent_id (declared in Drizzle schema)
    ALTER TABLE ledger_accounts
      ADD COLUMN IF NOT EXISTS sub_type  TEXT,
      ADD COLUMN IF NOT EXISTS parent_id INTEGER;
  `);
    logger.info("[startup] ✓ Multi-currency schema columns ensured");
  } catch (colErr: unknown) {
    logger.error("[startup] ✗ Could not ensure multi-currency columns:", { error: getErrorMessage(colErr) });
    // Non-fatal: the app will start but the dashboard net-profit query may still fail
    // if the columns are genuinely absent.
  }
}
