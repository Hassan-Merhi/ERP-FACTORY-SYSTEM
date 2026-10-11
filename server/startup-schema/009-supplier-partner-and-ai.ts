/**
 * Startup schema migrations - Supplier Partner tables, property contract currency columns, ground and daily bale scan logs, factory container auto-tracking, and the AI import/correction-memory tables.
 *
 * Part of the ordered `startupMigrations` array assembled in ./index.ts.
 * Statement order is load-bearing: these run sequentially at boot, so entries
 * must never be reordered or moved between parts.
 */

export const supplierPartnerAndAi: string[] = [
  // ── Supplier Partner (SP) Tables ──────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS sp_containers (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      supplier_name TEXT NOT NULL,
      invoice_number VARCHAR(100) NOT NULL,
      invoice_date DATE NOT NULL,
      invoice_total_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      discount_pct DECIMAL(8,4) DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      goods_otw_voucher_id INTEGER,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS sp_containers_company_idx ON sp_containers (company_id)`,

  `CREATE TABLE IF NOT EXISTS sp_container_lines (
      id SERIAL PRIMARY KEY,
      container_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      article_code VARCHAR(100) NOT NULL,
      description TEXT,
      qty DECIMAL(15,4) NOT NULL DEFAULT 0,
      unit_rate_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      stock_item_id INTEGER
    )`,
  `CREATE INDEX IF NOT EXISTS sp_container_lines_container_idx ON sp_container_lines (container_id)`,

  `CREATE TABLE IF NOT EXISTS sp_prepaid_charges (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      container_id INTEGER NOT NULL,
      charge_type VARCHAR(50) NOT NULL,
      agent_name TEXT,
      amount_paid_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      amount_used_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      voucher_id INTEGER,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS sp_prepaid_charges_container_idx ON sp_prepaid_charges (container_id)`,

  `CREATE TABLE IF NOT EXISTS sp_offloads (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      container_id INTEGER NOT NULL,
      offload_date DATE NOT NULL,
      total_qty DECIMAL(15,4) NOT NULL DEFAULT 0,
      total_base_cost_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      total_landed_cost_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      total_final_cost_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      voucher_id_reversal INTEGER,
      voucher_id_stock INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS sp_offloads_container_idx ON sp_offloads (container_id)`,
  `CREATE INDEX IF NOT EXISTS sp_offloads_company_idx ON sp_offloads (company_id)`,

  `CREATE TABLE IF NOT EXISTS sp_offload_charges (
      id SERIAL PRIMARY KEY,
      offload_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      charge_type VARCHAR(50) NOT NULL,
      description TEXT,
      amount_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      prepaid_charge_id INTEGER,
      credit_ledger_account_id INTEGER,
      credit_bank_account_id INTEGER
    )`,
  `CREATE INDEX IF NOT EXISTS sp_offload_charges_offload_idx ON sp_offload_charges (offload_id)`,

  `CREATE TABLE IF NOT EXISTS sp_stock_movements (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      container_id INTEGER NOT NULL,
      offload_id INTEGER NOT NULL,
      container_line_id INTEGER NOT NULL,
      article_code VARCHAR(100) NOT NULL,
      description TEXT,
      stock_item_id INTEGER,
      location_id INTEGER,
      qty_in DECIMAL(15,4) NOT NULL DEFAULT 0,
      qty_remaining DECIMAL(15,4) NOT NULL DEFAULT 0,
      base_unit_cost_usd DECIMAL(20,6) NOT NULL DEFAULT 0,
      landed_unit_cost_usd DECIMAL(20,6) NOT NULL DEFAULT 0,
      final_unit_cost_usd DECIMAL(20,6) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS sp_stock_movements_company_idx ON sp_stock_movements (company_id)`,
  `CREATE INDEX IF NOT EXISTS sp_stock_movements_container_idx ON sp_stock_movements (container_id)`,

  // Phase 2: make FK columns nullable (opening stock has no container/offload)
  `ALTER TABLE sp_stock_movements ALTER COLUMN container_id DROP NOT NULL`,
  `ALTER TABLE sp_stock_movements ALTER COLUMN offload_id DROP NOT NULL`,
  `ALTER TABLE sp_stock_movements ALTER COLUMN container_line_id DROP NOT NULL`,
  `ALTER TABLE sp_stock_movements ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'offload'`,

  // P5-C/D: Add container_number + freight_estimate to sp_containers; prepaid_date + optional container to sp_prepaid_charges
  `ALTER TABLE sp_containers ADD COLUMN IF NOT EXISTS container_number VARCHAR(100)`,
  `ALTER TABLE sp_containers ADD COLUMN IF NOT EXISTS freight_estimate_usd DECIMAL(20,4) DEFAULT 0`,
  `ALTER TABLE sp_prepaid_charges ADD COLUMN IF NOT EXISTS prepaid_date DATE`,
  `DO $$ BEGIN ALTER TABLE sp_prepaid_charges ALTER COLUMN container_id DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END $$`,
  `ALTER TABLE sp_containers ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id)`,

  `CREATE TABLE IF NOT EXISTS sp_sales (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      sale_date DATE NOT NULL,
      customer_name TEXT NOT NULL,
      total_sale_price_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      total_base_cost_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      total_final_cost_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      gross_profit_usd DECIMAL(20,4) NOT NULL DEFAULT 0,
      voucher_id INTEGER,
      status VARCHAR(20) NOT NULL DEFAULT 'posted',
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS sp_sales_company_idx ON sp_sales (company_id)`,

  `CREATE TABLE IF NOT EXISTS sp_sale_lines (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      movement_id INTEGER NOT NULL,
      article_code VARCHAR(100) NOT NULL,
      description TEXT,
      stock_item_id INTEGER,
      qty_sold DECIMAL(15,4) NOT NULL DEFAULT 0,
      sale_price_per_unit DECIMAL(20,4) NOT NULL DEFAULT 0,
      base_unit_cost_usd DECIMAL(20,6) NOT NULL DEFAULT 0,
      landed_unit_cost_usd DECIMAL(20,6) NOT NULL DEFAULT 0,
      final_unit_cost_usd DECIMAL(20,6) NOT NULL DEFAULT 0
    )`,
  `CREATE INDEX IF NOT EXISTS sp_sale_lines_sale_idx ON sp_sale_lines (sale_id)`,

  `CREATE TABLE IF NOT EXISTS sp_profit_splits (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      period_month VARCHAR(7) NOT NULL,
      total_revenue DECIMAL(20,4) NOT NULL DEFAULT 0,
      total_cogs DECIMAL(20,4) NOT NULL DEFAULT 0,
      total_shared_charges DECIMAL(20,4) NOT NULL DEFAULT 0,
      gross_profit DECIMAL(20,4) NOT NULL DEFAULT 0,
      split_pct DECIMAL(8,4) NOT NULL DEFAULT 50,
      our_share DECIMAL(20,4) NOT NULL DEFAULT 0,
      supplier_share DECIMAL(20,4) NOT NULL DEFAULT 0,
      finalized_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sp_profit_splits_company_month_unique ON sp_profit_splits (company_id, period_month)`,

  // Phase 4: Migration rehearsal tooling
  `CREATE TABLE IF NOT EXISTS sp_migration_rehearsal_runs (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      source_company_id integer NOT NULL,
      target_company_id integer NOT NULL,
      action varchar(20) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      created_at timestamp NOT NULL DEFAULT now(),
      completed_at timestamp,
      rows_created integer DEFAULT 0,
      error_message text,
      notes text
    )`,
  `CREATE INDEX IF NOT EXISTS sp_migration_runs_target_idx ON sp_migration_rehearsal_runs (target_company_id)`,
  `CREATE TABLE IF NOT EXISTS sp_migration_run_rows (
      id serial PRIMARY KEY,
      run_id uuid NOT NULL,
      table_name varchar(100) NOT NULL,
      row_id integer NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS sp_migration_run_rows_run_idx ON sp_migration_run_rows (run_id)`,
  // Source→target provenance links for GC migration (stock items, groups, etc.)
  `CREATE TABLE IF NOT EXISTS sp_migration_source_links (
      id serial PRIMARY KEY,
      run_id uuid,
      source_table varchar(100) NOT NULL,
      source_id integer NOT NULL,
      target_table varchar(100) NOT NULL,
      target_id integer NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS sp_migration_source_links_lookup_idx ON sp_migration_source_links (source_table, source_id, target_table)`,

  // ── Property Contracts/Payments: currency + exchange rate columns (May 2026) ──
  `ALTER TABLE property_contracts ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'`,
  `ALTER TABLE property_payments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'`,
  `ALTER TABLE property_payments ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20,6) NOT NULL DEFAULT 1`,

  // ── Property Contracts: linked_company_id for cross-company read-only view (May 2026) ──
  `ALTER TABLE property_contracts ADD COLUMN IF NOT EXISTS linked_company_id INTEGER`,
  `DO $$ BEGIN ALTER TABLE property_contracts ADD CONSTRAINT property_contracts_linked_company_id_fkey FOREIGN KEY (linked_company_id) REFERENCES companies(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // ── ERP Rent Accrual: track which ledger rows have had a journal accrual posted ──
  `ALTER TABLE property_monthly_ledger ADD COLUMN IF NOT EXISTS accrual_voucher_id INTEGER`,

  // ── Ledger accounts: unique active name per company. A boot-time step here
  //    used to merge duplicate (company_id, name) rows by re-pointing
  //    voucher_entries and hard-deleting the duplicates on every boot. It was
  //    retired (2026-10 accounting audit): it re-assigned posted history, merged
  //    accounts of different types, and left other references dangling. The
  //    index below now prevents duplicates; production had none left.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_accounts_company_name_active
     ON ledger_accounts (company_id, name)
     WHERE deleted_at IS NULL`,

  // ── Ground Scan — shared server-side session (May 2026) ──────────────────
  `CREATE TABLE IF NOT EXISTS factory_ground_scan_items (
      id                  serial PRIMARY KEY,
      company_id          text NOT NULL,
      location_id         integer,
      reference_number    text NOT NULL,
      article_code        text,
      product_name        text,
      weight_kg           numeric(12,3),
      status              text,
      is_in_loading_order boolean NOT NULL DEFAULT false,
      scanned_at          timestamptz NOT NULL DEFAULT now(),
      scanned_by_user_id  text,
      UNIQUE (company_id, location_id, reference_number)
    )`,
  `CREATE INDEX IF NOT EXISTS factory_ground_scan_items_company_loc_idx ON factory_ground_scan_items (company_id, location_id)`,

  // ── Daily Bale Scan — production day verification log (May 2026) ──────────
  `CREATE TABLE IF NOT EXISTS factory_daily_bale_scans (
      id                  serial PRIMARY KEY,
      company_id          text NOT NULL,
      scan_date           date NOT NULL,
      reference_number    text NOT NULL,
      article_code        text,
      product_name        text,
      weight_kg           numeric(12,3),
      scanned_at          timestamptz NOT NULL DEFAULT now(),
      scanned_by_user_id  text,
      UNIQUE (company_id, scan_date, reference_number)
    )`,
  `CREATE INDEX IF NOT EXISTS factory_daily_bale_scans_company_date_idx ON factory_daily_bale_scans (company_id, scan_date)`,
  `CREATE TABLE IF NOT EXISTS customer_price_lists (
      id          serial PRIMARY KEY,
      company_id  integer NOT NULL,
      customer_id integer NOT NULL,
      article_code text NOT NULL,
      price_per_bale numeric(20,4) NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, customer_id, article_code)
    )`,
  `CREATE INDEX IF NOT EXISTS customer_price_lists_customer_idx ON customer_price_lists (company_id, customer_id)`,

  // ── Fix factory container FK constraints (May 2026) ──────────────────────
  // All factory_* tables had container_id wrongly pointing at the ERP
  // "containers" table.  Factory containers are an independent entity stored
  // in "factory_containers".  Drop each wrong FK and replace it with the
  // correct one.  All statements are idempotent (DROP IF EXISTS, ADD with a
  // named constraint that won't duplicate because the old name is gone).
  `ALTER TABLE factory_container_commissions DROP CONSTRAINT IF EXISTS factory_container_commissions_container_id_fkey`,
  `ALTER TABLE factory_container_commissions ADD CONSTRAINT factory_container_commissions_container_id_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE RESTRICT`,
  `ALTER TABLE factory_container_other_charges DROP CONSTRAINT IF EXISTS factory_container_other_charges_container_id_fkey`,
  `ALTER TABLE factory_container_other_charges ADD CONSTRAINT factory_container_other_charges_container_id_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE CASCADE`,
  `ALTER TABLE factory_container_profit_snapshots DROP CONSTRAINT IF EXISTS factory_container_profit_snapshots_container_id_fkey`,
  `ALTER TABLE factory_container_profit_snapshots ADD CONSTRAINT factory_container_profit_snapshots_container_id_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE CASCADE`,
  `ALTER TABLE factory_duty_audit_log DROP CONSTRAINT IF EXISTS factory_duty_audit_log_container_id_fkey`,
  `ALTER TABLE factory_duty_audit_log ADD CONSTRAINT factory_duty_audit_log_container_id_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE RESTRICT`,
  `ALTER TABLE factory_fx_allocations DROP CONSTRAINT IF EXISTS factory_fx_allocations_container_id_fkey`,
  `ALTER TABLE factory_fx_allocations ADD CONSTRAINT factory_fx_allocations_container_id_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE RESTRICT`,
  `ALTER TABLE factory_mix_batch_sources DROP CONSTRAINT IF EXISTS factory_mix_batch_sources_container_id_fkey`,
  `ALTER TABLE factory_mix_batch_sources ADD CONSTRAINT factory_mix_batch_sources_container_id_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE RESTRICT`,
  `ALTER TABLE factory_offload_additional_charges DROP CONSTRAINT IF EXISTS factory_offload_additional_charges_container_id_fkey`,
  `ALTER TABLE factory_offload_additional_charges ADD CONSTRAINT factory_offload_additional_charges_container_id_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE CASCADE`,
  `ALTER TABLE factory_raw_stock DROP CONSTRAINT IF EXISTS factory_raw_stock_container_id_fkey`,
  `ALTER TABLE factory_raw_stock ADD CONSTRAINT factory_raw_stock_container_id_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE RESTRICT`,
  `ALTER TABLE factory_waste_entries DROP CONSTRAINT IF EXISTS factory_waste_entries_container_id_fkey`,
  `ALTER TABLE factory_waste_entries ADD CONSTRAINT factory_waste_entries_container_id_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE RESTRICT`,
  // ── PO freight paid-by own account (May 2026) ─────────────────────────
  `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS freight_paid_by TEXT DEFAULT 'supplier'`,
  `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS freight_own_account_id INTEGER`,
  // ── PO freight paid-by parent company account (May 2026) ──────────────
  `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS freight_parent_account_id INTEGER`,
  // ── Factory container auto-tracking (May 2026) ────────────────────────
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_enabled BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_auto_update BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_provider TEXT`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_last_status TEXT`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_last_location TEXT`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_last_checked_at TIMESTAMPTZ`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_last_event_date TIMESTAMPTZ`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_last_description TEXT`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_error TEXT`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_changed_at TIMESTAMPTZ`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_detected_carrier TEXT`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_next_check_at TIMESTAMPTZ`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_last_skip_reason TEXT`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS tracking_carrier_hint TEXT`,
  `ALTER TABLE factory_containers ALTER COLUMN tracking_enabled SET DEFAULT false`,
  `ALTER TABLE factory_containers ALTER COLUMN tracking_auto_update SET DEFAULT false`,
  `UPDATE factory_containers
      SET tracking_enabled = false,
          tracking_auto_update = false
    WHERE tracking_enabled = true OR tracking_auto_update = true`,
  `CREATE TABLE IF NOT EXISTS factory_container_tracking_events (
      id SERIAL PRIMARY KEY,
      container_id INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'parcelsapp',
      event_time TIMESTAMPTZ,
      event_status TEXT,
      event_location TEXT,
      event_description TEXT,
      raw_event_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fcte_dedup_unique ON factory_container_tracking_events (container_id, event_time, event_status)`,
  `CREATE TABLE IF NOT EXISTS factory_container_tracking_checks (
      id SERIAL PRIMARY KEY,
      container_id INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'parcelsapp',
      status TEXT NOT NULL,
      checked_at TIMESTAMPTZ NOT NULL,
      error_message TEXT,
      raw_response_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

  // ── Performance indexes (May 2026) ────────────────────────────────────────
  // voucher_entries: supplier/employee/bank lookups do full table scans without these.
  // Used by ledger statement queries that filter entries by a specific supplier or employee.
  `CREATE INDEX IF NOT EXISTS voucher_entries_supplier_idx ON voucher_entries(supplier_id)`,
  `CREATE INDEX IF NOT EXISTS voucher_entries_employee_idx ON voucher_entries(employee_id)`,
  `CREATE INDEX IF NOT EXISTS voucher_entries_bank_account_idx ON voucher_entries(bank_account_id)`,
  `CREATE INDEX IF NOT EXISTS voucher_entries_factory_supplier_idx ON voucher_entries(factory_supplier_id)`,

  // suppliers: no indexes at all — every getAllSuppliers() call is a full table scan.
  // A partial index on deleted_at covers the common WHERE deleted_at IS NULL filter.
  `CREATE INDEX IF NOT EXISTS suppliers_deleted_at_idx ON suppliers(deleted_at)`,
  `CREATE INDEX IF NOT EXISTS suppliers_active_idx ON suppliers(active)`,

  // audit_log: no indexes exist at all; any lookup (by company, user, or date) is a seq scan.
  `CREATE INDEX IF NOT EXISTS audit_log_company_idx ON audit_log(company_id)`,
  `CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log(user_id)`,
  `CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at)`,

  // customer_orders: date-range reports filter by (companyId, orderDate) with no index.
  `CREATE INDEX IF NOT EXISTS customer_orders_company_date_idx ON customer_orders(company_id, order_date)`,

  // stock_items: grade/category filters have no index; stockGroupId is already covered.
  `CREATE INDEX IF NOT EXISTS stock_items_grade_idx ON stock_items(company_id, grade_id)`,
  `CREATE INDEX IF NOT EXISTS stock_items_category_idx ON stock_items(company_id, category_id)`,

  // ── AI action log — new columns (May 2026) ────────────────────────────────
  // actionName: specific action identifier ('chat_message', 'stock_transfer', etc.)
  // inputJson / outputJson: structured request/response snapshots for audit trails
  `ALTER TABLE ai_action_log ADD COLUMN IF NOT EXISTS action_name varchar(120)`,
  `ALTER TABLE ai_action_log ADD COLUMN IF NOT EXISTS input_json jsonb`,
  `ALTER TABLE ai_action_log ADD COLUMN IF NOT EXISTS output_json jsonb`,

  // ── AI Excel Import staging tables (May 2026) ─────────────────────────────
  `CREATE TABLE IF NOT EXISTS ai_import_jobs (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      user_id varchar NOT NULL,
      import_type text NOT NULL,
      original_file_name text,
      status text NOT NULL DEFAULT 'uploaded',
      total_rows integer DEFAULT 0,
      valid_rows integer DEFAULT 0,
      warning_rows integer DEFAULT 0,
      error_rows integer DEFAULT 0,
      confirmed_at timestamp,
      posted_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS ai_import_jobs_company_idx ON ai_import_jobs(company_id)`,
  `CREATE INDEX IF NOT EXISTS ai_import_jobs_user_idx ON ai_import_jobs(user_id)`,
  `CREATE TABLE IF NOT EXISTS ai_import_rows (
      id serial PRIMARY KEY,
      job_id integer NOT NULL,
      row_number integer NOT NULL,
      raw_data jsonb NOT NULL,
      mapped_data jsonb,
      status text NOT NULL DEFAULT 'pending',
      errors jsonb DEFAULT '[]',
      warnings jsonb DEFAULT '[]',
      created_record_type text,
      created_record_id integer,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS ai_import_rows_job_idx ON ai_import_rows(job_id)`,

  // ── AI Correction Memory (May 2026) ───────────────────────────────────────
  // Stores user-confirmed entity resolution corrections for the AI import flow.
  // Exact rawValue matches (confidence=100) are auto-applied during validation;
  // low-confidence entries are surfaced as suggestions only.
  `CREATE TABLE IF NOT EXISTS ai_correction_memory (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      memory_type varchar(40) NOT NULL,
      raw_value text NOT NULL,
      resolved_type text,
      resolved_id integer,
      resolved_value text,
      confidence integer NOT NULL DEFAULT 100,
      created_by varchar NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS ai_correction_memory_company_idx ON ai_correction_memory(company_id)`,
  `CREATE INDEX IF NOT EXISTS ai_correction_memory_lookup_idx ON ai_correction_memory(company_id, memory_type)`,

  // AI company snapshots — precomputed summaries with TTL for chatbot
  `CREATE TABLE IF NOT EXISTS ai_company_snapshots (
      id            serial PRIMARY KEY,
      company_id    integer NOT NULL,
      snapshot_type varchar(60) NOT NULL,
      data          jsonb NOT NULL DEFAULT '{}',
      calculated_at timestamp NOT NULL DEFAULT now(),
      expires_at    timestamp NOT NULL
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ai_snapshots_company_type_unique ON ai_company_snapshots(company_id, snapshot_type)`,
  `CREATE INDEX IF NOT EXISTS ai_snapshots_expires_idx ON ai_company_snapshots(expires_at)`,

  // AI Agent Tasks — Command Center orchestration tasks
  `CREATE TABLE IF NOT EXISTS ai_agent_tasks (
      id               serial PRIMARY KEY,
      company_id       integer NOT NULL,
      user_id          varchar(100) NOT NULL,
      task_type        varchar(80) NOT NULL DEFAULT 'general',
      user_instruction text NOT NULL,
      status           varchar(30) NOT NULL DEFAULT 'planned',
      plan_json        jsonb,
      result_json      jsonb,
      error_message    text,
      created_at       timestamp NOT NULL DEFAULT now(),
      updated_at       timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS ai_agent_tasks_company_idx ON ai_agent_tasks(company_id)`,
  `CREATE INDEX IF NOT EXISTS ai_agent_tasks_status_idx ON ai_agent_tasks(status)`,

  // AI Agent Approvals — gated write actions requiring user sign-off
  `CREATE TABLE IF NOT EXISTS ai_agent_approvals (
      id           serial PRIMARY KEY,
      task_id      integer NOT NULL,
      company_id   integer NOT NULL,
      user_id      varchar(100) NOT NULL,
      action_type  varchar(80) NOT NULL,
      action_label text NOT NULL,
      payload_json jsonb,
      preview_json jsonb,
      status       varchar(30) NOT NULL DEFAULT 'pending',
      approved_by  varchar(100),
      approved_at  timestamp,
      posted_at    timestamp,
      created_at   timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS ai_agent_approvals_task_idx    ON ai_agent_approvals(task_id)`,
  `CREATE INDEX IF NOT EXISTS ai_agent_approvals_company_idx ON ai_agent_approvals(company_id)`,

  // ── SP ↔ HADI L'SHI Intercompany feature (May 2026) ──────────────────────
  // Add parent_company_id to companies so SP companies know their parent.
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS parent_company_id integer`,
  // SP Test Co (id=14) parent is HADI L'SHI (id=1)
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'sp-parent-company-id-v1') THEN
        UPDATE companies SET parent_company_id = 1 WHERE id = 14 AND parent_company_id IS NULL;
        INSERT INTO migrations_log(key) VALUES ('sp-parent-company-id-v1');
      END IF;
    END $$`,

  // Prepaid Expenses account in SP Test Co — opening $21,300 Dr
  `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side, active, is_hidden)
     SELECT 14, 'SP-PREEXP', 'Prepaid Expenses', 'Asset', 'sp_prepaid_expenses', 21300, 'Dr', true, false
     WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE company_id = 14 AND code = 'SP-PREEXP')
       AND EXISTS (SELECT 1 FROM companies WHERE id = 14)`,

  // HADI L'SHI — Intercompany tracking account in SP Test Co
  `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active, is_hidden)
     SELECT 14, 'SP-HADI-IC', 'HADI L''SHI — Intercompany', 'Intercompany', 'sp_hadi_intercompany', true, false
     WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE company_id = 14 AND code = 'SP-HADI-IC')
       AND EXISTS (SELECT 1 FROM companies WHERE id = 14)`,

  // SP Test Co — Intercompany tracking account in HADI L'SHI (company_id=1)
  `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active, is_hidden)
     SELECT 1, 'SP-IC', 'SP Test Co — Intercompany', 'Intercompany', 'hadi_sp_intercompany', true, false
     WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE company_id = 1 AND code = 'SP-IC')
       AND EXISTS (SELECT 1 FROM companies WHERE id = 1)`,

  // ── SP: Hide "Stock on Floor" (sp_stock) from normal Accounts UI (May 2026) ──
  // sp_stock is an internal double-entry counterpart to the inventory table.
  // It is NOT a normal postable ledger account; showing it alongside user accounts
  // causes confusion and apparent double-counting. isHidden=true removes it from
  // the Accounts page and voucher dropdowns while preserving all ledger history.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'sp-stock-ledger-hidden-v1') THEN
        UPDATE ledger_accounts SET is_hidden = true WHERE sub_type = 'sp_stock' AND is_hidden = false;
        INSERT INTO migrations_log(key) VALUES ('sp-stock-ledger-hidden-v1');
      END IF;
    END $$`,

  // SP: per-location supplier payable deduction per qty (silent payable reduction, not income/expense)
  `ALTER TABLE locations ADD COLUMN IF NOT EXISTS supplier_partner_payable_deduction_per_qty DECIMAL(20,4) NOT NULL DEFAULT 0`,

  // Intercompany POS: allow skipping the source voucher so SP Net Position is unaffected
  `ALTER TABLE intercompany_pos_configs ADD COLUMN IF NOT EXISTS skip_source_voucher boolean NOT NULL DEFAULT false`,

  // SP POS realized-profit fresh-start date. NULL preserves the legacy
  // all-time calculation for companies that have not configured one.
  `ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS sp_pos_profit_baseline_date date`,

  // Employee attendance: add missing unique constraint so ON CONFLICT works
  `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'employee_attendance'::regclass AND conname = 'employee_attendance_unique'
      ) THEN
        ALTER TABLE employee_attendance ADD CONSTRAINT employee_attendance_unique UNIQUE (employee_id, attendance_date);
      END IF;
    END $$;`,

  // SP: seed hidden "Supplier Payable Deduction Clearing" account for all existing SP companies
  `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active, is_hidden)
     SELECT c.id, 'SP-PAYDDC', 'Supplier Payable Deduction Clearing', 'Liability', 'sp_pay_deduction_clearing', true, true
     FROM companies c
     WHERE c.company_type = 'supplier_partner'
     AND NOT EXISTS (SELECT 1 FROM ledger_accounts la WHERE la.company_id = c.id AND la.code = 'SP-PAYDDC')`,
];
