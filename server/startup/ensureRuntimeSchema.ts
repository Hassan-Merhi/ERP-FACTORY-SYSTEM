/**
 * Always-running startup schema repairs.
 *
 * Contains critical idempotent schema catch-up that must run even when the bulk
 * startup migration pass is disabled in production.
 */
import type { Pool } from "pg";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { scheduledWhatsAppDeliveryTracking } from "../startup-schema/030-scheduled-whatsapp-delivery-tracking";
import { ensureRetailLedgerSchema } from "../services/retail/retailLedgerSchema";

export async function ensureScheduledWhatsAppDeliveryTrackingSchema(pool: Pool): Promise<void> {
  for (const statement of scheduledWhatsAppDeliveryTracking) {
    await pool.query(statement);
  }

  const verification = await pool.query<{
    occurrences_table: string | null;
    attachments_table: string | null;
  }>(
    `SELECT
       to_regclass('public.scheduled_whatsapp_occurrences')::text AS occurrences_table,
       to_regclass('public.scheduled_whatsapp_attachments')::text AS attachments_table`
  );

  const row = verification.rows[0];
  if (!row?.occurrences_table || !row?.attachments_table) {
    throw new Error("SCHEDULED_WHATSAPP_DELIVERY_TRACKING_SCHEMA_UNAVAILABLE");
  }

  logger.info("[startup] ✓ Scheduled WhatsApp delivery tracking schema ensured");
}

/**
 * Retail fashion variants (migrations/20261003_001_retail_fashion_variants.sql).
 * No wired runner executes that file and production disables the bulk startup
 * pass, so the always-on guard applies it. Every statement is idempotent, and
 * the new unique index is looser than the one it replaces, so existing rows
 * cannot violate it.
 */
export async function ensureRetailVariantSchema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE retail_product_variants
      ADD COLUMN IF NOT EXISTS color VARCHAR(100) NOT NULL DEFAULT 'Default',
      ADD COLUMN IF NOT EXISTS image_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
    DROP INDEX IF EXISTS retail_product_variants_product_size_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS retail_product_variants_product_color_size_unique
      ON retail_product_variants (product_id, color, size);
  `);
  logger.info("[startup] ✓ Retail variant color and image columns ensured");
}

/**
 * Retail fashion barcodes and labels (migrations/20261004_001_retail_fashion_barcodes_labels.sql),
 * applied by the always-on guard for the same reason as ensureRetailVariantSchema.
 * Every statement is idempotent and only adds a defaulted column, new tables and indexes.
 */
export async function ensureRetailBarcodeLabelSchema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE retail_product_variants
      ADD COLUMN IF NOT EXISTS barcode_source VARCHAR(20) NOT NULL DEFAULT 'manual';
    CREATE TABLE IF NOT EXISTS retail_barcode_sequences (
      company_id INTEGER PRIMARY KEY NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      next_value BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS retail_label_print_events (
      id SERIAL PRIMARY KEY NOT NULL,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      variant_id INTEGER NOT NULL REFERENCES retail_product_variants(id) ON DELETE RESTRICT,
      barcode VARCHAR(191) NOT NULL,
      copies INTEGER NOT NULL DEFAULT 1,
      layout VARCHAR(40) NOT NULL,
      is_reprint BOOLEAN NOT NULL DEFAULT false,
      created_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS retail_label_print_events_company_idx ON retail_label_print_events (company_id);
    CREATE INDEX IF NOT EXISTS retail_label_print_events_variant_idx ON retail_label_print_events (variant_id);
    CREATE INDEX IF NOT EXISTS retail_stock_movements_variant_created_idx
      ON retail_stock_movements (variant_id, created_at);
  `);
  logger.info("[startup] ✓ Retail barcode and label schema ensured");
}

/**
 * Retail Wave 1 financial core. Production can disable the bulk migration pass,
 * so the always-on guard creates the additive payment/accounting tables too.
 */
export async function ensureRetailFinancialSchema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE retail_pos_sales
      ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES pos_shifts(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS accounting_voucher_id INTEGER;
    ALTER TABLE retail_pos_return_items
      ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(20,6) NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS retail_pos_sales_shift_idx ON retail_pos_sales (shift_id);

    CREATE TABLE IF NOT EXISTS retail_pos_payments (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      sale_id INTEGER NOT NULL REFERENCES retail_pos_sales(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      shift_id INTEGER REFERENCES pos_shifts(id) ON DELETE SET NULL,
      payment_type VARCHAR(20) NOT NULL DEFAULT 'payment',
      method VARCHAR(20) NOT NULL,
      amount NUMERIC(20,6) NOT NULL,
      tendered_amount NUMERIC(20,6),
      change_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
      reference VARCHAR(191),
      ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE RESTRICT,
      related_payment_id INTEGER,
      idempotency_key VARCHAR(191) NOT NULL,
      created_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS retail_pos_payments_company_idx ON retail_pos_payments(company_id);
    CREATE INDEX IF NOT EXISTS retail_pos_payments_sale_idx ON retail_pos_payments(sale_id);
    CREATE INDEX IF NOT EXISTS retail_pos_payments_shift_idx ON retail_pos_payments(shift_id);
    CREATE UNIQUE INDEX IF NOT EXISTS retail_pos_payments_company_idempotency_unique
      ON retail_pos_payments(company_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS retail_cash_movements (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      shift_id INTEGER NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,
      movement_type VARCHAR(20) NOT NULL,
      amount NUMERIC(20,6) NOT NULL,
      reason TEXT NOT NULL,
      idempotency_key VARCHAR(191) NOT NULL,
      created_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS retail_cash_movements_shift_idx ON retail_cash_movements(shift_id);
    CREATE UNIQUE INDEX IF NOT EXISTS retail_cash_movements_company_idempotency_unique
      ON retail_cash_movements(company_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS retail_accounting_settings (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
      cash_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      card_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      bank_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE RESTRICT,
      mobile_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      other_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      sales_revenue_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      inventory_asset_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      cogs_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      discounts_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      tax_payable_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      store_credit_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS retail_accounting_settings_company_idx ON retail_accounting_settings(company_id);
    CREATE UNIQUE INDEX IF NOT EXISTS retail_accounting_settings_company_location_unique
      ON retail_accounting_settings(company_id, location_id) WHERE location_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS retail_accounting_settings_company_default_unique
      ON retail_accounting_settings(company_id) WHERE location_id IS NULL;
  `);
  logger.info("[startup] ✓ Retail financial core schema ensured");
  // Wave 17 (D): Retail cash movement journals and the Retail inventory opening.
  await ensureRetailLedgerSchema(pool);
}

/**
 * Retail Wave 2 selling schema (migrations/20261005_001_retail_selling_customers_pricing_tax.sql),
 * applied by the always-on guard for the same reason as ensureRetailVariantSchema.
 * Every statement is idempotent, only adds defaulted columns/tables/indexes, and the
 * backfills skip rows that already carry a snapshot.
 */
export async function ensureRetailSellingSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS retail_pos_settings (
      id SERIAL PRIMARY KEY NOT NULL,
      company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
      discount_limit_percent NUMERIC(6,2) NOT NULL DEFAULT 10,
      require_manager_approval BOOLEAN NOT NULL DEFAULT true,
      price_override_requires_approval BOOLEAN NOT NULL DEFAULT true,
      tax_enabled BOOLEAN NOT NULL DEFAULT false,
      tax_label VARCHAR(40) NOT NULL DEFAULT 'Tax',
      tax_rate NUMERIC(8,5) NOT NULL DEFAULT 0,
      tax_inclusive BOOLEAN NOT NULL DEFAULT false,
      updated_by VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS retail_pos_settings_company_idx ON retail_pos_settings (company_id);

    CREATE TABLE IF NOT EXISTS retail_promotions (
      id SERIAL PRIMARY KEY NOT NULL,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      scope VARCHAR(20) NOT NULL DEFAULT 'all',
      brand_id INTEGER REFERENCES retail_brands(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES retail_products(id) ON DELETE CASCADE,
      variant_id INTEGER REFERENCES retail_product_variants(id) ON DELETE CASCADE,
      discount_type VARCHAR(20) NOT NULL,
      value NUMERIC(20,6) NOT NULL,
      starts_at TIMESTAMP,
      ends_at TIMESTAMP,
      active BOOLEAN NOT NULL DEFAULT true,
      priority INTEGER NOT NULL DEFAULT 0,
      created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS retail_promotions_company_idx ON retail_promotions (company_id);
    CREATE INDEX IF NOT EXISTS retail_promotions_company_active_idx ON retail_promotions (company_id, active);
    CREATE INDEX IF NOT EXISTS retail_promotions_company_window_idx ON retail_promotions (company_id, starts_at, ends_at);

    CREATE TABLE IF NOT EXISTS retail_discount_approvals (
      id SERIAL PRIMARY KEY NOT NULL,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      token_id VARCHAR(64) NOT NULL,
      manager_user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      manager_name TEXT NOT NULL,
      cashier_user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      reason TEXT,
      requested_discount_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
      allows_price_override BOOLEAN NOT NULL DEFAULT false,
      expires_at TIMESTAMP NOT NULL,
      consumed_sale_id INTEGER,
      consumed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS retail_discount_approvals_company_token_unique
      ON retail_discount_approvals (company_id, token_id);
    CREATE INDEX IF NOT EXISTS retail_discount_approvals_company_idx ON retail_discount_approvals (company_id);
    CREATE INDEX IF NOT EXISTS retail_discount_approvals_manager_idx ON retail_discount_approvals (manager_user_id);

    ALTER TABLE retail_pos_sales
      ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS customer_name VARCHAR(191) NOT NULL DEFAULT 'Walk-in',
      ADD COLUMN IF NOT EXISTS list_subtotal NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS discount_total NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS subtotal NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS order_discount_type VARCHAR(20) NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS order_discount_value NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS order_discount_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS order_discount_reason TEXT,
      ADD COLUMN IF NOT EXISTS tax_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS tax_label VARCHAR(40) NOT NULL DEFAULT 'Tax',
      ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(8,5) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS approval_id INTEGER REFERENCES retail_discount_approvals(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS approved_by_user_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS approved_by_name TEXT;

    UPDATE retail_pos_sales
       SET list_subtotal = total_amount, subtotal = total_amount
     WHERE list_subtotal = 0 AND subtotal = 0 AND total_amount <> 0;

    ALTER TABLE retail_pos_sale_items
      ADD COLUMN IF NOT EXISTS original_unit_price NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS gross_unit_price NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS line_discount_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS line_discount_type VARCHAR(20) NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS line_discount_value NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS discount_reason TEXT,
      ADD COLUMN IF NOT EXISTS price_override BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS promotion_id INTEGER REFERENCES retail_promotions(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS line_total NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS approved_by_user_id VARCHAR(255);

    UPDATE retail_pos_sale_items
       SET original_unit_price = unit_price,
           gross_unit_price = unit_price,
           line_total = unit_price * quantity
     WHERE original_unit_price = 0 AND line_total = 0 AND unit_price <> 0;

    ALTER TABLE retail_pos_returns
      ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refund_tax_amount NUMERIC(20,6) NOT NULL DEFAULT 0;

    ALTER TABLE retail_pos_return_items
      ADD COLUMN IF NOT EXISTS gross_unit_price NUMERIC(20,6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(20,6) NOT NULL DEFAULT 0;

    UPDATE retail_pos_return_items
       SET gross_unit_price = unit_price
     WHERE gross_unit_price = 0 AND unit_price <> 0;

    CREATE INDEX IF NOT EXISTS retail_pos_sales_customer_idx ON retail_pos_sales (customer_id);
    CREATE INDEX IF NOT EXISTS retail_pos_sales_company_created_idx ON retail_pos_sales (company_id, created_at);
  `);
  logger.info("[startup] ✓ Retail selling (customer, pricing, tax) schema ensured");
}

/**
 * Retail Wave 2 stock-count schema (migrations/20261005_002_retail_stock_count.sql),
 * applied by the always-on guard for the same reason as ensureRetailVariantSchema.
 */
export async function ensureRetailStockCountSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS retail_stock_count_sessions (
      id SERIAL PRIMARY KEY NOT NULL,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      code VARCHAR(60) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      notes TEXT,
      snapshot_at TIMESTAMP,
      counting_started_at TIMESTAMP,
      review_started_at TIMESTAMP,
      finalized_at TIMESTAMP,
      canceled_at TIMESTAMP,
      created_by VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      finalized_by VARCHAR(255) REFERENCES users(id) ON DELETE RESTRICT,
      canceled_by VARCHAR(255) REFERENCES users(id) ON DELETE RESTRICT,
      line_count INTEGER NOT NULL DEFAULT 0,
      counted_line_count INTEGER NOT NULL DEFAULT 0,
      uncounted_line_count INTEGER NOT NULL DEFAULT 0,
      variance_line_count INTEGER NOT NULL DEFAULT 0,
      unexpected_line_count INTEGER NOT NULL DEFAULT 0,
      recount_line_count INTEGER NOT NULL DEFAULT 0,
      expected_quantity_total NUMERIC(20,6) NOT NULL DEFAULT 0,
      counted_quantity_total NUMERIC(20,6) NOT NULL DEFAULT 0,
      variance_quantity_total NUMERIC(20,6) NOT NULL DEFAULT 0,
      variance_value_total NUMERIC(20,6) NOT NULL DEFAULT 0,
      finalized_result JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS retail_stock_count_sessions_company_code_unique
      ON retail_stock_count_sessions (company_id, code);
    CREATE INDEX IF NOT EXISTS retail_stock_count_sessions_company_idx ON retail_stock_count_sessions (company_id);
    CREATE INDEX IF NOT EXISTS retail_stock_count_sessions_company_status_idx
      ON retail_stock_count_sessions (company_id, status);
    CREATE INDEX IF NOT EXISTS retail_stock_count_sessions_location_idx ON retail_stock_count_sessions (location_id);

    CREATE TABLE IF NOT EXISTS retail_stock_count_lines (
      id SERIAL PRIMARY KEY NOT NULL,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL REFERENCES retail_stock_count_sessions(id) ON DELETE CASCADE,
      variant_id INTEGER NOT NULL REFERENCES retail_product_variants(id) ON DELETE RESTRICT,
      expected_quantity NUMERIC(20,6) NOT NULL DEFAULT 0,
      counted_quantity NUMERIC(20,6),
      status VARCHAR(20) NOT NULL DEFAULT 'uncounted',
      recount_required BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      expected_live_quantity NUMERIC(20,6),
      variance_quantity NUMERIC(20,6),
      movement_delta NUMERIC(20,6),
      counted_by VARCHAR(255) REFERENCES users(id) ON DELETE RESTRICT,
      counted_at TIMESTAMP,
      last_scanned_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS retail_stock_count_lines_session_variant_unique
      ON retail_stock_count_lines (session_id, variant_id);
    CREATE INDEX IF NOT EXISTS retail_stock_count_lines_company_idx ON retail_stock_count_lines (company_id);
    CREATE INDEX IF NOT EXISTS retail_stock_count_lines_session_idx ON retail_stock_count_lines (session_id);
    CREATE INDEX IF NOT EXISTS retail_stock_count_lines_status_idx ON retail_stock_count_lines (status);

    CREATE TABLE IF NOT EXISTS retail_stock_count_events (
      id SERIAL PRIMARY KEY NOT NULL,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL REFERENCES retail_stock_count_sessions(id) ON DELETE CASCADE,
      line_id INTEGER REFERENCES retail_stock_count_lines(id) ON DELETE SET NULL,
      variant_id INTEGER REFERENCES retail_product_variants(id) ON DELETE SET NULL,
      event_type VARCHAR(40) NOT NULL,
      previous_quantity NUMERIC(20,6),
      quantity NUMERIC(20,6),
      delta NUMERIC(20,6),
      note TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS retail_stock_count_events_company_idx ON retail_stock_count_events (company_id);
    CREATE INDEX IF NOT EXISTS retail_stock_count_events_session_idx ON retail_stock_count_events (session_id);
    CREATE INDEX IF NOT EXISTS retail_stock_count_events_created_at_idx ON retail_stock_count_events (created_at);
  `);
  logger.info("[startup] ✓ Retail stock-count schema ensured");
}

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

    -- All Daybook hidden rows are a per-user preference. Production commonly
    -- runs with RUN_STARTUP_MIGRATIONS=false, so this column must live in the
    -- unconditional runtime-schema guard as well as the bulk migration list.
    ALTER TABLE user_preferences
      ADD COLUMN IF NOT EXISTS show_chat_widget BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS show_notes_panel BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS hidden_transaction_journal_voucher_ids INTEGER[] NOT NULL DEFAULT '{}';

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

  // Scheduled WhatsApp claims are a correctness boundary: production disables
  // the bulk startup migration pass, so these tables must be guaranteed by the
  // always-on pre-listen schema guard.
  await ensureScheduledWhatsAppDeliveryTrackingSchema(pool);

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
