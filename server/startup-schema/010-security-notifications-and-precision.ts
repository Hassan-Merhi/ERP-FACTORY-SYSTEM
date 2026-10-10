/**
 * Startup schema migrations - Security and control phase tables, code patch history, intercompany payment notifications, the notifications centre, the factory locked raw-material rate backfill, and the decimal precision alignment.
 *
 * Part of the ordered `startupMigrations` array assembled in ./index.ts.
 * Statement order is load-bearing: these run sequentially at boot, so entries
 * must never be reordered or moved between parts.
 */
import {
  FACTORY_SUPPLIER_LOCKED_RATE_ADD_COLUMN_SQL,
  FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_MIGRATION_KEY,
  FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL,
} from "../services/factory/rawStockLockedRate";

import { factorySheetsSacksSchema } from "../startup/factorySheetsSacksSchema";

export const securityNotificationsAndPrecision: string[] = [
  // ── Security / Control Phase Tables (May 2026) ─────────────────────────────
  // Phase 2: Human-in-the-loop approval requests
  `CREATE TABLE IF NOT EXISTS approval_requests (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      requested_by_user_id varchar(100) NOT NULL,
      requested_by_username text NOT NULL,
      action_type text NOT NULL,
      target_table text,
      target_record_id integer,
      target_identifier text,
      payload jsonb,
      old_value jsonb,
      new_value jsonb,
      amount_value numeric(20,2),
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamp NOT NULL DEFAULT now(),
      reviewed_by_user_id varchar(100),
      reviewed_by_username text,
      reviewed_at timestamp,
      reviewer_note text,
      executed_at timestamp
    )`,
  `CREATE INDEX IF NOT EXISTS approval_requests_company_idx ON approval_requests(company_id)`,
  `CREATE INDEX IF NOT EXISTS approval_requests_status_idx  ON approval_requests(status)`,

  // Phase 3: Automated business alert checks
  `CREATE TABLE IF NOT EXISTS business_alerts (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      alert_type text NOT NULL,
      severity text NOT NULL DEFAULT 'warning',
      title text NOT NULL,
      message text NOT NULL,
      target_table text,
      target_record_id integer,
      status text NOT NULL DEFAULT 'open',
      created_at timestamp NOT NULL DEFAULT now(),
      resolved_at timestamp,
      dismissed_by varchar(100),
      metadata jsonb
    )`,
  `CREATE INDEX IF NOT EXISTS business_alerts_company_idx ON business_alerts(company_id)`,
  `CREATE INDEX IF NOT EXISTS business_alerts_status_idx  ON business_alerts(status)`,

  // Phase 4: Import batch audit trail
  `CREATE TABLE IF NOT EXISTS import_batches (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      import_type text NOT NULL,
      file_name text NOT NULL,
      file_size integer,
      uploaded_by_user_id varchar(100) NOT NULL,
      uploaded_by_username text NOT NULL,
      status text NOT NULL DEFAULT 'applied',
      total_rows integer NOT NULL DEFAULT 0,
      valid_rows integer NOT NULL DEFAULT 0,
      invalid_rows integer NOT NULL DEFAULT 0,
      created_records jsonb,
      updated_records jsonb,
      error_summary jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      applied_at timestamp,
      rolled_back_at timestamp
    )`,
  `CREATE INDEX IF NOT EXISTS import_batches_company_idx ON import_batches(company_id)`,
  // label_design_colors — dynamic banner color registry seeded with 5 defaults
  `CREATE TABLE IF NOT EXISTS label_design_colors (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      label text NOT NULL,
      color_hex text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `INSERT INTO label_design_colors (slug, label, color_hex, sort_order, is_default) VALUES
       ('purple', 'Purple (#1)',   '#5B21B6', 1, true),
       ('green',  'Green (#2)',    '#047857', 2, true),
       ('gold',   'Gold (#3)',     '#B8860B', 3, true),
       ('white',  'White (#4)',    '#F5F5F5', 4, true),
       ('red',    'HMD Intl (#5)', '#B91C1C', 5, true)
     ON CONFLICT (slug) DO NOTHING`,
  // label_design_colors — add image storage columns (DB-backed, survives restarts)
  `ALTER TABLE label_design_colors ADD COLUMN IF NOT EXISTS image_data text`,
  `ALTER TABLE label_design_colors ADD COLUMN IF NOT EXISTS image_updated_at timestamp`,
  `CREATE TABLE IF NOT EXISTS passkey_credentials (
      id            SERIAL PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key    TEXT NOT NULL,
      counter       BIGINT NOT NULL DEFAULT 0,
      device_name   TEXT,
      transports    TEXT NOT NULL DEFAULT '[]',
      created_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
  `CREATE INDEX IF NOT EXISTS passkey_credentials_user_id_idx ON passkey_credentials(user_id)`,

  // ── Performance indexes (Jun 2026) — three high-traffic tables missing company_id / FK indexes ──
  // factory_bales: every page-load on the factory module runs WHERE company_id=? [AND status=?]
  // ORDER BY created_at DESC with no index → full sequential scan on a large table.
  `CREATE INDEX IF NOT EXISTS factory_bales_company_status_date_idx
       ON factory_bales (company_id, status, created_at DESC)`,
  // factory_bales: finalized_by is used in worker stats / UPDATE joins; no index existed.
  `CREATE INDEX IF NOT EXISTS factory_bales_finalized_by_idx ON factory_bales(finalized_by)`,
  // bale_label_prints: print-history look-up uses inArray(production_bale_id, [...])
  // with no index → sequential scan of the full prints table for every bale page-load.
  `CREATE INDEX IF NOT EXISTS bale_label_prints_production_bale_idx
       ON bale_label_prints (production_bale_id)`,
  // customers: list endpoint filters WHERE company_id=? AND deleted_at IS NULL.
  // The existing unique index is on (company_id, code) — works for prefix scans but
  // a dedicated partial index on company_id WHERE deleted_at IS NULL is much tighter.
  `CREATE INDEX IF NOT EXISTS customers_company_active_idx
       ON customers (company_id) WHERE deleted_at IS NULL`,
  // Increase factory_containers rate_per_kg / rate_per_kg_usd precision to 7 decimal places
  `ALTER TABLE factory_containers ALTER COLUMN rate_per_kg TYPE DECIMAL(20,7)`,
  `ALTER TABLE factory_containers ALTER COLUMN rate_per_kg_usd TYPE DECIMAL(20,7)`,
  // ── Code Patch History table (AI coding agent) ──────────────────────────
  `CREATE TABLE IF NOT EXISTS code_patch_history (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER NOT NULL,
      file_path         TEXT NOT NULL,
      description       TEXT,
      original_content  TEXT,
      new_content       TEXT,
      applied_by_user_id TEXT,
      applied_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      commit_hash       TEXT,
      reverted_at       TIMESTAMP
    )`,
  `CREATE INDEX IF NOT EXISTS code_patch_history_company_idx ON code_patch_history (company_id)`,
  // Clean up orphaned factory daybook/voucher entries for soft-deleted receipts, adjustments, and containers
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'orphan-factory-daybook-cleanup-v1') THEN
        -- Orphaned OFFLOAD_RAW_STOCK daybook entries for soft-deleted raw stock receipts
        DELETE FROM factory_daybook_entries
          WHERE tx_type = 'OFFLOAD_RAW_STOCK'
            AND reference_id IN (SELECT id FROM factory_raw_stock WHERE deleted_at IS NOT NULL);
        -- Orphaned OFFLOAD_RAW_STOCK daybook entries for soft-deleted adjustments
        DELETE FROM factory_daybook_entries
          WHERE tx_type = 'OFFLOAD_RAW_STOCK'
            AND reference_id IN (SELECT id FROM factory_raw_material_adjustments WHERE deleted_at IS NOT NULL);
        -- Wave 16 (A): the vouchers of soft-deleted adjustments and containers are no
        -- longer hard-deleted here (posted history, no audit); only the daybook mirror is.
        -- Orphaned factory daybook entries for soft-deleted containers
        DELETE FROM factory_daybook_entries
          WHERE tx_type IN ('FREIGHT','OTHER_CHARGE','DUTY','CONTAINER_IMPORT','PURCHASE')
            AND reference_id IN (SELECT id FROM factory_containers WHERE deleted_at IS NOT NULL);
        INSERT INTO migrations_log(key) VALUES ('orphan-factory-daybook-cleanup-v1');
      END IF;
    END $$`,
  // Factory worker deductions — pending deductions applied at payroll time
  `CREATE TABLE IF NOT EXISTS factory_worker_deductions (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      worker_id integer NOT NULL REFERENCES factory_workers(id),
      amount decimal(20, 2) NOT NULL,
      reason text,
      deduction_date date NOT NULL,
      applied boolean NOT NULL DEFAULT false,
      payroll_id integer,
      erp_payroll_run_id integer,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS factory_worker_deductions_company_idx ON factory_worker_deductions (company_id)`,
  `CREATE INDEX IF NOT EXISTS factory_worker_deductions_worker_idx ON factory_worker_deductions (worker_id)`,
  `ALTER TABLE factory_worker_deductions ADD COLUMN IF NOT EXISTS payroll_id integer`,
  `ALTER TABLE factory_worker_deductions ADD COLUMN IF NOT EXISTS erp_payroll_run_id integer`,
  `CREATE TABLE IF NOT EXISTS supplier_profit_po_overrides (
      id serial PRIMARY KEY,
      supplier_id integer NOT NULL,
      stock_item_id integer NOT NULL,
      po_price decimal(20,4) NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS supplier_profit_po_overrides_uniq ON supplier_profit_po_overrides (supplier_id, stock_item_id)`,
  `ALTER TABLE supplier_profit_po_overrides ALTER COLUMN po_price DROP NOT NULL`,
  `ALTER TABLE supplier_profit_po_overrides ADD COLUMN IF NOT EXISTS avg_price decimal(20,4)`,
  // ── Intercompany Payment Notification & Approval ─────────────────────────
  `CREATE TABLE IF NOT EXISTS intercompany_account_links (
      id serial PRIMARY KEY,
      label text,
      source_company_id integer NOT NULL,
      source_ledger_account_id integer NOT NULL,
      dest_company_id integer NOT NULL,
      dest_ledger_account_id integer NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS intercompany_link_recipients (
      id serial PRIMARY KEY,
      link_id integer NOT NULL REFERENCES intercompany_account_links(id) ON DELETE CASCADE,
      user_id varchar NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS intercompany_link_recipients_uniq ON intercompany_link_recipients (link_id, user_id)`,
  `CREATE TABLE IF NOT EXISTS intercompany_payment_requests (
      id serial PRIMARY KEY,
      link_id integer NOT NULL,
      from_company_id integer NOT NULL,
      from_voucher_id integer NOT NULL,
      from_voucher_number text NOT NULL,
      from_voucher_date date NOT NULL,
      amount decimal(20,2) NOT NULL,
      description text,
      status text NOT NULL DEFAULT 'pending',
      dest_ledger_account_id integer,
      dest_voucher_id integer,
      approved_by_user_id varchar,
      approved_at timestamp,
      dismiss_note text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS intercompany_payment_requests_status_idx ON intercompany_payment_requests(status)`,
  `CREATE INDEX IF NOT EXISTS intercompany_payment_requests_link_idx ON intercompany_payment_requests(link_id)`,
  // Backfill po_line_items stock_item_id after stock item merges (two-pass)
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'po-line-items-stock-merge-backfill-v1') THEN
        -- Pass 1: re-point using stock_item_merge_logs (logged merges)
        UPDATE po_line_items pli
          SET stock_item_id = sml.kept_item_id,
              item_name     = si.name
          FROM stock_item_merge_logs sml
          JOIN stock_items si ON si.id = sml.kept_item_id AND si.deleted_at IS NULL
         WHERE pli.stock_item_id = sml.merged_item_id;
        -- Pass 2: re-point using alias breadcrumbs for historical merges predating merge_logs
        UPDATE po_line_items pli
          SET stock_item_id = a.stock_item_id,
              item_name     = si_kept.name
          FROM stock_item_code_aliases a
          JOIN stock_items si_merged ON si_merged.code = a.alias_code
                                    AND si_merged.active = false
          JOIN stock_items si_kept   ON si_kept.id = a.stock_item_id
                                    AND si_kept.deleted_at IS NULL
         WHERE a.description LIKE 'Merged from:%'
           AND pli.stock_item_id = si_merged.id;
        INSERT INTO migrations_log(key) VALUES ('po-line-items-stock-merge-backfill-v1');
      END IF;
    END $$`,

  // Make the stock_items (company_id, code) unique index partial so that
  // soft-deleted items don't block re-use of the same code in the same company.
  // Previously the index covered ALL rows, causing a PG unique-constraint error
  // when a user tried to create an item whose code matched a deleted record.
  // Idempotent: drops the old full index only if it is NOT already partial,
  // then creates the partial index if missing.
  `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'stock_items'
      AND indexname  = 'stock_items_company_code_unique'
      AND indexdef   NOT LIKE '%WHERE%'
  ) THEN
    DROP INDEX stock_items_company_code_unique;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'stock_items'
      AND indexname  = 'stock_items_company_code_unique'
  ) THEN
    CREATE UNIQUE INDEX stock_items_company_code_unique
      ON stock_items (company_id, code)
      WHERE deleted_at IS NULL;
  END IF;
END $$`,
  // ── Prepaid rent accounting: track which ledger rows used Prepaid/Deferred accounts ──
  `ALTER TABLE property_monthly_ledger ADD COLUMN IF NOT EXISTS used_prepaid_account boolean NOT NULL DEFAULT false`,
  `ALTER TABLE property_monthly_ledger ADD COLUMN IF NOT EXISTS used_advance_account boolean NOT NULL DEFAULT false`,
  // ── Rental payment scheduling & posting columns ──────────────────────────
  `ALTER TABLE property_payments ADD COLUMN IF NOT EXISTS posting_status TEXT NOT NULL DEFAULT 'POSTED'`,
  `ALTER TABLE property_payments ADD COLUMN IF NOT EXISTS payment_group_id TEXT`,
  `ALTER TABLE property_payments ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP`,
  `CREATE INDEX IF NOT EXISTS property_payments_status_idx ON property_payments (company_id, module, posting_status, payment_date)`,
  `UPDATE property_payments SET posting_status = 'POSTED' WHERE posting_status IS NULL OR posting_status = ''`,
  `UPDATE property_payments SET payment_group_id = 'PG-LEGACY-' || voucher_id::text WHERE payment_group_id IS NULL AND voucher_id IS NOT NULL`,
  // ── Starred proforma for container verification comparison ──
  `ALTER TABLE supplier_proformas ADD COLUMN IF NOT EXISTS is_starred boolean NOT NULL DEFAULT false`,
  // ── Effective Date for factory transactions ──
  `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS effective_date date`,
  `ALTER TABLE factory_daybook_entries ADD COLUMN IF NOT EXISTS effective_date date`,
  // ── POS shift linkage on vouchers ──
  `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS shift_id integer`,
  // ── Voucher columns that were in schema but never had ADD COLUMN migrations ──
  `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS location_name text`,
  `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS exchange_rate numeric(20,6)`,
  `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS source_module text DEFAULT 'ERP'`,
  `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_credit_sale boolean DEFAULT false`,
  // ── stock_item_code_aliases table (schema-only, never migrated) ──
  `CREATE TABLE IF NOT EXISTS stock_item_code_aliases (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      stock_item_id integer NOT NULL,
      alias_code varchar(50) NOT NULL,
      description text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS stock_item_code_aliases_company_alias_unique ON stock_item_code_aliases (company_id, alias_code)`,
  `DO $$ BEGIN ALTER TABLE stock_item_code_aliases ADD CONSTRAINT stock_item_code_aliases_company_id_fkey2 FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE stock_item_code_aliases ADD CONSTRAINT stock_item_code_aliases_stock_item_id_fkey2 FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // ── Notifications Center ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS notifications (
      id serial PRIMARY KEY,
      recipient_user_id varchar NOT NULL,
      event_type text NOT NULL,
      title text NOT NULL,
      message text NOT NULL,
      entity_type text,
      entity_id integer,
      triggered_by_user_id varchar,
      company_id integer,
      is_read boolean NOT NULL DEFAULT false,
      read_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (recipient_user_id, is_read, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS notifications_entity_idx ON notifications (entity_type, entity_id)`,
  `CREATE TABLE IF NOT EXISTS notification_rules (
      id serial PRIMARY KEY,
      event_type text NOT NULL,
      recipient_user_id varchar NOT NULL,
      is_enabled boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS notification_rules_event_user_uniq ON notification_rules (event_type, recipient_user_id)`,
  `CREATE TABLE IF NOT EXISTS transporter_payment_settings (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      ledger_account_id integer NOT NULL,
      payment_terms_days integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT transporter_payment_settings_uniq UNIQUE (company_id, ledger_account_id)
    )`,
  `ALTER TABLE transporter_payment_settings ADD COLUMN IF NOT EXISTS payment_terms_days integer NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS transporter_entry_due_dates (
      id serial PRIMARY KEY,
      voucher_entry_id integer NOT NULL,
      company_id integer NOT NULL,
      due_date date NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT transporter_entry_due_dates_entry_uniq UNIQUE (voucher_entry_id)
    )`,
  `CREATE TABLE IF NOT EXISTS transporter_payment_allocations (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      debit_entry_id integer NOT NULL,
      credit_entry_id integer NOT NULL,
      allocated_amount numeric(15,2) NOT NULL DEFAULT 0,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS transporter_alloc_company_idx ON transporter_payment_allocations (company_id)`,
  `CREATE INDEX IF NOT EXISTS transporter_alloc_credit_idx ON transporter_payment_allocations (credit_entry_id)`,
  `CREATE INDEX IF NOT EXISTS transporter_alloc_debit_idx ON transporter_payment_allocations (debit_entry_id)`,
  `CREATE TABLE IF NOT EXISTS git_agent_notes (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      agent_name text NOT NULL,
      note text NOT NULL DEFAULT '',
      updated_at timestamptz DEFAULT now(),
      UNIQUE (company_id, agent_name)
    )`,
  `CREATE TABLE IF NOT EXISTS git_agent_adjustments (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      agent_name text NOT NULL,
      description text NOT NULL DEFAULT '',
      amount numeric(15,2) NOT NULL,
      type text NOT NULL CHECK (type IN ('debit','credit')),
      created_at timestamptz DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS idx_git_agent_adjustments_lookup
      ON git_agent_adjustments (company_id, agent_name)`,
  `CREATE TABLE IF NOT EXISTS git_prepaid_designations (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      agent_name text NOT NULL,
      container_id integer NOT NULL,
      designated_by varchar(255),
      created_at timestamptz DEFAULT now(),
      UNIQUE (company_id, agent_name, container_id)
    )`,
  `CREATE INDEX IF NOT EXISTS idx_git_prepaid_lookup
      ON git_prepaid_designations (company_id, agent_name)`,
  `CREATE TABLE IF NOT EXISTS git_prepaid_activity_log (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      agent_name text NOT NULL,
      action text NOT NULL,
      old_container_id integer,
      new_container_id integer,
      old_container_number text,
      new_container_number text,
      amount numeric(15,2),
      performed_by varchar(255),
      note text,
      created_at timestamptz DEFAULT now()
    )`,
  // Ensure git_prepaid_designations has the id serial PK (tables created before this migration may not have it)
  `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name='git_prepaid_designations' AND column_name='id'
       ) THEN
         ALTER TABLE git_prepaid_designations ADD COLUMN id serial;
       END IF;
     END $$`,
  // Ensure the UNIQUE constraint exists — required for ON CONFLICT to work
  `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'git_prepaid_designations'::regclass AND contype = 'u'
       ) THEN
         ALTER TABLE git_prepaid_designations
           ADD CONSTRAINT git_prepaid_designations_uniq
           UNIQUE (company_id, agent_name, container_id);
       END IF;
     END $$`,
  // Fix user-id column types — production used UUID strings but columns were integer
  `ALTER TABLE git_prepaid_designations ALTER COLUMN designated_by TYPE varchar(255) USING designated_by::varchar`,
  `ALTER TABLE git_prepaid_activity_log ALTER COLUMN performed_by TYPE varchar(255) USING performed_by::varchar`,
  // Per-kg pricing support on proforma lines (June 2026)
  `ALTER TABLE customer_proforma_lines ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'per_bale'`,
  `ALTER TABLE customer_proforma_lines ADD COLUMN IF NOT EXISTS price_per_kg decimal(20,4)`,
  // Always-run: ensure tracking is enabled on every active (non-offloaded) container.
  // Safe to run on every boot — only touches rows that are still incorrectly false.
  // Uses LOWER() to handle any case variation in status values.
  `UPDATE containers
       SET tracking_enabled = true
       WHERE tracking_enabled = false
         AND LOWER(COALESCE(status,'')) NOT IN ('offloaded','closed','completed')`,
  // One-time backfill: enable tracking on all active containers.
  // Guarded by a marker table so it only runs once — subsequent boots are no-ops.
  // This fixes the historical bug where the drawer defaulted trackEnabled to false,
  // causing every container to be saved with tracking_enabled=false.
  `DO $$
     BEGIN
       CREATE TABLE IF NOT EXISTS one_time_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz DEFAULT now()
       );
       IF NOT EXISTS (SELECT 1 FROM one_time_migrations WHERE name = 'backfill_tracking_enabled_2026') THEN
         UPDATE containers SET tracking_enabled = true WHERE LOWER(status) NOT IN ('offloaded','closed','completed');
         INSERT INTO one_time_migrations (name) VALUES ('backfill_tracking_enabled_2026');
       END IF;
     END $$`,
  // Per-kg pricing on order lines (June 2026)
  `ALTER TABLE customer_order_lines ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'per_bale'`,
  `ALTER TABLE customer_order_lines ADD COLUMN IF NOT EXISTS price_per_kg decimal(20,4)`,
  // Hide individual loadings from the list (June 2026)
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE`,
  // Backfill inventory.company_id from the owning location's company (June 2026).
  // Fixes rows where company_id was never set or became stale after data migrations.
  // Safe: only touches rows where company_id is NULL or mismatched — never changes
  // ownership of a row that already has the correct company_id.
  //
  // Wave 11: a no-op (no UPDATE, no row locks) when nothing is mismatched, which
  // is every boot after the first. Moving a row between companies moves its
  // stock value from one company's books to the other's, so a row whose old or
  // new company has a perpetual-inventory cut-over is never moved silently: it
  // is left as it is and reported with a WARNING (the server log) for review.
  `DO $$
     DECLARE
       pending integer;
       held integer := 0;
       held_value numeric := 0;
       has_cutovers boolean := to_regclass('gl_inventory_cutovers') IS NOT NULL;
     BEGIN
       SELECT COUNT(*) INTO pending
         FROM inventory inv JOIN locations loc ON loc.id = inv.location_id
        WHERE inv.company_id IS NULL OR inv.company_id <> loc.company_id;
       IF pending = 0 THEN
         RETURN;
       END IF;
       IF has_cutovers THEN
         EXECUTE $q$
           SELECT COUNT(*), COALESCE(SUM(inv.total_value), 0)
             FROM inventory inv JOIN locations loc ON loc.id = inv.location_id
            WHERE (inv.company_id IS NULL OR inv.company_id <> loc.company_id)
              AND EXISTS (SELECT 1 FROM gl_inventory_cutovers c
                           WHERE c.company_id = inv.company_id OR c.company_id = loc.company_id)
         $q$ INTO held, held_value;
         IF held > 0 THEN
           RAISE WARNING 'inventory.company_id backfill: % row(s) holding % of stock value belong to a company with a perpetual inventory cut-over and were NOT moved; review them',
             held, held_value;
         END IF;
         EXECUTE $q$
           UPDATE inventory inv
              SET company_id = loc.company_id
             FROM locations loc
            WHERE inv.location_id = loc.id
              AND (inv.company_id IS NULL OR inv.company_id <> loc.company_id)
              AND NOT EXISTS (SELECT 1 FROM gl_inventory_cutovers c
                               WHERE c.company_id = inv.company_id OR c.company_id = loc.company_id)
         $q$;
       ELSE
         UPDATE inventory inv
            SET company_id = loc.company_id
           FROM locations loc
          WHERE inv.location_id = loc.id
            AND (inv.company_id IS NULL OR inv.company_id <> loc.company_id);
       END IF;
     END $$`,
  // Insurance Members table (June 2026)
  `CREATE TABLE IF NOT EXISTS insurance_members (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      name text NOT NULL,
      nationality text,
      position_working text,
      start_date date NOT NULL,
      amount decimal(15,2) NOT NULL DEFAULT 0,
      dob date,
      notes text,
      insurance_number text,
      active boolean NOT NULL DEFAULT true,
      ledger_account_id integer,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS idx_insurance_members_company ON insurance_members (company_id)`,
  `ALTER TABLE insurance_members ADD COLUMN IF NOT EXISTS insurance_number text`,
  // Sheets & Sacks inventory and IN/OUT log: see ../startup/factorySheetsSacksSchema.ts,
  // which also runs on every boot because production skips this ordered pass.
  ...factorySheetsSacksSchema,
  // Status Builder change history (July 2026). Powers the "History" tab in
  // the redesigned Factory Sheets card UI -- one row per changed cell/label
  // on each save, so users can see who changed what and when.
  `CREATE TABLE IF NOT EXISTS factory_status_builder_log (
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
    )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_log_company_created ON factory_status_builder_log (company_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_log_sheet ON factory_status_builder_log (sheet_id)`,

  // -- Exchange rates: one shared company-wide rate per (company, date, pair) (July 2026) --
  // Fixes the "Set Today's Exchange Rate" popup reappearing for every user: without this
  // constraint, concurrent/duplicate saves could create more than one row for the same
  // day, and the popup's "has a rate today" check had no atomic guarantee. Dedupe existing
  // rows first (keep the newest per group) so the unique index can be created on data that
  // predates this migration.
  `DO $exch_dedup$
     DECLARE keep_id integer; dup_id integer;
     BEGIN
       FOR keep_id IN
         SELECT DISTINCT ON (company_id, effective_date, from_currency, to_currency) id
         FROM exchange_rates
         ORDER BY company_id, effective_date, from_currency, to_currency, created_at DESC, id DESC
       LOOP
         FOR dup_id IN
           SELECT er2.id FROM exchange_rates er2
           WHERE er2.id != keep_id
             AND er2.company_id = (SELECT company_id FROM exchange_rates WHERE id = keep_id)
             AND er2.effective_date = (SELECT effective_date FROM exchange_rates WHERE id = keep_id)
             AND er2.from_currency = (SELECT from_currency FROM exchange_rates WHERE id = keep_id)
             AND er2.to_currency = (SELECT to_currency FROM exchange_rates WHERE id = keep_id)
         LOOP
           DELETE FROM exchange_rates WHERE id = dup_id;
         END LOOP;
       END LOOP;
     END $exch_dedup$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS exchange_rates_company_date_pair_unique
     ON exchange_rates (company_id, effective_date, from_currency, to_currency)`,

  // -- Factory: locked raw-material rate column + backfill (July 2026) --
  // Persists the authoritative locked cost/kg (USD) per factory supplier
  // (shared/schema/factory.ts: factorySuppliers.currentRawMaterialCostPerKgUsd) so it
  // survives restarts/deploys without depending on a lazy runtime derive. See
  // server/services/factory/rawStockLockedRate.ts for the read/write helpers that own
  // all future updates to this column (real offload moving-average, landed-cost
  // correction, explicit update-cost), the exported SQL constants this migration
  // reuses (single source of truth, shared with the migration test suite), and the
  // exact backfill formula/inclusion rules.
  FACTORY_SUPPLIER_LOCKED_RATE_ADD_COLUMN_SQL,
  // Guarded twice for safety: by migrations_log (one-time, so a supplier that
  // legitimately still has no historical receipts stays NULL forever, to be set
  // later by a real offload) AND by "current value IS NULL" inside the backfill
  // SQL's own UPDATE WHERE clause (so even a hypothetical re-run can never clobber
  // an already-established rate).
  `DO $lockrate_backfill$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = '${FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_MIGRATION_KEY}') THEN
        ${FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL};
        INSERT INTO migrations_log(key) VALUES ('${FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_MIGRATION_KEY}');
      END IF;
    END $lockrate_backfill$;
  `,

  // -- Decimal precision: increase cost_per_kg / total_cost scale to 7dp (July 2026) --
  // The old scale(2) / scale(4) compounded into multi-dollar errors on large (20 000+ kg) batches.
  // PostgreSQL silently accepts ALTER COLUMN...TYPE NUMERIC(20,7) as a no-op when the column is
  // already NUMERIC(20,7), so these statements are safe to run on every deploy.
  `ALTER TABLE factory_mix_batch_sources ALTER COLUMN cost_per_kg TYPE NUMERIC(20,7)`,
  `ALTER TABLE factory_mix_batch_sources ALTER COLUMN total_cost TYPE NUMERIC(20,7)`,
  `ALTER TABLE factory_mix_batches ALTER COLUMN cost_per_kg TYPE NUMERIC(20,7)`,
  `ALTER TABLE factory_mix_batches ALTER COLUMN total_cost TYPE NUMERIC(20,7)`,
  `ALTER TABLE factory_bales ALTER COLUMN cost_per_kg TYPE NUMERIC(20,7)`,
  `ALTER TABLE factory_bales ALTER COLUMN total_cost TYPE NUMERIC(20,7)`,

  // -- Commission-specific FX rate fields on factory_containers (July 2026) --
  // A commission may be denominated in a currency different from the container (e.g. AUD
  // container with EUR commission). Using the container's fxRateToUsd for such a commission
  // produces an incorrect commissionTotalUsd. These three columns persist the commission-
  // specific rate so computeCorrectContainerCost always uses the right rate.
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS commission_fx_rate_to_usd NUMERIC(20,8)`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS commission_fx_rate_confirmed BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS commission_fx_rate_date DATE`,

  // -- Freight-specific FX rate fields on factory_containers (July 2026) --
  // Freight may be in a different currency than the container itself. These columns persist
  // the resolved FX rate at the time the container was saved so computeCorrectContainerCost
  // always uses the same rate regardless of when it is called again.
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS freight_fx_rate_to_usd NUMERIC(20,8)`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS freight_fx_rate_confirmed BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS freight_fx_rate_date DATE`,
  // OTW shared note + docs flag visible to all users (Jul 2026)
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS otw_note TEXT`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS otw_docs_received BOOLEAN NOT NULL DEFAULT false`,

  // -- Per-line FX rate on factory_container_other_charges (July 2026) --
  // Each other-charge line may be denominated in its own currency. Store the resolved
  // rate so computeCorrectContainerCost can use it without re-fetching from the exchange_rates table.
  `ALTER TABLE factory_container_other_charges ADD COLUMN IF NOT EXISTS fx_rate_to_usd NUMERIC(20,8) DEFAULT 1`,
  `ALTER TABLE factory_container_other_charges ADD COLUMN IF NOT EXISTS fx_rate_confirmed BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE factory_container_other_charges ADD COLUMN IF NOT EXISTS fx_rate_date DATE`,

  // ── Multi-currency base amounts on voucher_entries (never had a standalone migration) ──
  // base_debit_amount / base_credit_amount store the historical USD-base value after
  // multi-currency backfill.  The net-profit and bank-revaluation routes COALESCE these
  // with the legacy debit_amount / credit_amount columns so they must exist in production.
  `ALTER TABLE voucher_entries ADD COLUMN IF NOT EXISTS base_debit_amount NUMERIC(20,6)`,
  `ALTER TABLE voucher_entries ADD COLUMN IF NOT EXISTS base_credit_amount NUMERIC(20,6)`,

  // -- fx_rate_to_usd / fx_rate_confirmed on offload charges and commissions (July 2026) --
  // factory_offload_additional_charges was created with fx_rate_to_usd in its CREATE TABLE body,
  // but IF NOT EXISTS means existing production tables that predate the column never got it.
  // factory_container_commissions has no CREATE TABLE at all — it was created before the column
  // was added to the schema — so a standalone ALTER TABLE is required for both columns.
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS fx_rate_to_usd NUMERIC(20,6) DEFAULT 1`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS fx_rate_confirmed BOOLEAN NOT NULL DEFAULT false`,
  // Remaining columns that were added after the original CREATE TABLE; all safe to re-run.
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS fx_rate_date DATE`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS voucher_id INTEGER`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS daybook_entry_id INTEGER`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS reversal_daybook_entry_id INTEGER`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS supplier_locked_rate_before NUMERIC(20,8)`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS supplier_locked_rate_after NUMERIC(20,8)`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS supplier_remaining_kg_at_apply NUMERIC(20,3)`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS full_container_value_delta_usd NUMERIC(20,6)`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS supplier_inventory_value_delta_usd NUMERIC(20,6)`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS remaining_fraction_at_apply NUMERIC(20,8)`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS created_by_user_id TEXT`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`,
  `ALTER TABLE factory_offload_additional_charges ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE factory_container_commissions ADD COLUMN IF NOT EXISTS fx_rate_to_usd NUMERIC(20,8) NOT NULL DEFAULT 1`,
  `ALTER TABLE factory_container_commissions ADD COLUMN IF NOT EXISTS fx_rate_confirmed BOOLEAN NOT NULL DEFAULT false`,

  // -- factory_container_receipts: per-receipt audit log for partial offloads (July 2026) --
  // Each row captures exactly one receipt event (incremental kg, cumulative kg, and
  // the immutable fixed landed cost/kg established at first offload time).
  // factory_raw_stock remains a single cumulative row per container; this table is the
  // per-event detail so the system can support multiple partial receipts per container.
  `CREATE TABLE IF NOT EXISTS factory_container_receipts (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      container_id integer NOT NULL,
      receipt_date date NOT NULL,
      received_kg numeric(15,3) NOT NULL,
      cumulative_received_kg numeric(15,3) NOT NULL,
      fixed_cost_per_kg numeric(20,6),
      fixed_cost_per_kg_usd numeric(20,6),
      receipt_value numeric(20,6),
      receipt_value_usd numeric(20,6),
      currency_code varchar(3),
      fx_rate_to_usd numeric(20,8),
      created_by varchar(255),
      created_at timestamp NOT NULL DEFAULT now(),
      deleted_at timestamp
    )`,
  `CREATE INDEX IF NOT EXISTS factory_container_receipts_container_idx ON factory_container_receipts(company_id, container_id)`,
  `CREATE INDEX IF NOT EXISTS factory_container_receipts_date_idx ON factory_container_receipts(company_id, receipt_date)`,

  // -- factory_container_receipts: backfill columns that may be absent on tables created
  // before these fields were added.  ADD COLUMN IF NOT EXISTS is safe to re-run; it is
  // a no-op when the column already exists (the CREATE TABLE IF NOT EXISTS above only
  // adds the full column set when the table is brand-new).
  `ALTER TABLE factory_container_receipts ADD COLUMN IF NOT EXISTS receipt_value numeric(20,6)`,
  `ALTER TABLE factory_container_receipts ADD COLUMN IF NOT EXISTS receipt_value_usd numeric(20,6)`,
  `ALTER TABLE factory_container_receipts ADD COLUMN IF NOT EXISTS currency_code varchar(3)`,
  `ALTER TABLE factory_container_receipts ADD COLUMN IF NOT EXISTS fx_rate_to_usd numeric(20,8)`,

  // -- factory_container_receipts: integrity constraints + idempotency key (July 2026) --
  // Wrapped in the same DO/duplicate_object guard the rest of this file uses.
  // Unguarded they raised "constraint already exists" on every startup after the
  // first — harmless while nothing read the outcome, but they were three of the
  // failures counted by config/startup-migration-baseline.json, and a gate that
  // reports three known-noise failures on every re-run is a gate people learn to
  // ignore. Postgres has no ADD CONSTRAINT IF NOT EXISTS; this is the idiom.
  `ALTER TABLE factory_container_receipts ADD COLUMN IF NOT EXISTS idempotency_key varchar(100)`,
  `DO $$ BEGIN ALTER TABLE factory_container_receipts ADD CONSTRAINT fcr_positive_received_kg CHECK (received_kg > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE factory_container_receipts ADD CONSTRAINT fcr_cumulative_gte_received CHECK (cumulative_received_kg >= received_kg); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE factory_container_receipts ADD CONSTRAINT fcr_container_fkey FOREIGN KEY (container_id) REFERENCES factory_containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS factory_container_receipts_idempotency_idx ON factory_container_receipts(company_id, container_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,

  // -- Per-KG column precision (July 2026, cost columns raised to 7dp) --
  // Rule: a *cost* per KG is 7 decimal places; a rate, price or commission the
  // user types in stays at 6.
  //
  // This block previously rounded every per-KG column to 6dp, including
  // factory_mix_batches.cost_per_kg — which an earlier block in this same array
  // had just raised to NUMERIC(20,7). The two contradicted each other, so the
  // column's real scale depended on which statement a given run reached last:
  // application boot ended at 6, the test harness at 7, on the same database.
  // Worse, `USING ROUND(col, 6)` is not a no-op in that direction - it discards
  // the 7th decimal from stored values every time it runs.
  //
  // Cost columns are computed and then multiplied by tonne-scale weights, so a
  // rounding error compounds; that was the reason for 7dp in the first place.
  // Rates and prices are entered by hand and 6dp is plenty. Widening 6 -> 7
  // cannot truncate an existing value, and ROUND(col, 7) is a genuine no-op on
  // data that is already 7dp.
  `ALTER TABLE factory_containers ALTER COLUMN rate_per_kg TYPE numeric(20,6) USING ROUND(rate_per_kg::numeric, 6)`,
  `ALTER TABLE factory_containers ALTER COLUMN rate_per_kg_usd TYPE numeric(20,6) USING ROUND(rate_per_kg_usd::numeric, 6)`,
  // factory_raw_stock cost_per_kg / cost_per_kg_usd were incorrectly assumed to already be
  // scale-6 in the original migration batch — production still has NUMERIC(20,4). Upgrade now.
  `ALTER TABLE factory_raw_stock ALTER COLUMN cost_per_kg TYPE numeric(20,7) USING ROUND(cost_per_kg::numeric, 7)`,
  `ALTER TABLE factory_raw_stock ALTER COLUMN cost_per_kg_usd TYPE numeric(20,7) USING ROUND(cost_per_kg_usd::numeric, 7)`,
  `ALTER TABLE factory_raw_material_adjustments ALTER COLUMN cost_per_kg TYPE numeric(20,7) USING ROUND(cost_per_kg::numeric, 7)`,
  `ALTER TABLE factory_mix_batches ALTER COLUMN cost_per_kg TYPE numeric(20,7) USING ROUND(cost_per_kg::numeric, 7)`,
  `ALTER TABLE factory_container_commissions ALTER COLUMN commission_rate TYPE numeric(20,6) USING ROUND(commission_rate::numeric, 6)`,
  `ALTER TABLE customer_proforma_lines ALTER COLUMN price_per_kg TYPE numeric(20,6) USING ROUND(price_per_kg::numeric, 6)`,
  `ALTER TABLE customer_order_lines ALTER COLUMN price_per_kg TYPE numeric(20,6) USING ROUND(price_per_kg::numeric, 6)`,
  `ALTER TABLE factory_settings ALTER COLUMN labor_cost_per_kg TYPE numeric(10,6) USING ROUND(labor_cost_per_kg::numeric, 6)`,
  `ALTER TABLE factory_settings ALTER COLUMN overhead_per_kg TYPE numeric(10,6) USING ROUND(overhead_per_kg::numeric, 6)`,
];
