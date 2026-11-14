/**
 * Always-running startup schema repairs.
 *
 * Contains critical idempotent schema catch-up that must run even when the bulk
 * startup migration pass is disabled in production.
 */
import type { Pool } from "pg";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import {
  ensurePropertyUnitsWriteSchema,
  ensureRentalContractCreateColumns,
  ensureScheduledWhatsAppDeliveryTrackingSchema,
} from "./runtimeSchema/auxiliarySchema";
import {
  ensureRetailBarcodeLabelSchema,
  ensureRetailFinancialSchema,
  ensureRetailSellingSchema,
  ensureRetailStockCountSchema,
  ensureRetailVariantSchema,
} from "./runtimeSchema/retailSchema";

export {
  ensurePropertyUnitsWriteSchema,
  ensureRentalContractCreateColumns,
  ensureScheduledWhatsAppDeliveryTrackingSchema,
} from "./runtimeSchema/auxiliarySchema";
export {
  ensureRetailBarcodeLabelSchema,
  ensureRetailFinancialSchema,
  ensureRetailSellingSchema,
  ensureRetailStockCountSchema,
  ensureRetailVariantSchema,
} from "./runtimeSchema/retailSchema";

export async function ensureRuntimeSchema(pool: Pool): Promise<void> {
  await ensurePropertyUnitsWriteSchema(pool);
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

    -- Phase 21 (A), AT3: actor columns and the original number of a retired
    -- voucher, kept by the audit trail trigger (services/audit/voucherAuditTrigger.ts,
    -- which adds them as well, fatally). NULL = written before tracking.
    ALTER TABLE vouchers
      ADD COLUMN IF NOT EXISTS created_by TEXT,
      ADD COLUMN IF NOT EXISTS updated_by TEXT,
      ADD COLUMN IF NOT EXISTS deleted_by TEXT,
      ADD COLUMN IF NOT EXISTS original_voucher_number VARCHAR(100);

    -- Phase 22 (A), PE8/G9/PE9 (migrations/20261010_002): gapless voucher
    -- number counters and the reversal link (services/accounting/voucherNumbering.ts,
    -- voucherCorrection.ts).
    CREATE TABLE IF NOT EXISTS voucher_number_sequences (
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      prefix VARCHAR(20) NOT NULL,
      year INTEGER NOT NULL,
      last_value BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT voucher_number_sequences_company_id_prefix_year_pk PRIMARY KEY (company_id, prefix, year)
    );
    ALTER TABLE vouchers
      ADD COLUMN IF NOT EXISTS reversal_of_voucher_id INTEGER REFERENCES vouchers(id),
      ADD COLUMN IF NOT EXISTS posted_by_engine BOOLEAN NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS vouchers_reversal_of_live_unique
      ON vouchers (reversal_of_voucher_id)
      WHERE reversal_of_voucher_id IS NOT NULL AND deleted_at IS NULL;

    -- Phase 21 (A), AT5/AT6: request metadata and the hash chain on audit rows.
    ALTER TABLE audit_log
      ADD COLUMN IF NOT EXISTS request_id TEXT,
      ADD COLUMN IF NOT EXISTS ip TEXT,
      ADD COLUMN IF NOT EXISTS session_id TEXT,
      ADD COLUMN IF NOT EXISTS reason TEXT,
      ADD COLUMN IF NOT EXISTS prev_hash TEXT,
      ADD COLUMN IF NOT EXISTS row_hash TEXT;

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

    -- Phase 19 (B), PE7: fixed assets are soft-deleted.
    ALTER TABLE fixed_assets
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

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

    -- All Daybook hidden rows are a per-user preference. Production commonly
    -- runs with RUN_STARTUP_MIGRATIONS=false, so this column must live in the
    -- unconditional runtime-schema guard as well as the bulk migration list.
    ALTER TABLE user_preferences
      ADD COLUMN IF NOT EXISTS show_chat_widget BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS show_notes_panel BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS hidden_transaction_journal_voucher_ids INTEGER[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS factory_mhd_view_default BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE factory_containers
      ADD COLUMN IF NOT EXISTS otw_note TEXT,
      ADD COLUMN IF NOT EXISTS otw_docs_received BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE factory_containers
      ADD COLUMN IF NOT EXISTS json_cargo_last_checked_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS json_cargo_tracking_status  TEXT,
      ADD COLUMN IF NOT EXISTS json_cargo_error            TEXT;

    -- Customer-order workflow fields are read through full Drizzle row selects
    -- in loading/scanning routes. Production can disable the bulk migration
    -- pass, so keep this critical additive column in the always-on guard.
    ALTER TABLE customer_orders
      ADD COLUMN IF NOT EXISTS previous_status TEXT;

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
    -- Legacy production databases may already have fiscal_period_closures
    -- from the older schema. CREATE TABLE IF NOT EXISTS does not add new
    -- columns to an existing table, and the closed-period trigger reads
    -- status on every voucher write. Keep the guard column in the always-on
    -- runtime repair so voucher posting cannot be broken by schema drift.
    ALTER TABLE fiscal_period_closures
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'CLOSED',
      ADD COLUMN IF NOT EXISTS opening_balance_snapshot JSONB;

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

  // Rental contract writes also need these columns when bulk migrations are off.
  await ensureRentalContractCreateColumns(pool);

  try {
    await ensureRetailVariantSchema(pool);
  } catch (retailErr: unknown) {
    logger.error("[startup] ✗ Could not ensure retail variant columns:", { error: getErrorMessage(retailErr) });
  }

  try {
    await ensureRetailBarcodeLabelSchema(pool);
  } catch (retailErr: unknown) {
    logger.error("[startup] ✗ Could not ensure retail barcode and label schema:", {
      error: getErrorMessage(retailErr),
    });
  }

  try {
    await ensureRetailFinancialSchema(pool);
  } catch (retailErr: unknown) {
    logger.error("[startup] ✗ Could not ensure retail financial core schema:", {
      error: getErrorMessage(retailErr),
    });
  }

  try {
    await ensureRetailSellingSchema(pool);
  } catch (retailErr: unknown) {
    logger.error("[startup] ✗ Could not ensure retail selling (customer, pricing, tax) schema:", {
      error: getErrorMessage(retailErr),
    });
  }

  try {
    await ensureRetailStockCountSchema(pool);
  } catch (retailErr: unknown) {
    logger.error("[startup] ✗ Could not ensure retail stock-count schema:", {
      error: getErrorMessage(retailErr),
    });
  }

  // Display-only grouping is a presentation feature: the table is separate
  // from the financial ledger and must exist even when bulk migrations are off.
  // Every statement is idempotent and creates no vouchers or journal entries.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_display_layout (
      company_id INTEGER NOT NULL,
      node_key VARCHAR(100) NOT NULL,
      node_type VARCHAR(12) NOT NULL CHECK (node_type IN ('group', 'ledger')),
      name TEXT,
      parent_key VARCHAR(100),
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, node_key),
      CONSTRAINT account_display_layout_shape CHECK (
        (node_type = 'group' AND parent_key IS NULL AND length(trim(coalesce(name, ''))) > 0)
        OR (node_type = 'ledger' AND name IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS account_display_layout_company_parent_sort_idx
      ON account_display_layout(company_id, parent_key, sort_order);
  `);

  // Factory proforma destinations and destination-scoped prices are mandatory
  // in production as well, where the bulk startup migration pass may be disabled.
  const { ensureProformaDestinationPricingSchema } =
    await import("../services/factory/ensureProformaDestinationPricingSchema");
  await ensureProformaDestinationPricingSchema(pool);

  // Scheduled WhatsApp claims are a correctness boundary: production disables
  // the bulk startup migration pass, so these tables must be guaranteed by the
  // always-on pre-listen schema guard.
  await ensureScheduledWhatsAppDeliveryTrackingSchema(pool);

  // Unified accounting Phase 3 — additive reconciliation metadata only.
  // No GL entries or source-party balances are changed during initialization.
  const { ensurePartyOpenItemSchema } = await import("../services/accounting/ensurePartyOpenItemSchema");
  await ensurePartyOpenItemSchema(pool);

  // Unified Phase 4: cash/bank bank-statement reconciliation metadata only.
  const { ensureCashBankReconciliationSchema } =
    await import("../services/accounting/ensureCashBankReconciliationSchema");
  await ensureCashBankReconciliationSchema(pool);

  // Phase 5: opt-in realized FX journal evidence only; no historical backfill.
  const { ensureMonetaryFxSchema } = await import("../services/accounting/ensureMonetaryFxSchema");
  await ensureMonetaryFxSchema(pool);

  // Unified Accounting Phase 8: expense-attribution metadata only; never a GL posting.
  const { ensureRentalAccountingLinksSchema } = await import("../services/rental/ensureRentalAccountingLinksSchema");
  await ensureRentalAccountingLinksSchema(pool);

  // Phase 13: financial review signoffs and reviewed-close audit evidence only.
  // No fiscal period is automatically closed, reopened or journal-posted.
  const { ensureFiscalReviewSchema } = await import("../services/accounting/ensureFiscalReviewSchema");
  await ensureFiscalReviewSchema(pool);

  // Phase 15 rollout metadata is created before accounting routes serve
  // users. Fail-closed write middleware never assumes this schema exists.
  const { ensureUnifiedAccountingRolloutSchema } =
    await import("../services/accounting/ensureUnifiedAccountingRolloutSchema");
  await ensureUnifiedAccountingRolloutSchema(pool);

  // Wave 16 (A): the Phase 3 historical accounting repair no longer runs here.
  // It added and deleted lines of posted vouchers of every company before each
  // listen, with no audit; it is now the Owner preview/apply at
  // /api/accounting/phase3-historical/plan and /apply. The payroll daybook pass below
  // rewrites the factory daybook mirror only (no voucher, line or account).
  const { runPhase3PayrollDaybookRepair } = await import("../services/accounting/phase3PayrollDaybookRepair");
  await runPhase3PayrollDaybookRepair();

  // Stock valuation uses an immutable cutover snapshot plus append-only canonical
  // movements. Capture the baseline only after accounting/daybook repair, while
  // startup is still blocking traffic to the new instance.
  const { ensurePhase3InventoryValuationSchema } =
    await import("../services/accounting/ensurePhase3InventoryValuationSchema");
  const baselinesCreated = await ensurePhase3InventoryValuationSchema(pool);
  logger.info("[startup] ✓ Phase 3 inventory valuation cutovers ensured", { baselinesCreated });

  // Disabled by default. This one-shot control exists so an explicitly reviewed
  // historical-sales repair can be dry-run/applied on Render without exposing
  // database credentials or turning the repair into normal startup behavior.
  const { maybeRunHistoricalSalesCostRepairFromEnv } =
    await import("../services/inventory/historicalSalesCostRepairStartup");
  await maybeRunHistoricalSalesCostRepairFromEnv();
}
