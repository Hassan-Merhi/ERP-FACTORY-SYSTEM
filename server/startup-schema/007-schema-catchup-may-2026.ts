/**
 * Startup schema migrations - NOT VALID promotion, scoping indexes, audit-flagged tables, soft-delete columns, status builder, and customer_orders columns that were never back-ported.
 *
 * Part of the ordered `startupMigrations` array assembled in ./index.ts.
 * Statement order is load-bearing: these run sequentially at boot, so entries
 * must never be reordered or moved between parts.
 */

export const schemaCatchupMay2026: string[] = [
  // ── NOT VALID promotion (Phases A, B, C — May 2026) ─────────────────────
  // After archiving 16,272 orphan rows in dev to _orphan_archive_* tables,
  // all 12 NOT VALID constraints were validated. These ALTER ... VALIDATE
  // statements are idempotent: once a constraint is validated, re-running
  // is a no-op. Only `undefined_object` (constraint name doesn't exist in
  // an older schema) is swallowed — `foreign_key_violation` (orphans still
  // present) intentionally propagates so production failures are loud and
  // forced to be remediated before deploy completes.
  `DO $$ BEGIN ALTER TABLE chat_messages VALIDATE CONSTRAINT chat_messages_company_id_fkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_offloads VALIDATE CONSTRAINT container_offloads_location_id_fkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE import_logs VALIDATE CONSTRAINT import_logs_container_id_fkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;`,
  // factory_container_commissions, factory_fx_allocations and factory_raw_stock
  // are deliberately absent from this list. Part 006 creates their
  // *_container_id_fkey against `containers`, but part 009 later drops each one
  // and recreates it against `factory_containers` — the table those columns
  // actually reference. Validating the 006 form here compares the data against
  // the wrong parent table, so it raised foreign_key_violation on every boot of
  // any database holding factory rows: a false alarm that made the real orphan
  // signal below untrustworthy. Part 009 adds the corrected constraints without
  // NOT VALID, so Postgres validates them in full against the right table and
  // the orphan check is stronger than the one removed here.
  `DO $$ BEGIN ALTER TABLE inventory VALIDATE CONSTRAINT inventory_location_id_fkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_adjustment_vouchers VALIDATE CONSTRAINT stock_adjustment_vouchers_location_id_fkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_items VALIDATE CONSTRAINT stock_transfer_items_source_location_id_fkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_items VALIDATE CONSTRAINT stock_transfer_items_transfer_id_fkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_vouchers VALIDATE CONSTRAINT stock_transfer_vouchers_destination_location_id_fkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_vouchers VALIDATE CONSTRAINT stock_transfer_vouchers_source_location_id_fkey; EXCEPTION WHEN undefined_object THEN NULL; END $$;`,

  // ── Phase 4+5 perf indexes (May 2026) — hot-path scoping ────────────────
  // 12 strategic indexes covering bale-pick, customer-order, voucher-entry,
  // and inventory hot paths surfaced by the Customer-Ledger Phase 9 / factory
  // override audit. All idempotent CREATE INDEX IF NOT EXISTS.
  `CREATE INDEX IF NOT EXISTS factory_bales_company_idx ON factory_bales(company_id)`,
  `CREATE INDEX IF NOT EXISTS factory_bales_status_idx ON factory_bales(status)`,
  `CREATE INDEX IF NOT EXISTS factory_bales_product_idx ON factory_bales(product_id)`,
  `CREATE INDEX IF NOT EXISTS factory_bales_company_status_idx ON factory_bales(company_id, status)`,
  `CREATE INDEX IF NOT EXISTS customer_orders_company_idx ON customer_orders(company_id)`,
  `CREATE INDEX IF NOT EXISTS customer_orders_customer_idx ON customer_orders(customer_id)`,
  `CREATE INDEX IF NOT EXISTS customer_orders_status_idx ON customer_orders(status)`,
  `CREATE INDEX IF NOT EXISTS customer_order_bales_order_idx ON customer_order_bales(order_id)`,
  `CREATE INDEX IF NOT EXISTS customer_order_bales_bale_idx ON customer_order_bales(bale_id)`,
  `CREATE INDEX IF NOT EXISTS voucher_entries_ledger_voucher_idx ON voucher_entries(ledger_account_id, voucher_id)`,
  `CREATE INDEX IF NOT EXISTS voucher_entries_voucher_id_idx ON voucher_entries(voucher_id)`,
  `CREATE INDEX IF NOT EXISTS voucher_entries_customer_id_idx ON voucher_entries(customer_id)`,
  `CREATE INDEX IF NOT EXISTS vouchers_company_date_idx ON vouchers(company_id, voucher_date)`,
  `CREATE INDEX IF NOT EXISTS inventory_location_idx ON inventory(location_id)`,

  // ── Tables flagged missing from runtime migrations by audit (May 2026) ────
  // These exist in shared/schema.ts but had no CREATE TABLE in this array,
  // so a fresh deploy on Render would fail. All idempotent.
  `CREATE TABLE IF NOT EXISTS bale_transfer_items (
        id serial PRIMARY KEY,
        transfer_id integer NOT NULL,
        production_bale_id integer NOT NULL,
        quantity integer NOT NULL DEFAULT 1,
        weight_kg numeric(15,3) NOT NULL,
        cost_per_kg numeric(20,2) NOT NULL,
        total_cost numeric(20,2) NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
  `CREATE TABLE IF NOT EXISTS factory_daybook_entry_edits (
        id serial PRIMARY KEY,
        daybook_entry_id integer NOT NULL,
        edited_at timestamp NOT NULL DEFAULT now(),
        edited_by varchar,
        before_json text,
        after_json text,
        reason text NOT NULL
      )`,
  `CREATE INDEX IF NOT EXISTS daybook_edits_entry_idx ON factory_daybook_entry_edits(daybook_entry_id)`,
  `CREATE TABLE IF NOT EXISTS system_settings (
        id serial PRIMARY KEY,
        key varchar(100) NOT NULL UNIQUE,
        value text,
        updated_at timestamp NOT NULL DEFAULT now()
      )`,

  // ── Wave 1 soft-delete columns (Task #10) ──────────────────────────────
  // All idempotent: ADD COLUMN IF NOT EXISTS is safe to run repeatedly.
  `ALTER TABLE locations ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE ledger_accounts ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE ledger_accounts ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false`,
  `ALTER TABLE ledger_accounts ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()`,
  `ALTER TABLE employees ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS stock_group_id integer REFERENCES stock_groups(id) ON DELETE SET NULL`,
  `ALTER TABLE stock_groups ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE stock_group_location_archives ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE factory_categories ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE factory_bale_products ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE factory_containers ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE factory_raw_stock ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE factory_raw_material_adjustments ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE factory_raw_material_adjustments ADD COLUMN IF NOT EXISTS reference varchar(200)`,
  `ALTER TABLE factory_mix_batches ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE factory_bales ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE factory_bales ADD COLUMN IF NOT EXISTS worker_name TEXT`,
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'factory-bales-worker-name-backfill-v1') THEN
        UPDATE factory_bales fb SET worker_name = fw.full_name FROM factory_workers fw WHERE fb.finalized_by = fw.id AND fb.worker_name IS NULL;
        INSERT INTO migrations_log(key) VALUES ('factory-bales-worker-name-backfill-v1');
      END IF;
    END $$`,
  `ALTER TABLE customer_proformas ADD COLUMN IF NOT EXISTS deleted_at timestamp`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS deleted_at timestamp`,

  // ── Retired (2026-10 accounting audit): a boot-time step here swapped the
  // debit and credit of every GUAR-CASH-% voucher whose Tenant Deposits line was a
  // debit. It ran on every boot, so it would also have flipped any later,
  // legitimate deposit refund. Posted entries are corrected with a reversing
  // entry, never rewritten at deploy time. Production had no matching lines left.

  // ── Factory Status Builder (experimental) ──────────────────────────────
  `CREATE TABLE IF NOT EXISTS status_report_templates (
      id         serial PRIMARY KEY,
      company_id integer NOT NULL,
      name       text    NOT NULL DEFAULT 'Default Template',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS srtemplate_company_idx ON status_report_templates(company_id)`,
  `CREATE TABLE IF NOT EXISTS status_metrics (
      id                 serial PRIMARY KEY,
      template_id        integer NOT NULL,
      name               text    NOT NULL,
      before_source_type text    NOT NULL DEFAULT 'manual',
      source_type        text    NOT NULL DEFAULT 'manual',
      source_field       text    NOT NULL DEFAULT 'quantity',
      operation          text    NOT NULL DEFAULT 'sum',
      filters_json       jsonb            DEFAULT '{}',
      sort_order         integer NOT NULL DEFAULT 0,
      created_at         timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS smetric_template_idx ON status_metrics(template_id)`,
  `CREATE TABLE IF NOT EXISTS status_report_runs (
      id          serial PRIMARY KEY,
      template_id integer     NOT NULL,
      company_id  integer     NOT NULL,
      run_date    varchar(10) NOT NULL,
      created_at  timestamp NOT NULL DEFAULT now(),
      updated_at  timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS srrun_unique    ON status_report_runs(template_id, run_date)`,
  `CREATE        INDEX IF NOT EXISTS srrun_company_idx ON status_report_runs(company_id)`,
  `CREATE TABLE IF NOT EXISTS status_metric_values (
      id                serial PRIMARY KEY,
      run_id            integer        NOT NULL,
      metric_id         integer        NOT NULL,
      before_value      numeric(20,4)  NOT NULL DEFAULT 0,
      linked_value      numeric(20,4)  NOT NULL DEFAULT 0,
      manual_adjustment numeric(20,4)  NOT NULL DEFAULT 0,
      difference        numeric(20,4)  NOT NULL DEFAULT 0,
      final_total       numeric(20,4)  NOT NULL DEFAULT 0,
      warnings_json     jsonb          DEFAULT '[]',
      last_refreshed    timestamp,
      created_at        timestamp NOT NULL DEFAULT now(),
      updated_at        timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS smvalue_unique  ON status_metric_values(run_id, metric_id)`,
  `CREATE        INDEX IF NOT EXISTS smvalue_run_idx ON status_metric_values(run_id)`,

  // ── Status Builder Sheets (May 2026) ────────────────────────────────────
  // Independent spreadsheet dataset for the Status Builder page.
  // Same structure as factory_sheets but fully separate data.
  `CREATE TABLE IF NOT EXISTS status_builder_sheets (
      id          serial      PRIMARY KEY,
      company_id  integer     NOT NULL,
      name        text        NOT NULL,
      order_index integer     NOT NULL DEFAULT 0,
      columns     jsonb       NOT NULL DEFAULT '[]',
      rows        jsonb       NOT NULL DEFAULT '[]',
      updated_at  timestamp   NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS status_builder_sheets_company_idx ON status_builder_sheets(company_id)`,

  // ── Factory Bale Products: selling/production price columns (May 2026) ────
  // These columns were defined in the schema but never had a runtime migration.
  `ALTER TABLE factory_bale_products ADD COLUMN IF NOT EXISTS selling_price numeric(20,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE factory_bale_products ADD COLUMN IF NOT EXISTS production_price numeric(20,2) NOT NULL DEFAULT 0`,

  // ── Stock Item Merge Audit Log (May 2026) ─────────────────────────────
  // Tracks every merge operation: who merged what, snapshots before/after.
  `CREATE TABLE IF NOT EXISTS stock_item_merge_logs (
      id                serial        PRIMARY KEY,
      company_id        integer       NOT NULL,
      kept_item_id      integer       NOT NULL,
      kept_item_code    varchar(50)   NOT NULL,
      kept_item_name    text          NOT NULL,
      merged_item_id    integer       NOT NULL,
      merged_item_code  varchar(50)   NOT NULL,
      merged_item_name  text          NOT NULL,
      snapshot_before   jsonb         NOT NULL DEFAULT '{}',
      snapshot_after    jsonb         NOT NULL DEFAULT '{}',
      merged_by_user_id integer       NOT NULL,
      merged_at         timestamp     NOT NULL DEFAULT now(),
      notes             text
    )`,
  `CREATE INDEX IF NOT EXISTS stock_item_merge_logs_company_idx ON stock_item_merge_logs(company_id)`,
  `CREATE INDEX IF NOT EXISTS stock_items_company_deleted_code_idx ON stock_items(company_id, deleted_at, code)`,
  `CREATE INDEX IF NOT EXISTS stock_items_company_group_idx ON stock_items(company_id, stock_group_id)`,
  `CREATE INDEX IF NOT EXISTS inventory_stock_item_idx ON inventory(stock_item_id)`,
  `CREATE INDEX IF NOT EXISTS inventory_company_location_idx ON inventory(company_id, location_id)`,
  `CREATE INDEX IF NOT EXISTS ledger_accounts_company_deleted_code_idx ON ledger_accounts(company_id, deleted_at, code)`,
  `CREATE INDEX IF NOT EXISTS ledger_accounts_company_type_idx ON ledger_accounts(company_id, account_type)`,

  // ── customer_orders: columns added to schema but never back-ported to existing production tables ──
  // These columns exist in shared/schema.ts but the CREATE TABLE for customer_orders predates
  // the runtime migration system, so an ALTER TABLE is required for each addition.
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS proforma_id_used INTEGER`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS container_number VARCHAR(100)`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS shipping_company VARCHAR(200)`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS container_notes TEXT`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS verified_by_user_id INTEGER`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS loading_started_at TIMESTAMP`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS loading_finalized_at TIMESTAMP`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMP`,
  `UPDATE customer_orders SET finalized_at = updated_at WHERE status = 'FINALIZED' AND finalized_at IS NULL`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS location_id INTEGER`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50)`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS subtotal_bales NUMERIC(20,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS freight_amount NUMERIC(20,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS other_charges_total NUMERIC(20,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS grand_total NUMERIC(20,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS total_qty_bales INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now()`,

  // ── customer_orders: destination column (in schema since Phase C but never migrated) ──
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS destination TEXT`,

  // ── customer_order_bales: columns added to schema but never back-ported ──
  `ALTER TABLE customer_order_bales ADD COLUMN IF NOT EXISTS article_code VARCHAR(50)`,
  `ALTER TABLE customer_order_bales ADD COLUMN IF NOT EXISTS bale_name TEXT`,
  `ALTER TABLE customer_order_bales ADD COLUMN IF NOT EXISTS price_used NUMERIC(20,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE customer_order_bales ADD COLUMN IF NOT EXISTS bale_reference VARCHAR(100) NOT NULL DEFAULT ''`,
  `ALTER TABLE customer_order_bales ADD COLUMN IF NOT EXISTS location_id INTEGER`,
];
