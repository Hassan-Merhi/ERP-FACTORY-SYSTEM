/**
 * Startup schema migrations - Migration log, base table creation, and the early column back-fills for companies, exchange rates and other core tables.
 *
 * Part of the ordered `startupMigrations` array assembled in ./index.ts.
 * Statement order is load-bearing: these run sequentially at boot, so entries
 * must never be reordered or moved between parts.
 */

export const coreTablesAndColumns: string[] = [
  // ── One-time migration log (idempotency guard for destructive DML) ────────
  `CREATE TABLE IF NOT EXISTS migrations_log (
      key text PRIMARY KEY,
      applied_at timestamp NOT NULL DEFAULT now()
    )`,
  // ── Create missing tables ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS user_presence (
      id serial PRIMARY KEY,
      session_id varchar(255) NOT NULL,
      user_id varchar NOT NULL,
      username text NOT NULL,
      current_route text NOT NULL DEFAULT '/',
      company_id integer,
      company_name text,
      role text,
      last_seen timestamp NOT NULL DEFAULT now(),
      CONSTRAINT user_presence_session_unique UNIQUE (session_id)
    )`,
  `CREATE TABLE IF NOT EXISTS direct_messages (
      id serial PRIMARY KEY,
      sender_id varchar NOT NULL,
      receiver_id varchar NOT NULL,
      message text NOT NULL,
      read_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS direct_messages_sender_idx ON direct_messages(sender_id)`,
  `CREATE INDEX IF NOT EXISTS direct_messages_receiver_idx ON direct_messages(receiver_id)`,
  `CREATE TABLE IF NOT EXISTS login_history (
      id serial PRIMARY KEY,
      user_id varchar NOT NULL,
      username text NOT NULL,
      company_id integer,
      company_name text,
      ip_address text,
      user_agent text,
      city text,
      country text,
      login_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS login_history_user_idx ON login_history(user_id)`,
  `CREATE INDEX IF NOT EXISTS login_history_login_at_idx ON login_history(login_at)`,
  // ── Add missing columns to companies table ────────────────────────────────
  // Use DO blocks so we check information_schema first — if the column already
  // exists we never attempt the ALTER TABLE, meaning no ACCESS EXCLUSIVE lock
  // is ever requested and existing queries on `companies` are not blocked.
  `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='companies' AND column_name='company_type') THEN
         ALTER TABLE companies ADD COLUMN company_type text NOT NULL DEFAULT 'erp';
       END IF;
     END $$`,
  `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='companies' AND column_name='base_currency') THEN
         ALTER TABLE companies ADD COLUMN base_currency varchar(10) DEFAULT 'USD';
       END IF;
     END $$`,
  `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='companies' AND column_name='display_currency') THEN
         ALTER TABLE companies ADD COLUMN display_currency varchar(10);
       END IF;
     END $$`,
  `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='companies' AND column_name='created_at') THEN
         ALTER TABLE companies ADD COLUMN created_at timestamp NOT NULL DEFAULT now();
       END IF;
     END $$`,
  // ── Create exchange_rates table ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS exchange_rates (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      from_currency varchar(10) NOT NULL,
      to_currency varchar(10) NOT NULL,
      rate decimal(20,6) NOT NULL,
      effective_date date NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS exchange_rates_company_idx ON exchange_rates(company_id)`,
  `CREATE INDEX IF NOT EXISTS exchange_rates_date_idx ON exchange_rates(effective_date)`,
  // ── Add missing columns to existing tables ─────────────────────────────────
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_erp_cost_fields text[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS chatbot_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS hidden_transaction_journal_voucher_ids integer[] NOT NULL DEFAULT '{}'`,
  // Enable chatbot for all existing users (column was added with DEFAULT false — flip to opt-out model)
  // Wrapped in migrations_log so a user turning off their chatbot is not re-enabled on next restart.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'chatbot-enable-all-v1') THEN
        UPDATE users SET chatbot_enabled = true WHERE chatbot_enabled = false;
        INSERT INTO migrations_log(key) VALUES ('chatbot-enable-all-v1');
      END IF;
    END $$`,
  `ALTER TABLE user_company_roles ADD COLUMN IF NOT EXISTS can_sell_negative_stock boolean NOT NULL DEFAULT false`,
  `ALTER TABLE user_company_roles ADD COLUMN IF NOT EXISTS daybook_edit_days integer NOT NULL DEFAULT 0`,
  `ALTER TABLE user_company_roles ADD COLUMN IF NOT EXISTS can_access_customers boolean NOT NULL DEFAULT false`,
  `ALTER TABLE user_company_roles ADD COLUMN IF NOT EXISTS can_delete_records boolean NOT NULL DEFAULT false`,
  `ALTER TABLE user_company_roles ADD COLUMN IF NOT EXISTS cash_account_id integer`,
  `ALTER TABLE user_company_roles ADD COLUMN IF NOT EXISTS pos_station integer`,
  `ALTER TABLE user_company_roles ADD COLUMN IF NOT EXISTS pos_view_only boolean NOT NULL DEFAULT false`,
  `ALTER TABLE stock_transfer_vouchers ADD COLUMN IF NOT EXISTS inventory_applied boolean DEFAULT false`,
  `ALTER TABLE direct_messages ALTER COLUMN message DROP NOT NULL`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_url text`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_name text`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_type text`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_size integer`,
  `CREATE TABLE IF NOT EXISTS stored_files (
      id serial PRIMARY KEY,
      company_id integer NOT NULL REFERENCES companies(id),
      file_name text NOT NULL,
      file_type text NOT NULL,
      file_size integer NOT NULL,
      file_data text NOT NULL,
      description text,
      uploaded_by integer,
      uploaded_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS spreadsheets (
      id serial PRIMARY KEY,
      company_id integer NOT NULL REFERENCES companies(id),
      name text NOT NULL DEFAULT 'Untitled Spreadsheet',
      data jsonb NOT NULL DEFAULT '[]',
      created_by text,
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  // Factory supplier hierarchy
  `ALTER TABLE factory_suppliers ADD COLUMN IF NOT EXISTS parent_id integer`,
  `ALTER TABLE factory_suppliers ADD COLUMN IF NOT EXISTS linked_supplier_id integer`,
  `ALTER TABLE factory_suppliers ADD COLUMN IF NOT EXISTS is_broker boolean NOT NULL DEFAULT false`,
  // Factory supplier categories table (referenced by factory_suppliers.supplier_category_id)
  `CREATE TABLE IF NOT EXISTS factory_supplier_categories (
       id serial PRIMARY KEY,
       company_id integer NOT NULL,
       name varchar(200) NOT NULL,
       display_order integer NOT NULL DEFAULT 0,
       created_at timestamp NOT NULL DEFAULT now(),
       updated_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS factory_supplier_categories_company_name_unique
       ON factory_supplier_categories(company_id, name)`,
  `ALTER TABLE factory_suppliers ADD COLUMN IF NOT EXISTS supplier_category_id integer`,
  `ALTER TABLE factory_suppliers ADD COLUMN IF NOT EXISTS current_raw_material_cost_per_kg_usd NUMERIC(20,8)`,
  // Factory supplier support in voucher entries
  `ALTER TABLE voucher_entries ADD COLUMN IF NOT EXISTS factory_supplier_id integer`,
  // Factory raw stock OB commission fields
  `ALTER TABLE factory_raw_stock ADD COLUMN IF NOT EXISTS commission_person_name text`,
  `ALTER TABLE factory_raw_stock ADD COLUMN IF NOT EXISTS commission_amount decimal(20,4)`,
  `ALTER TABLE factory_raw_stock ADD COLUMN IF NOT EXISTS commission_currency_code varchar(10)`,
  `ALTER TABLE factory_raw_stock ADD COLUMN IF NOT EXISTS commission_fx_rate_to_usd decimal(20,8)`,
  `ALTER TABLE factory_raw_stock ADD COLUMN IF NOT EXISTS commission_amount_usd decimal(20,4)`,
  `ALTER TABLE factory_raw_stock ADD COLUMN IF NOT EXISTS commission_ledger_account_id integer`,
  `ALTER TABLE factory_raw_stock ADD COLUMN IF NOT EXISTS commission_supplier_id integer`,
  // Factory supplier payments table
  `CREATE TABLE IF NOT EXISTS factory_supplier_payments (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      supplier_id integer NOT NULL,
      date varchar(20) NOT NULL,
      amount decimal(20,4) NOT NULL,
      currency_code varchar(10) NOT NULL DEFAULT 'USD',
      fx_rate_to_usd decimal(20,8) NOT NULL DEFAULT 1,
      amount_usd decimal(20,4) NOT NULL,
      paid_from_account_id integer,
      notes text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS factory_supplier_fx_transfers (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      from_supplier_id integer NOT NULL,
      to_supplier_id integer NOT NULL,
      date varchar(20) NOT NULL,
      from_currency_code varchar(10) NOT NULL,
      from_amount decimal(20,4) NOT NULL,
      fx_rate_to_usd decimal(20,8) NOT NULL,
      to_amount_usd decimal(20,4) NOT NULL,
      notes text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  // ── Fix stale factory page access keys (old Settings.tsx had wrong route keys) ──
  // Wrapped in migrations_log: all renames/deletes are idempotent after first run
  // (old keys no longer exist), but explicit guard prevents log noise on restarts.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'factory-page-key-renames-v1') THEN
        -- factory/raw-stock → factory/raw-materials
        UPDATE factory_user_page_access SET page_key = 'factory/raw-materials' WHERE page_key = 'factory/raw-stock' AND NOT EXISTS (SELECT 1 FROM factory_user_page_access b WHERE b.company_id = factory_user_page_access.company_id AND b.user_id = factory_user_page_access.user_id AND b.page_key = 'factory/raw-materials');
        DELETE FROM factory_user_page_access WHERE page_key = 'factory/raw-stock';
        -- factory/bales-history → factory/bales-hub
        UPDATE factory_user_page_access SET page_key = 'factory/bales-hub' WHERE page_key = 'factory/bales-history' AND NOT EXISTS (SELECT 1 FROM factory_user_page_access b WHERE b.company_id = factory_user_page_access.company_id AND b.user_id = factory_user_page_access.user_id AND b.page_key = 'factory/bales-hub');
        DELETE FROM factory_user_page_access WHERE page_key = 'factory/bales-history';
        -- factory/sales/loading/new → factory/sales/loadings
        UPDATE factory_user_page_access SET page_key = 'factory/sales/loadings' WHERE page_key = 'factory/sales/loading/new' AND NOT EXISTS (SELECT 1 FROM factory_user_page_access b WHERE b.company_id = factory_user_page_access.company_id AND b.user_id = factory_user_page_access.user_id AND b.page_key = 'factory/sales/loadings');
        DELETE FROM factory_user_page_access WHERE page_key = 'factory/sales/loading/new';
        -- factory/sales/loading/pending → factory/sales/loadings
        UPDATE factory_user_page_access SET page_key = 'factory/sales/loadings' WHERE page_key = 'factory/sales/loading/pending' AND NOT EXISTS (SELECT 1 FROM factory_user_page_access b WHERE b.company_id = factory_user_page_access.company_id AND b.user_id = factory_user_page_access.user_id AND b.page_key = 'factory/sales/loadings');
        DELETE FROM factory_user_page_access WHERE page_key = 'factory/sales/loading/pending';
        -- factory/sales/pending-invoices → factory/sales/invoices (legacy step)
        UPDATE factory_user_page_access SET page_key = 'factory/sales/invoices' WHERE page_key = 'factory/sales/pending-invoices' AND NOT EXISTS (SELECT 1 FROM factory_user_page_access b WHERE b.company_id = factory_user_page_access.company_id AND b.user_id = factory_user_page_access.user_id AND b.page_key = 'factory/sales/invoices');
        DELETE FROM factory_user_page_access WHERE page_key = 'factory/sales/pending-invoices';
        -- Consolidate proformas + invoices into unified invoicing page
        UPDATE factory_user_page_access SET page_key = 'factory/invoicing' WHERE page_key = 'factory/sales/proformas' AND NOT EXISTS (SELECT 1 FROM factory_user_page_access b WHERE b.company_id = factory_user_page_access.company_id AND b.user_id = factory_user_page_access.user_id AND b.page_key = 'factory/invoicing');
        UPDATE factory_user_page_access SET page_key = 'factory/invoicing' WHERE page_key = 'factory/sales/invoices' AND NOT EXISTS (SELECT 1 FROM factory_user_page_access b WHERE b.company_id = factory_user_page_access.company_id AND b.user_id = factory_user_page_access.user_id AND b.page_key = 'factory/invoicing');
        DELETE FROM factory_user_page_access WHERE page_key IN ('factory/sales/proformas', 'factory/sales/invoices');
        -- Delete obsolete keys that have no equivalent in the current sidebar
        DELETE FROM factory_user_page_access WHERE page_key IN ('factory/mix-batches', 'factory/sales/new', 'factory/bale-transfers', 'factory/create', 'factory/users', 'factory/daybook');
        INSERT INTO migrations_log(key) VALUES ('factory-page-key-renames-v1');
      END IF;
    END $$`,
  // Wave 5 Factory permission canonicalization. This migration is intentionally
  // separate from the historical v1 rename so current canonical keys such as
  // factory/daybook are preserved and unrestricted users (zero rows) stay unrestricted.
  `DO $ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'factory-permission-canonicalization-v2') THEN
        -- Insert canonical rows first, then delete aliases. ON CONFLICT preserves
        -- existing restrictions without duplicating them.
        INSERT INTO factory_user_page_access(company_id, user_id, page_key)
        SELECT company_id, user_id,
          CASE
            WHEN page_key IN ('factory/raw-stock') THEN 'factory/raw-materials'
            WHEN page_key IN ('factory/bales-history','factory/bale-products','factory/bale-product-history','factory/reprint-labels','factory/barcode-lookup') THEN 'factory/bales-hub'
            WHEN page_key IN ('factory/pressing','factory/finalize') THEN 'factory/stock-entry'
            WHEN page_key IN ('factory/sales/new','factory/sales/loading','factory/sales/loadings','factory/sales/loading/new','factory/sales/loading/pending','factory/sales/pending-invoices','factory/invoices','factory/sales/invoices','factory/sales/proformas') THEN 'factory/invoicing'
            WHEN page_key IN ('factory/containers','factory/stock-otw') THEN 'factory/containers-hub'
            WHEN page_key IN ('factory/stock-allocation','factory/stock-allocation-v2','factory/stock-allocation-v3') THEN 'factory/stock-allocation-v5'
            WHEN page_key IN ('factory/customers','factory/suppliers') THEN 'factory/parties'
            WHEN page_key IN ('factory/finance','factory/payroll','factory/worker-payroll','factory/workers','factory/employees','factory/insurance') THEN 'factory/payroll-hub'
            WHEN page_key IN ('factory/ledger-monthly','factory/ledger-vouchers','factory/create') THEN 'factory/accounts'
            WHEN page_key IN ('factory/voucher-detail') THEN 'factory/vouchers'
            WHEN page_key IN ('factory/supplier-report','factory/supplier-statement','factory/intelligence/supplier-scores') THEN 'factory/intelligence/supplier-hub'
            WHEN page_key IN ('factory/production-summary','factory/intelligence/mix-optimizer','factory/intelligence/waste') THEN 'factory/intelligence/production-hub'
            WHEN page_key IN ('factory/intelligence/profitability','factory/intelligence/cashflow','factory/net-position-details','factory/net-position','factory/net-profit-analytics') THEN 'factory/intelligence/financial-hub'
            WHEN page_key IN ('factory/financial-snapshot') THEN 'factory/analytics'
            WHEN page_key IN ('factory/users','factory/customer-logos','factory/label-banners') THEN 'factory/settings'
            WHEN page_key IN ('factory/bale-ledger','factory/pos') THEN 'factory/production-report'
            ELSE page_key
          END
        FROM factory_user_page_access
        WHERE page_key IN (
          'factory/raw-stock',
          'factory/bales-history','factory/bale-products','factory/bale-product-history','factory/reprint-labels','factory/barcode-lookup',
          'factory/pressing','factory/finalize',
          'factory/sales/new','factory/sales/loading','factory/sales/loadings','factory/sales/loading/new','factory/sales/loading/pending','factory/sales/pending-invoices','factory/invoices','factory/sales/invoices','factory/sales/proformas',
          'factory/containers','factory/stock-otw',
          'factory/stock-allocation','factory/stock-allocation-v2','factory/stock-allocation-v3',
          'factory/customers','factory/suppliers',
          'factory/finance','factory/payroll','factory/worker-payroll','factory/workers','factory/employees','factory/insurance',
          'factory/ledger-monthly','factory/ledger-vouchers','factory/create',
          'factory/voucher-detail',
          'factory/supplier-report','factory/supplier-statement','factory/intelligence/supplier-scores',
          'factory/production-summary','factory/intelligence/mix-optimizer','factory/intelligence/waste',
          'factory/intelligence/profitability','factory/intelligence/cashflow','factory/net-position-details','factory/net-position','factory/net-profit-analytics',
          'factory/financial-snapshot',
          'factory/users','factory/customer-logos','factory/label-banners',
          'factory/bale-ledger','factory/pos'
        )
        ON CONFLICT (company_id, user_id, page_key) DO NOTHING;

        DELETE FROM factory_user_page_access
        WHERE page_key IN (
          'factory/raw-stock',
          'factory/bales-history','factory/bale-products','factory/bale-product-history','factory/reprint-labels','factory/barcode-lookup',
          'factory/pressing','factory/finalize',
          'factory/sales/new','factory/sales/loading','factory/sales/loadings','factory/sales/loading/new','factory/sales/loading/pending','factory/sales/pending-invoices','factory/invoices','factory/sales/invoices','factory/sales/proformas',
          'factory/containers','factory/stock-otw',
          'factory/stock-allocation','factory/stock-allocation-v2','factory/stock-allocation-v3',
          'factory/customers','factory/suppliers',
          'factory/finance','factory/payroll','factory/worker-payroll','factory/workers','factory/employees','factory/insurance',
          'factory/ledger-monthly','factory/ledger-vouchers','factory/create',
          'factory/voucher-detail',
          'factory/supplier-report','factory/supplier-statement','factory/intelligence/supplier-scores',
          'factory/production-summary','factory/intelligence/mix-optimizer','factory/intelligence/waste',
          'factory/intelligence/profitability','factory/intelligence/cashflow','factory/net-position-details','factory/net-position','factory/net-profit-analytics',
          'factory/financial-snapshot',
          'factory/users','factory/customer-logos','factory/label-banners',
          'factory/bale-ledger','factory/pos',
          'factory/mix-batches','factory/bale-transfers'
        );

        -- Remove deprecated page-level hide flags and known retired tab keys.
        -- Non-tab cost/visibility fields are left untouched.
        UPDATE factory_user_profiles
        SET hidden_cost_fields = ARRAY(
          SELECT DISTINCT key
          FROM unnest(COALESCE(hidden_cost_fields, ARRAY[]::text[])) AS key
          WHERE key NOT IN (
            'hide_tab_production_analytics',
            'hide_tab_agents',
            'hide_tab_daybook',
            'hide_tab_stockentry_attendance_register'
          )
          ORDER BY key
        )
        WHERE hidden_cost_fields && ARRAY[
          'hide_tab_production_analytics',
          'hide_tab_agents',
          'hide_tab_daybook',
          'hide_tab_stockentry_attendance_register'
        ]::text[];

        INSERT INTO migrations_log(key) VALUES ('factory-permission-canonicalization-v2');
      END IF;
    END $`,
  // Add ledger account link to customer order charges
  `ALTER TABLE customer_order_charges ADD COLUMN IF NOT EXISTS ledger_account_id integer`,
  // Bale recode / relabeling audit tables
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
      status text NOT NULL DEFAULT 'SUCCESS',
      error_message text
    )`,
  // Sync factory_mix_batches with production schema
  `ALTER TABLE factory_mix_batches ADD COLUMN IF NOT EXISTS batch_number text`,
  // Sync factory_mix_batch_sources with production schema
  `ALTER TABLE factory_mix_batch_sources ADD COLUMN IF NOT EXISTS source_type text`,
  `ALTER TABLE factory_mix_batch_sources ADD COLUMN IF NOT EXISTS source_id integer`,
  `ALTER TABLE factory_mix_batch_sources ADD COLUMN IF NOT EXISTS quantity_kg decimal(15,3)`,
  `ALTER TABLE factory_mix_batch_sources ADD COLUMN IF NOT EXISTS notes text`,
  `CREATE TABLE IF NOT EXISTS factory_worker_advances (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      worker_id integer NOT NULL REFERENCES factory_workers(id),
      advance_date date NOT NULL,
      amount decimal(20, 2) NOT NULL,
      remaining_balance decimal(20, 2) NOT NULL DEFAULT 0,
      cash_account_id integer,
      notes text,
      fully_paid boolean NOT NULL DEFAULT false,
      created_at timestamp DEFAULT now() NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS factory_worker_advances_company_idx ON factory_worker_advances (company_id)`,
  `CREATE INDEX IF NOT EXISTS factory_worker_advances_worker_idx ON factory_worker_advances (worker_id)`,
  `ALTER TABLE factory_worker_advances ADD COLUMN IF NOT EXISTS remaining_balance decimal(20,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE factory_worker_advances ADD COLUMN IF NOT EXISTS cash_account_id integer`,
  `ALTER TABLE factory_worker_advances ADD COLUMN IF NOT EXISTS fully_paid boolean NOT NULL DEFAULT false`,
  `ALTER TABLE factory_worker_advances ADD COLUMN IF NOT EXISTS repayment_type VARCHAR(30) NOT NULL DEFAULT 'salary_deduction'`,
  `CREATE TABLE IF NOT EXISTS factory_advance_repayments (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      advance_id integer NOT NULL REFERENCES factory_worker_advances(id),
      worker_id integer NOT NULL,
      repayment_date date NOT NULL,
      amount decimal(20, 2) NOT NULL,
      cash_account_id integer,
      notes text,
      created_at timestamp DEFAULT now() NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS factory_advance_repayments_advance_idx ON factory_advance_repayments (advance_id)`,
  `CREATE INDEX IF NOT EXISTS factory_advance_repayments_company_idx ON factory_advance_repayments (company_id)`,
  `ALTER TABLE factory_advance_repayments ADD COLUMN IF NOT EXISTS payroll_id INTEGER`,
  `ALTER TABLE factory_advance_repayments ADD COLUMN IF NOT EXISTS cash_account_id INTEGER REFERENCES ledger_accounts(id)`,
  // Live spreadsheet links (shared Google Sheet / external links)
  `CREATE TABLE IF NOT EXISTS live_spreadsheets (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      name text NOT NULL,
      url text NOT NULL,
      description text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS inventory_negative_layers (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      location_id integer NOT NULL,
      stock_item_id integer NOT NULL,
      qty decimal(15,3) NOT NULL,
      provisional_rate decimal(20,4) NOT NULL DEFAULT 0,
      source_voucher_type varchar(100),
      source_voucher_id integer,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS inv_neg_layers_loc_item ON inventory_negative_layers (location_id, stock_item_id)`,
  // Mix batch daily consumption (Mar 2026)
  `ALTER TABLE factory_mix_batches ADD COLUMN IF NOT EXISTS operator_user text`,
  `ALTER TABLE factory_mix_batches ADD COLUMN IF NOT EXISTS batch_date date`,
  `ALTER TABLE factory_mix_batches ADD COLUMN IF NOT EXISTS carry_forward_from_id integer`,
  `CREATE TABLE IF NOT EXISTS factory_daily_usages (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      mix_batch_id integer NOT NULL,
      kg_used numeric NOT NULL,
      operator_user text,
      used_date date NOT NULL DEFAULT CURRENT_DATE,
      notes text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS factory_daily_usages_batch_idx ON factory_daily_usages (mix_batch_id)`,
  `CREATE INDEX IF NOT EXISTS factory_daily_usages_company_date_idx ON factory_daily_usages (company_id, used_date)`,
  // Wipers Re-Entry by Date (Mar 2026) — backdated stock entry date per bale
  `ALTER TABLE factory_bales ADD COLUMN IF NOT EXISTS stock_entry_date date`,
  // Freight currency per container (Mar 2026)
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS freight_currency_code varchar(10) DEFAULT 'USD'`,
  // Container-level multiple other charges (Mar 2026)
  `CREATE TABLE IF NOT EXISTS factory_container_other_charges (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      container_id integer NOT NULL,
      description text NOT NULL,
      amount numeric(20,2) NOT NULL,
      ledger_account_id integer,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS factory_container_other_charges_container_idx ON factory_container_other_charges (container_id)`,
  `ALTER TABLE factory_container_other_charges ADD COLUMN IF NOT EXISTS currency_code text DEFAULT 'USD'`,
  // POS profit comparison on receipt (Mar 2026)
  `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS show_profit_comparison_on_pos boolean NOT NULL DEFAULT false`,
  // Store configured (Hassan's) price on each sales item so reprints are accurate (Mar 2026)
  `ALTER TABLE sales_items ADD COLUMN IF NOT EXISTS configured_price decimal(15,6)`,
  // Employee bonus configuration fields (Mar 2026)
  `ALTER TABLE employees ADD COLUMN IF NOT EXISTS sales_bonus_pct decimal(10,4)`,
  `ALTER TABLE employees ADD COLUMN IF NOT EXISTS bales_bonus_rate decimal(10,4)`,
  // Per-employee per-location bale bonus rates (Mar 2026)
  `CREATE TABLE IF NOT EXISTS employee_bale_rates (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      employee_id integer NOT NULL,
      location_id integer NOT NULL,
      rate decimal(10,4) NOT NULL
    )`,
  // Cross-company sales bonus % source fields on employees (Mar 2026)
  `ALTER TABLE employees ADD COLUMN IF NOT EXISTS sales_bonus_pct_source_company_id integer`,
  `ALTER TABLE employees ADD COLUMN IF NOT EXISTS sales_bonus_pct_location_id integer`,
  // Cross-company source on bale rates (Mar 2026)
  `ALTER TABLE employee_bale_rates ADD COLUMN IF NOT EXISTS source_company_id integer`,
  // Per-employee per-location sales bonus % rates table (Mar 2026)
  `CREATE TABLE IF NOT EXISTS employee_bale_pct_rates (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      employee_id integer NOT NULL,
      location_id integer NOT NULL,
      pct decimal(10,4) NOT NULL,
      source_company_id integer
    )`,
  // Company settings table (logo, invoice footer, misc per-company config)
  `CREATE TABLE IF NOT EXISTS company_settings (
      id serial PRIMARY KEY,
      company_id integer NOT NULL UNIQUE,
      logo_url text,
      logo_file_name text,
      logo_updated_at timestamp,
      invoice_footer text,
      parent_credit_account_id integer,
      net_position_adjustment decimal(15,2) DEFAULT 0,
      pos_excel_import_enabled boolean DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  // Intercompany POS auto-transfer config (Mar 2026)
  `CREATE TABLE IF NOT EXISTS intercompany_pos_configs (
      id serial PRIMARY KEY,
      source_company_id integer NOT NULL UNIQUE,
      dest_company_id integer NOT NULL,
      source_interco_account_id integer NOT NULL,
      dest_interco_account_id integer NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  // Factory Bale Waste Dispatch (Mar 2026)
  `CREATE TABLE IF NOT EXISTS factory_bale_waste_dispatches (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      dispatch_number text NOT NULL,
      dispatch_date date NOT NULL,
      notes text,
      total_bales integer NOT NULL DEFAULT 0,
      total_weight_kg decimal(15,3) NOT NULL DEFAULT 0,
      total_cost_written_off decimal(15,2) NOT NULL DEFAULT 0,
      created_by integer,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `ALTER TABLE factory_bales ADD COLUMN IF NOT EXISTS waste_dispatch_id integer`,
  // ERP Payroll Runs tables (Mar 2026)
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
      net_pay decimal(18,2) NOT NULL
    )`,
  // Waste Dispatch tables (Mar 2026)
  `CREATE TABLE IF NOT EXISTS waste_dispatches (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      location_id integer NOT NULL,
      voucher_id integer,
      dispatch_number text NOT NULL,
      dispatch_date date NOT NULL,
      notes text,
      total_amount decimal(15,2) NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS waste_dispatch_items (
      id serial PRIMARY KEY,
      dispatch_id integer NOT NULL,
      stock_item_id integer NOT NULL,
      quantity decimal(15,3) NOT NULL,
      rate decimal(15,2) NOT NULL,
      total_amount decimal(15,2) NOT NULL
    )`,
  // Factory waste type column (missed in original factory_waste_entries creation)
  `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'factory_waste_entries') THEN
         ALTER TABLE factory_waste_entries ADD COLUMN IF NOT EXISTS waste_type varchar(50);
       END IF;
     END $$`,
  // POS draft sales (saved cart state for POS users)
  `CREATE TABLE IF NOT EXISTS draft_pos_sales (
      id serial PRIMARY KEY,
      user_id varchar(255) NOT NULL,
      location_id integer NOT NULL,
      payment_account_type text,
      payment_account_id integer,
      is_credit_sale boolean DEFAULT false,
      notes text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS draft_pos_sale_items (
      id serial PRIMARY KEY,
      draft_id integer NOT NULL,
      stock_item_id integer NOT NULL,
      quantity decimal(15,3) NOT NULL,
      rate decimal(15,2) NOT NULL,
      amount decimal(15,2) NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  // Employee attendance tracking
  `CREATE TABLE IF NOT EXISTS employee_attendance (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      employee_id integer NOT NULL REFERENCES employees(id),
      attendance_date date NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'Present',
      notes text,
      created_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT employee_attendance_unique UNIQUE (employee_id, attendance_date)
    )`,
  `CREATE INDEX IF NOT EXISTS employee_attendance_company_date_idx ON employee_attendance (company_id, attendance_date)`,
  // Employee advances
  `CREATE TABLE IF NOT EXISTS employee_advances (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      employee_id integer NOT NULL REFERENCES employees(id),
      advance_date date NOT NULL,
      amount decimal(20,2) NOT NULL,
      remaining_balance decimal(20,2) NOT NULL DEFAULT 0,
      cash_account_id integer,
      notes text,
      fully_paid boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS employee_advances_company_idx ON employee_advances (company_id)`,
  `CREATE INDEX IF NOT EXISTS employee_advances_employee_idx ON employee_advances (employee_id)`,
  // Employee advance repayments
  `CREATE TABLE IF NOT EXISTS employee_advance_repayments (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      advance_id integer NOT NULL REFERENCES employee_advances(id) ON DELETE CASCADE,
      employee_id integer NOT NULL,
      repayment_date date NOT NULL,
      amount decimal(20,2) NOT NULL,
      cash_account_id integer,
      notes text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS employee_advance_repayments_advance_idx ON employee_advance_repayments (advance_id)`,
  // Worker bonuses
  `CREATE TABLE IF NOT EXISTS worker_bonuses (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      worker_id integer NOT NULL REFERENCES factory_workers(id),
      bonus_date date NOT NULL,
      amount decimal(20,2) NOT NULL,
      notes text,
      status varchar(20) NOT NULL DEFAULT 'pending',
      cash_account_id integer,
      paid_date date,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS worker_bonuses_company_idx ON worker_bonuses (company_id)`,
  `CREATE INDEX IF NOT EXISTS worker_bonuses_worker_idx ON worker_bonuses (worker_id)`,
  // Employee bonuses
  `CREATE TABLE IF NOT EXISTS employee_bonuses (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      employee_id integer NOT NULL REFERENCES employees(id),
      bonus_date date NOT NULL,
      amount decimal(20,2) NOT NULL,
      notes text,
      voucher_id integer,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS employee_bonuses_company_idx ON employee_bonuses (company_id)`,
  `CREATE INDEX IF NOT EXISTS employee_bonuses_employee_idx ON employee_bonuses (employee_id)`,
];
