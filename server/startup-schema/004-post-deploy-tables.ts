/**
 * Startup schema migrations - Tables added after the initial deploy that may be absent on production, bale import batch tracking, scheduler singleton seeds, and stock allocation v3 test tables.
 *
 * Part of the ordered `startupMigrations` array assembled in ./index.ts.
 * Statement order is load-bearing: these run sequentially at boot, so entries
 * must never be reordered or moved between parts.
 */

export const postDeployTables: string[] = [
  // ── Tables added post-initial-deploy that may be missing on production ──
  `CREATE TABLE IF NOT EXISTS supplier_proformas (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      supplier_id integer NOT NULL,
      reference varchar(200) NOT NULL,
      notes text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS supplier_proforma_lines (
      id serial PRIMARY KEY,
      proforma_id integer NOT NULL,
      barcode varchar(200) NOT NULL,
      item_name text NOT NULL,
      qty integer NOT NULL DEFAULT 0,
      weight_per_bale decimal(15,3) DEFAULT 0,
      price_per_bale decimal(15,2) DEFAULT 0
    )`,
  `CREATE TABLE IF NOT EXISTS supplier_container_loaded_items (
      id serial PRIMARY KEY,
      container_id integer NOT NULL,
      barcode varchar(200) NOT NULL,
      item_name text,
      qty integer NOT NULL DEFAULT 0,
      weight_per_bale decimal(15,3),
      price_per_bale decimal(15,2)
    )`,
  `CREATE TABLE IF NOT EXISTS bale_recode_sessions (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      performed_by varchar(255),
      uploaded_filename text,
      print_format text NOT NULL DEFAULT 'A4',
      design_color text,
      total_rows integer NOT NULL DEFAULT 0,
      valid_rows integer NOT NULL DEFAULT 0,
      invalid_rows integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS bale_recode_items (
      id serial PRIMARY KEY,
      session_id integer NOT NULL,
      old_reference_code text NOT NULL,
      new_reference_code text,
      product_name text,
      article_code text,
      weight_kg text,
      status text NOT NULL DEFAULT 'pending',
      error_message text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS erp_worker_docs (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      employee_id integer NOT NULL,
      file_name text NOT NULL,
      file_type text NOT NULL,
      file_size integer NOT NULL,
      file_data text NOT NULL,
      description text,
      uploaded_by text,
      uploaded_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS erp_payroll_runs (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      status text NOT NULL DEFAULT 'DRAFT',
      date text NOT NULL,
      notes text,
      payment_account_id integer,
      paid_at text,
      created_at text NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS erp_payroll_run_items (
      id serial PRIMARY KEY,
      run_id integer NOT NULL,
      employee_id integer NOT NULL,
      employee_name text NOT NULL,
      group_name text,
      base_salary decimal(18,2) NOT NULL,
      deduction decimal(18,2) NOT NULL DEFAULT 0,
      payroll_deduction decimal(18,2) NOT NULL DEFAULT 0,
      net_pay decimal(18,2) NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS factory_worker_categories (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      name varchar(200) NOT NULL,
      worker_ids jsonb NOT NULL DEFAULT '[]',
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS freight_accounts (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      account_id varchar(50) NOT NULL,
      account_type varchar(50) NOT NULL,
      account_name varchar(300) NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS freight_accounts_company_account_unique ON freight_accounts (company_id, account_id)`,
  `CREATE TABLE IF NOT EXISTS snapshot_pinned_accounts (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      card_key varchar(50) NOT NULL,
      account_id varchar(50) NOT NULL,
      account_type varchar(50) NOT NULL,
      account_name varchar(300) NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS snapshot_pinned_accounts_unique ON snapshot_pinned_accounts (company_id, card_key, account_id)`,
  `CREATE TABLE IF NOT EXISTS property_units (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      module text NOT NULL DEFAULT 'PROPERTIES',
      unit_type text NOT NULL,
      location_group text NOT NULL,
      unit_number text NOT NULL,
      size text,
      dimensions text,
      notes text,
      active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS property_units_company_module_unit_unique ON property_units (company_id, module, unit_number)`,
  `CREATE INDEX IF NOT EXISTS property_units_company_idx ON property_units (company_id, module, unit_type)`,
  `CREATE TABLE IF NOT EXISTS property_contracts (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      module text NOT NULL DEFAULT 'PROPERTIES',
      unit_id integer NOT NULL,
      tenant_name text NOT NULL,
      guarantee_period text,
      guarantee_amount decimal(20,2) NOT NULL DEFAULT 0,
      rental_amount decimal(20,2) NOT NULL DEFAULT 0,
      start_date date NOT NULL,
      end_date date,
      status text NOT NULL DEFAULT 'ACTIVE',
      notes text,
      statement_note text,
      guarantee_posted_to_statement boolean NOT NULL DEFAULT false,
      guarantee_posted_amount decimal(20,2) DEFAULT 0,
      is_internal boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS property_contracts_unit_idx ON property_contracts (unit_id, status)`,
  `CREATE INDEX IF NOT EXISTS property_contracts_company_idx ON property_contracts (company_id, status)`,
  `CREATE TABLE IF NOT EXISTS property_monthly_ledger (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      module text NOT NULL DEFAULT 'PROPERTIES',
      contract_id integer NOT NULL,
      unit_id integer NOT NULL,
      year integer NOT NULL,
      month integer NOT NULL,
      expected_amount decimal(20,2) NOT NULL DEFAULT 0,
      paid_amount decimal(20,2) NOT NULL DEFAULT 0,
      notes text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS property_monthly_ledger_unique ON property_monthly_ledger (contract_id, year, month)`,
  `CREATE INDEX IF NOT EXISTS property_monthly_ledger_unit_idx ON property_monthly_ledger (unit_id)`,
  `CREATE TABLE IF NOT EXISTS property_payments (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      module text NOT NULL DEFAULT 'PROPERTIES',
      contract_id integer NOT NULL,
      unit_id integer NOT NULL,
      ledger_row_id integer,
      cash_account_id integer,
      voucher_id integer,
      amount decimal(20,2) NOT NULL,
      payment_date date NOT NULL,
      for_year integer NOT NULL,
      for_month integer NOT NULL,
      notes text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS property_payments_contract_idx ON property_payments (contract_id)`,
  `CREATE INDEX IF NOT EXISTS property_payments_company_idx ON property_payments (company_id, payment_date)`,
  `CREATE TABLE IF NOT EXISTS rental_auto_transfer_configs (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      module text NOT NULL,
      dest_company_id integer NOT NULL,
      dest_ledger_account_id integer NOT NULL,
      source_cash_account_ids integer[] NOT NULL DEFAULT '{}',
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rental_auto_transfer_unique ON rental_auto_transfer_configs (company_id, module)`,
  `ALTER TABLE erp_payroll_run_items ADD COLUMN IF NOT EXISTS payroll_deduction decimal(18,2) NOT NULL DEFAULT 0`,
  // Multiple rules per company+module are supported — drop the unique constraint
  `DROP INDEX IF EXISTS rental_auto_transfer_unique`,
  `CREATE TABLE IF NOT EXISTS factory_transporters (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      name text NOT NULL,
      phone varchar(50),
      notes text,
      ledger_account_id integer,
      active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS factory_transporters_company_idx ON factory_transporters (company_id)`,
  `CREATE TABLE IF NOT EXISTS factory_transporter_transactions (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      transporter_id integer NOT NULL,
      tx_type text NOT NULL,
      amount decimal(20,4) NOT NULL,
      tx_date date NOT NULL,
      description text,
      expense_account_id integer,
      cash_account_id integer,
      voucher_id integer,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS factory_transporter_tx_idx ON factory_transporter_transactions (transporter_id)`,
  `CREATE INDEX IF NOT EXISTS factory_transporter_tx_company_idx ON factory_transporter_transactions (company_id)`,
  `CREATE TABLE IF NOT EXISTS customer_order_bale_removals (
      id serial PRIMARY KEY,
      order_id integer NOT NULL,
      bale_id integer NOT NULL,
      reference_number varchar(100) NOT NULL,
      article_code varchar(50),
      product_name text,
      weight_kg decimal(15,3),
      removed_by_user_id varchar,
      removed_by_username varchar,
      removed_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS location_price_groups (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      master_location_id integer NOT NULL,
      follower_location_id integer NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,

  // ── Apr 2026 — Bale Import Batch tracking ─────────────────────────────────
  `CREATE TABLE IF NOT EXISTS factory_bale_import_batches (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL,
      file_name           TEXT NOT NULL,
      bale_count          INTEGER NOT NULL DEFAULT 0,
      error_count         INTEGER NOT NULL DEFAULT 0,
      total_weight_kg     DECIMAL(15,3) NOT NULL DEFAULT 0,
      imported_by_user_id VARCHAR(100),
      imported_by_name    TEXT,
      notes               TEXT,
      created_at          TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
  `ALTER TABLE factory_bales ADD COLUMN IF NOT EXISTS import_batch_id INTEGER`,

  // Daily export run tracking
  `CREATE TABLE IF NOT EXISTS daily_export_runs (
      id                  serial PRIMARY KEY,
      run_type            text NOT NULL,
      started_at          timestamp NOT NULL DEFAULT now(),
      finished_at         timestamp,
      status              text NOT NULL DEFAULT 'running',
      zip_size_bytes      integer,
      companies_count     integer,
      company_files_count integer,
      skipped_companies   text,
      email_attempted     boolean DEFAULT false,
      email_success       boolean DEFAULT false,
      email_error         text,
      email_attempts      integer DEFAULT 0,
      whatsapp_attempted  boolean DEFAULT false,
      whatsapp_success    boolean DEFAULT false,
      whatsapp_error      text,
      whatsapp_attempts   integer DEFAULT 0,
      skipped_reason      text,
      details             jsonb,
      created_at          timestamp NOT NULL DEFAULT now()
    )`,

  // User navigation activity log (for admin Watch User feature)
  `CREATE TABLE IF NOT EXISTS user_activity_log (
      id          serial PRIMARY KEY,
      user_id     varchar NOT NULL,
      username    text NOT NULL,
      company_id  integer,
      company_name text,
      route       text NOT NULL,
      occurred_at timestamp NOT NULL DEFAULT NOW()
    )`,
  `CREATE INDEX IF NOT EXISTS idx_user_activity_log_user ON user_activity_log(user_id, occurred_at DESC)`,

  // ── Seed singleton config rows so the scheduler always finds them ─────────
  // export_settings (id=1): email credentials + schedule toggle
  `INSERT INTO export_settings (id, gmail_user, gmail_app_password, schedule_enabled)
     VALUES (1, '', '', false)
     ON CONFLICT (id) DO NOTHING`,

  // whatsapp_settings (id=1): Green API credentials + enable toggles
  `INSERT INTO whatsapp_settings (id, instance_id, api_token, enabled, monthly_auto_send, daily_auto_send)
     VALUES (1, '', '', false, false, false)
     ON CONFLICT (id) DO NOTHING`,

  // whatsapp_settings (id=2): POS-specific Green API instance (optional; enabled by default so fallback to id=1 works)
  `INSERT INTO whatsapp_settings (id, instance_id, api_token, enabled, monthly_auto_send, daily_auto_send)
     VALUES (2, '', '', true, false, false)
     ON CONFLICT (id) DO NOTHING`,

  // net_position_export_settings (id=1)
  `INSERT INTO net_position_export_settings (id, frequency, send_hour, enabled, auto_send)
     VALUES (1, 'daily', 18, false, false)
     ON CONFLICT (id) DO NOTHING`,

  // ── Stock Allocation v3.0 — isolated test tables (Apr 2026) ───────────────
  `CREATE TABLE IF NOT EXISTS factory_v3_loads (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL,
      proforma_id         INTEGER NOT NULL,
      load_name           TEXT NOT NULL,
      expected_load_date  DATE NOT NULL,
      notes               TEXT,
      status              TEXT NOT NULL DEFAULT 'expected_to_load',
      created_by          INTEGER,
      created_by_name     TEXT,
      created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      started_at          TIMESTAMP,
      finalized_at        TIMESTAMP,
      finalized_by        INTEGER,
      finalized_by_name   TEXT,
      cancelled_at        TIMESTAMP
    )`,
  `CREATE INDEX IF NOT EXISTS factory_v3_loads_company_idx ON factory_v3_loads (company_id, status)`,
  `CREATE TABLE IF NOT EXISTS factory_v3_load_bales (
      id              SERIAL PRIMARY KEY,
      load_id         INTEGER NOT NULL REFERENCES factory_v3_loads(id) ON DELETE CASCADE,
      bale_id         INTEGER NOT NULL,
      bale_reference  VARCHAR(100) NOT NULL,
      article_code    VARCHAR(50),
      product_name    TEXT,
      weight_kg       DECIMAL(15,3) NOT NULL DEFAULT 0,
      phase           TEXT NOT NULL DEFAULT 'scanned',
      added_by        INTEGER,
      added_by_name   TEXT,
      added_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      removed_by      INTEGER,
      removed_by_name TEXT,
      removed_at      TIMESTAMP,
      notes           TEXT
    )`,
  `CREATE INDEX IF NOT EXISTS factory_v3_load_bales_load_idx ON factory_v3_load_bales (load_id)`,
  `CREATE INDEX IF NOT EXISTS factory_v3_load_bales_bale_idx  ON factory_v3_load_bales (bale_id)`,
  `CREATE TABLE IF NOT EXISTS file_folders (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      name text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS folder_id integer REFERENCES file_folders(id) ON DELETE SET NULL`,
  `ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS display_name text`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS destination text`,
  `ALTER TABLE locations ADD COLUMN IF NOT EXISTS whatsapp_group_chat_id text`,
  `ALTER TABLE locations ADD COLUMN IF NOT EXISTS transfer_wa_group_chat_id text`,
  `CREATE TABLE IF NOT EXISTS factory_invoice_loading_sessions (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER NOT NULL,
      invoice_id       INTEGER NOT NULL,
      customer_id      INTEGER NOT NULL,
      location_id      INTEGER,
      status           TEXT NOT NULL DEFAULT 'OPEN',
      truck_no         TEXT,
      driver_name      TEXT,
      notes            TEXT,
      created_by       VARCHAR(100),
      created_by_name  TEXT,
      started_at       TIMESTAMP NOT NULL DEFAULT now(),
      completed_at     TIMESTAMP,
      cancelled_at     TIMESTAMP,
      created_at       TIMESTAMP NOT NULL DEFAULT now(),
      updated_at       TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS factory_invoice_loading_sessions_invoice_idx ON factory_invoice_loading_sessions (invoice_id)`,
  `CREATE INDEX IF NOT EXISTS factory_invoice_loading_sessions_company_idx ON factory_invoice_loading_sessions (company_id)`,
  `CREATE INDEX IF NOT EXISTS factory_invoice_loading_sessions_status_idx  ON factory_invoice_loading_sessions (status)`,
  `CREATE TABLE IF NOT EXISTS factory_invoice_loading_bales (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER NOT NULL,
      session_id       INTEGER NOT NULL,
      invoice_id       INTEGER NOT NULL,
      bale_id          INTEGER NOT NULL,
      bale_reference   VARCHAR(100) NOT NULL,
      article_code     VARCHAR(50),
      product_name     TEXT,
      weight_kg        DECIMAL(15,3) NOT NULL DEFAULT 0,
      scanned_at       TIMESTAMP NOT NULL DEFAULT now(),
      scanned_by       VARCHAR(100),
      scanned_by_name  TEXT,
      created_at       TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS factory_invoice_loading_bales_session_idx ON factory_invoice_loading_bales (session_id)`,
  `CREATE INDEX IF NOT EXISTS factory_invoice_loading_bales_invoice_idx ON factory_invoice_loading_bales (invoice_id)`,
  `CREATE INDEX IF NOT EXISTS factory_invoice_loading_bales_bale_idx    ON factory_invoice_loading_bales (bale_id)`,
  `ALTER TABLE factory_invoice_loading_sessions ALTER COLUMN created_by TYPE VARCHAR(100) USING created_by::VARCHAR`,
  `ALTER TABLE factory_invoice_loading_bales    ALTER COLUMN scanned_by TYPE VARCHAR(100) USING scanned_by::VARCHAR`,
  // V5 Stock Allocation — per-container locked expected quantities (Phase B, Apr 2026)
  // One row per (order_id × article_code). Created on POST proforma-with-loading; backfilled on first GET.
  `CREATE TABLE IF NOT EXISTS customer_order_expected_lines (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER NOT NULL,
      order_id         INTEGER NOT NULL,
      proforma_id      INTEGER,
      proforma_line_id INTEGER,
      article_code     VARCHAR(50) NOT NULL,
      product_name     TEXT,
      expected_qty     INTEGER NOT NULL,
      created_at       TIMESTAMP NOT NULL DEFAULT now(),
      updated_at       TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS coel_order_idx   ON customer_order_expected_lines (order_id)`,
  `CREATE INDEX IF NOT EXISTS coel_company_idx ON customer_order_expected_lines (company_id)`,
  // Uniqueness constraint: one expected line per container × article_code.
  // Prevents duplicate rows if two concurrent GET requests both trigger the backfill.
  // ON CONFLICT DO NOTHING in the backfill INSERT is the paired application-level guard.
  `CREATE UNIQUE INDEX IF NOT EXISTS coel_order_article_unique ON customer_order_expected_lines (order_id, article_code)`,
];
