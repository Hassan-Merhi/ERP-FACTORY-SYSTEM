/**
 * Startup schema migrations - POS idempotency and role consolidation, the configurable daily export schedule, agent mappings, AI action audit log, and the local customer bale truck dispatch workflow.
 *
 * Part of the ordered `startupMigrations` array assembled in ./index.ts.
 * Statement order is load-bearing: these run sequentially at boot, so entries
 * must never be reordered or moved between parts.
 */

export const posExportsAndDispatch: string[] = [
  // ── POS idempotency: per-company unique client sale ID to prevent duplicate charges ──
  `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS client_sale_id VARCHAR(36)`,
  // CONCURRENTLY avoids an ACCESS EXCLUSIVE table lock on vouchers during index build,
  // which would otherwise block every read/write to that table until the index is ready.
  // NOTE: CONCURRENTLY cannot run inside an explicit transaction; our migration runner
  // issues each statement in auto-commit mode so this is safe.
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS vouchers_company_client_sale_unique ON vouchers (company_id, client_sale_id) WHERE client_sale_id IS NOT NULL`,

  // ── Consolidate POS1–POS6 into a single POS role + posStation column (May 2026) ──
  // Wrapped: after first run no POS1-6/'User' rows remain, but migrations_log guard
  // prevents any future role with those exact names from being incorrectly renamed.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'pos-role-normalize-v1') THEN
        UPDATE user_company_roles SET role = 'POS', pos_station = 1 WHERE role = 'POS1';
        UPDATE user_company_roles SET role = 'POS', pos_station = 2 WHERE role = 'POS2';
        UPDATE user_company_roles SET role = 'POS', pos_station = 3 WHERE role = 'POS3';
        UPDATE user_company_roles SET role = 'POS', pos_station = 4 WHERE role = 'POS4';
        UPDATE user_company_roles SET role = 'POS', pos_station = 5 WHERE role = 'POS5';
        UPDATE user_company_roles SET role = 'POS', pos_station = 6 WHERE role = 'POS6';
        UPDATE user_company_roles SET role = 'Normal User' WHERE role = 'User';
        UPDATE role_feature_permissions SET role = 'POS' WHERE role IN ('POS1','POS2','POS3','POS4','POS5','POS6');
        UPDATE role_feature_permissions SET role = 'Normal User' WHERE role = 'User';
        INSERT INTO migrations_log(key) VALUES ('pos-role-normalize-v1');
      END IF;
    END $$`,

  // ── Configurable daily-export schedule time (May 2026) ─────────────────
  `ALTER TABLE export_settings ADD COLUMN IF NOT EXISTS schedule_hour integer NOT NULL DEFAULT 18`,
  `ALTER TABLE export_settings ADD COLUMN IF NOT EXISTS schedule_timezone text NOT NULL DEFAULT 'America/New_York'`,
  // Per-location POS cash account mappings (May 2026)
  `CREATE TABLE IF NOT EXISTS user_location_cash_accounts (
      id serial PRIMARY KEY,
      user_id varchar NOT NULL,
      company_id integer NOT NULL,
      location_id integer NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      cash_account_id integer NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      pos_station integer,
      created_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT ulca_user_company_location_unique UNIQUE (user_id, company_id, location_id)
    )`,
  `CREATE INDEX IF NOT EXISTS ulca_company_idx ON user_location_cash_accounts(company_id)`,
  `CREATE INDEX IF NOT EXISTS ulca_user_idx ON user_location_cash_accounts(user_id)`,
  `INSERT INTO user_location_cash_accounts (user_id, company_id, location_id, cash_account_id, pos_station)
      SELECT ucr.user_id, ucr.company_id, COALESCE(ul.location_id, ucr.assigned_location_id), ucr.cash_account_id, ucr.pos_station
      FROM user_company_roles ucr
      LEFT JOIN user_locations ul ON ul.user_id = ucr.user_id AND ul.company_id = ucr.company_id
      WHERE ucr.role = 'POS'
        AND ucr.cash_account_id IS NOT NULL
        AND COALESCE(ul.location_id, ucr.assigned_location_id) IS NOT NULL
      ON CONFLICT (user_id, company_id, location_id) DO NOTHING`,

  // Agent / Declarant mapping table for GIT Agent/Duty summary
  `CREATE TABLE IF NOT EXISTS agent_declarant_mappings (
      id                SERIAL PRIMARY KEY,
      agent_name        VARCHAR(100) NOT NULL,
      ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE SET NULL,
      aliases           TEXT[]       NOT NULL DEFAULT '{}',
      active            BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

  // Phase 2 — add company_id for per-company agent mappings.
  // NAHLI exists in company 1 and company 10 with different ledger accounts,
  // so the old single-column unique index on agent_name alone is insufficient.
  `ALTER TABLE agent_declarant_mappings
       ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`,

  // Drop the old non-partial unique index (replaced by the two partial indexes below).
  // Safe: IF EXISTS means no error on fresh installs or re-runs after it was already dropped.
  `DROP INDEX IF EXISTS idx_adm_agent_name_lower`,

  // Unique index for company-specific mappings: (agent_name, company_id) per company.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_adm_agent_company_lower
       ON agent_declarant_mappings (LOWER(agent_name), company_id)
       WHERE company_id IS NOT NULL`,

  // Unique index for global mappings: agent_name alone, only when company_id is NULL.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_adm_agent_global_lower
       ON agent_declarant_mappings (LOWER(agent_name))
       WHERE company_id IS NULL`,

  // ── Approved agent mappings — idempotent upsert ──────────────────────────
  // Company 1 (HADI L'SHI): NAHLI → HUSSAIN NAHLI (id=40)
  `INSERT INTO agent_declarant_mappings (agent_name, company_id, ledger_account_id, aliases, active)
       SELECT 'NAHLI', 1, 40, ARRAY['HUSSAIN NAHLI','HUSSEIN NAHLI','NAHLI AGENT'], TRUE
       WHERE EXISTS (SELECT 1 FROM companies WHERE id = 1)
         AND EXISTS (SELECT 1 FROM ledger_accounts WHERE id = 40)
       ON CONFLICT ((LOWER(agent_name)), company_id) WHERE company_id IS NOT NULL
       DO UPDATE SET ledger_account_id = EXCLUDED.ledger_account_id,
                     aliases           = EXCLUDED.aliases,
                     active            = TRUE`,

  // Company 1 (HADI L'SHI): NCA → NCA (id=43)
  `INSERT INTO agent_declarant_mappings (agent_name, company_id, ledger_account_id, aliases, active)
       SELECT 'NCA', 1, 43, ARRAY[]::TEXT[], TRUE
       WHERE EXISTS (SELECT 1 FROM companies WHERE id = 1)
         AND EXISTS (SELECT 1 FROM ledger_accounts WHERE id = 43)
       ON CONFLICT ((LOWER(agent_name)), company_id) WHERE company_id IS NOT NULL
       DO UPDATE SET ledger_account_id = EXCLUDED.ledger_account_id,
                     aliases           = EXCLUDED.aliases,
                     active            = TRUE`,

  // Company 1 (HADI L'SHI): AFEPRO → AFEPRO (id=607)
  `INSERT INTO agent_declarant_mappings (agent_name, company_id, ledger_account_id, aliases, active)
       SELECT 'AFEPRO', 1, 607, ARRAY[]::TEXT[], TRUE
       WHERE EXISTS (SELECT 1 FROM companies WHERE id = 1)
         AND EXISTS (SELECT 1 FROM ledger_accounts WHERE id = 607)
       ON CONFLICT ((LOWER(agent_name)), company_id) WHERE company_id IS NOT NULL
       DO UPDATE SET ledger_account_id = EXCLUDED.ledger_account_id,
                     aliases           = EXCLUDED.aliases,
                     active            = TRUE`,

  // Company 8 (HMD KINSHASA): HUSSAIN SAAD → HUSSEIN SAAD (id=359)
  `INSERT INTO agent_declarant_mappings (agent_name, company_id, ledger_account_id, aliases, active)
       SELECT 'HUSSAIN SAAD', 8, 359, ARRAY['HUSSEIN SAAD'], TRUE
       WHERE EXISTS (SELECT 1 FROM companies WHERE id = 8)
         AND EXISTS (SELECT 1 FROM ledger_accounts WHERE id = 359)
       ON CONFLICT ((LOWER(agent_name)), company_id) WHERE company_id IS NOT NULL
       DO UPDATE SET ledger_account_id = EXCLUDED.ledger_account_id,
                     aliases           = EXCLUDED.aliases,
                     active            = TRUE`,

  // Company 8 (HMD KINSHASA): RIDA SALEH → RIDA SALEH (id=365)
  `INSERT INTO agent_declarant_mappings (agent_name, company_id, ledger_account_id, aliases, active)
       SELECT 'RIDA SALEH', 8, 365, ARRAY[]::TEXT[], TRUE
       WHERE EXISTS (SELECT 1 FROM companies WHERE id = 8)
         AND EXISTS (SELECT 1 FROM ledger_accounts WHERE id = 365)
       ON CONFLICT ((LOWER(agent_name)), company_id) WHERE company_id IS NOT NULL
       DO UPDATE SET ledger_account_id = EXCLUDED.ledger_account_id,
                     aliases           = EXCLUDED.aliases,
                     active            = TRUE`,

  // Company 10 (GC - LSHI): NAHLI → Hussein Nahli (id=419)
  `INSERT INTO agent_declarant_mappings (agent_name, company_id, ledger_account_id, aliases, active)
       SELECT 'NAHLI', 10, 419, ARRAY['HUSSAIN NAHLI','HUSSEIN NAHLI','NAHLI AGENT'], TRUE
       WHERE EXISTS (SELECT 1 FROM companies WHERE id = 10)
         AND EXISTS (SELECT 1 FROM ledger_accounts WHERE id = 419)
       ON CONFLICT ((LOWER(agent_name)), company_id) WHERE company_id IS NOT NULL
       DO UPDATE SET ledger_account_id = EXCLUDED.ledger_account_id,
                     aliases           = EXCLUDED.aliases,
                     active            = TRUE`,

  // GIT Phase P1 — three new nullable tracking columns on containers
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS docs_sent_date date`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS freight_status text`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_link text`,

  // ParcelsApp auto-tracking — new columns on containers
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_provider text`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_enabled boolean NOT NULL DEFAULT true`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_auto_update boolean NOT NULL DEFAULT true`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_carrier_hint text`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_last_checked_at timestamptz`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_last_status text`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_last_location text`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_last_event_date timestamptz`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_last_description text`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_error text`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_changed_at timestamptz`,

  // ParcelsApp — container_tracking_events table
  `CREATE TABLE IF NOT EXISTS container_tracking_events (
      id serial PRIMARY KEY,
      container_id integer NOT NULL,
      provider text NOT NULL DEFAULT 'parcelsapp',
      event_time timestamptz,
      event_status text,
      event_location text,
      event_description text,
      raw_event_json jsonb,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS cte_container_id_idx ON container_tracking_events (container_id)`,
  `CREATE INDEX IF NOT EXISTS cte_event_time_idx ON container_tracking_events (container_id, event_time DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cte_dedup_unique ON container_tracking_events (container_id, event_time, event_status) WHERE event_time IS NOT NULL AND event_status IS NOT NULL`,

  // ParcelsApp — container_tracking_checks table
  `CREATE TABLE IF NOT EXISTS container_tracking_checks (
      id serial PRIMARY KEY,
      container_id integer NOT NULL,
      provider text NOT NULL DEFAULT 'parcelsapp',
      status text NOT NULL,
      checked_at timestamp NOT NULL,
      error_message text,
      raw_response_json jsonb,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS ctc_container_id_idx ON container_tracking_checks (container_id)`,

  // Factory Shipping Container Rows + Documents (May 2026)
  `CREATE TABLE IF NOT EXISTS factory_shipping_container_rows (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      customer_order_id integer NOT NULL REFERENCES customer_orders(id) ON DELETE RESTRICT,
      order_date date NOT NULL,
      container_arrived_date date,
      note text,
      is_done boolean NOT NULL DEFAULT false,
      done_at timestamp,
      done_by text,
      whatsapp_sent_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fscr_company_order_unique ON factory_shipping_container_rows (company_id, customer_order_id)`,
  `CREATE INDEX IF NOT EXISTS fscr_company_idx ON factory_shipping_container_rows (company_id)`,
  `CREATE TABLE IF NOT EXISTS factory_shipping_container_documents (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      scr_id integer NOT NULL REFERENCES factory_shipping_container_rows(id) ON DELETE CASCADE,
      display_name text NOT NULL,
      file_name text NOT NULL,
      original_name text NOT NULL,
      file_url text NOT NULL,
      file_type text,
      file_size integer,
      file_data text,
      uploaded_by text,
      uploaded_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS fscd_scr_idx ON factory_shipping_container_documents (scr_id)`,
  `CREATE INDEX IF NOT EXISTS fscd_company_idx ON factory_shipping_container_documents (company_id)`,

  // Enable auto-tracking on all existing containers so "Track All Now" works immediately
  // One-time init — wrapped so manual per-container disables are not reset on restart.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'containers-tracking-enable-initial-v1') THEN
        UPDATE containers SET tracking_enabled = true WHERE tracking_enabled = false AND status NOT IN ('Offloaded','Closed','Completed');
        INSERT INTO migrations_log(key) VALUES ('containers-tracking-enable-initial-v1');
      END IF;
    END $$`,
  // Stock Grades and Categories (May 2026)
  `CREATE TABLE IF NOT EXISTS stock_grades (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS stock_categories (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS grade_id integer`,
  `ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS category_id integer`,
  // Carrier-first provider columns (May 2026)
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_detected_carrier text`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_fallback_used boolean NOT NULL DEFAULT false`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_fallback_reason text`,
  // P0 data fix (May 2026): disable tracking on offloaded/closed/completed containers
  // Case-insensitive so it handles OFFLOADED, Offloaded, offloaded, CLOSED, COMPLETED, etc.
  // Wrapped so manually re-enabled tracking on a specific closed container is not reset on restart.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'containers-tracking-disable-offloaded-v1') THEN
        UPDATE containers SET tracking_enabled = false, tracking_auto_update = false WHERE LOWER(status) IN ('offloaded','closed','completed') AND (tracking_enabled = true OR tracking_auto_update = true);
        INSERT INTO migrations_log(key) VALUES ('containers-tracking-disable-offloaded-v1');
      END IF;
    END $$`,
  // Smart priority scheduler columns (May 2026)
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_next_check_at timestamptz`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS tracking_last_skip_reason text`,
  `ALTER TABLE containers ADD COLUMN IF NOT EXISTS bl_docs text`,
  // Shipping company invoice columns on shipping container rows (May 2026)
  `ALTER TABLE customer_order_bales ADD COLUMN IF NOT EXISTS scanned_by text`,
  `ALTER TABLE factory_shipping_container_rows ADD COLUMN IF NOT EXISTS ci_number text`,
  `ALTER TABLE factory_shipping_container_rows ADD COLUMN IF NOT EXISTS shipping_invoice_file_name text`,
  `ALTER TABLE factory_shipping_container_rows ADD COLUMN IF NOT EXISTS shipping_invoice_original_name text`,
  `ALTER TABLE factory_shipping_container_rows ADD COLUMN IF NOT EXISTS shipping_invoice_file_url text`,
  `ALTER TABLE factory_shipping_container_rows ADD COLUMN IF NOT EXISTS shipping_invoice_file_data text`,
  `ALTER TABLE factory_shipping_container_rows ADD COLUMN IF NOT EXISTS shipping_invoice_file_type text`,
  // Ensure file_data column exists on shipping container documents (if table was created before this column was added)
  `ALTER TABLE factory_shipping_container_documents ADD COLUMN IF NOT EXISTS file_data text`,
  `ALTER TABLE factory_shipping_container_documents ADD COLUMN IF NOT EXISTS file_type text`,
  `ALTER TABLE factory_shipping_container_documents ADD COLUMN IF NOT EXISTS file_size integer`,
  `ALTER TABLE factory_shipping_container_documents ADD COLUMN IF NOT EXISTS uploaded_by text`,
  // Add file_data to container_documents for DB-backed file serving (no more ephemeral disk dependency)
  `ALTER TABLE container_documents ADD COLUMN IF NOT EXISTS file_data text`,
  // ETA column on shipping container rows (manual date entry)
  `ALTER TABLE factory_shipping_container_rows ADD COLUMN IF NOT EXISTS eta date`,
  // Tracking link on shipping container rows (for container tracking tab)
  `ALTER TABLE factory_shipping_container_rows ADD COLUMN IF NOT EXISTS tracking_link text`,
  `CREATE TABLE IF NOT EXISTS factory_shipping_availability (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      date date NOT NULL,
      shipping_company text NOT NULL,
      available_containers integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  `ALTER TABLE factory_shipping_availability ADD COLUMN IF NOT EXISTS note text`,
  `ALTER TABLE factory_shipping_availability ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false`,
  `ALTER TABLE factory_shipping_availability ADD COLUMN IF NOT EXISTS archived_at timestamp`,
  // One-time cleanup: remove ghost rows from factory_shipping_container_documents.
  // These are rows created before the file_data column was added (so file_data IS NULL)
  // and that have no recoverable content (disk is ephemeral). They show up as broken
  // "1 file" entries in the Documents column.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'shipping-docs-ghost-cleanup-v1') THEN
        DELETE FROM factory_shipping_container_documents
          WHERE file_data IS NULL
            AND (
              file_name  IS NULL OR trim(file_name)  = '' OR file_name  = '-'
              OR display_name IS NULL OR trim(display_name) = ''
              OR original_name IS NULL OR trim(original_name) = ''
              OR file_url IS NULL OR trim(file_url) = '' OR file_url = '-'
            );
        -- Broader ghost sweep: delete any row where file_data IS NULL
        DELETE FROM factory_shipping_container_documents WHERE file_data IS NULL;
        INSERT INTO migrations_log(key) VALUES ('shipping-docs-ghost-cleanup-v1');
      END IF;
    END $$`,
  // Archive table: bale links saved at cancellation time so restore can bring back exact references
  `CREATE TABLE IF NOT EXISTS customer_order_bales_history (
      id serial PRIMARY KEY,
      original_id integer NOT NULL,
      order_id integer NOT NULL,
      bale_id integer NOT NULL,
      bale_reference varchar(100) NOT NULL,
      location_id integer NOT NULL,
      weight decimal(15,3) NOT NULL,
      article_code varchar(50),
      bale_name text,
      price_used decimal(20,2) NOT NULL,
      scanned_by text,
      cancelled_at timestamptz NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS cobh_order_id_idx ON customer_order_bales_history (order_id)`,
  // Personal notes per user (private, cross-module)
  `CREATE TABLE IF NOT EXISTS user_notes (
      id serial PRIMARY KEY,
      user_id varchar NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      content text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  // ── AI Action Audit Log (Phase 1 chatbot upgrade) ────────────────────────
  `CREATE TABLE IF NOT EXISTS ai_action_log (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      user_id varchar NOT NULL,
      session_id varchar,
      prompt text,
      draft_json jsonb,
      action_type varchar(80),
      created_record_id integer,
      status varchar(20) DEFAULT 'confirmed',
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS ai_action_log_company_idx ON ai_action_log(company_id)`,
  `CREATE INDEX IF NOT EXISTS ai_action_log_user_idx ON ai_action_log(user_id)`,

  // ── Local Customer Bale Truck Dispatch Workflow (May 2026) ────────────────
  // customerProformas: add status column (ACTIVE / PARTIALLY_DISPATCHED / FULLY_INVOICED / CANCELLED)
  `ALTER TABLE customer_proformas ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE'`,
  // Backfill: inactive proformas → CANCELLED, active ones stay ACTIVE
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'customer-proformas-status-backfill-v1') THEN
        UPDATE customer_proformas SET status = 'CANCELLED' WHERE is_active = false AND status = 'ACTIVE';
        INSERT INTO migrations_log(key) VALUES ('customer-proformas-status-backfill-v1');
      END IF;
    END $$`,
  // customerOrders: back-link to the dispatch batch that generated this invoice
  `ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS dispatch_batch_id INTEGER`,
  // Batch number sequences (one row per company)
  `CREATE TABLE IF NOT EXISTS customer_dispatch_batch_sequences (
      company_id INTEGER PRIMARY KEY,
      next_number INTEGER NOT NULL DEFAULT 1
    )`,
  // Dispatch batches
  `CREATE TABLE IF NOT EXISTS customer_dispatch_batches (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      proforma_id INTEGER,
      batch_number VARCHAR(50) NOT NULL,
      batch_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      currency VARCHAR(3) NOT NULL DEFAULT 'USD',
      price_mode TEXT NOT NULL DEFAULT 'PER_BALE',
      destination TEXT,
      notes TEXT,
      final_order_id INTEGER,
      created_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      cancelled_at TIMESTAMP
    )`,
  `CREATE INDEX IF NOT EXISTS cdb_company_idx ON customer_dispatch_batches (company_id)`,
  `CREATE INDEX IF NOT EXISTS cdb_customer_idx ON customer_dispatch_batches (customer_id)`,
  `CREATE INDEX IF NOT EXISTS cdb_status_idx ON customer_dispatch_batches (status)`,
  // Truck rides
  `CREATE TABLE IF NOT EXISTS customer_dispatch_truck_rides (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      ride_number INTEGER NOT NULL,
      truck_plate VARCHAR(50),
      driver_name TEXT,
      destination TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      loaded_at TIMESTAMP,
      dispatched_at TIMESTAMP,
      reopened_at TIMESTAMP,
      reopen_reason TEXT,
      created_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )`,
  `CREATE INDEX IF NOT EXISTS cdtr_batch_idx ON customer_dispatch_truck_rides (batch_id)`,
  `CREATE INDEX IF NOT EXISTS cdtr_company_idx ON customer_dispatch_truck_rides (company_id)`,
  // Bale scans per truck ride
  `CREATE TABLE IF NOT EXISTS customer_dispatch_bale_scans (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      truck_ride_id INTEGER NOT NULL,
      bale_id INTEGER NOT NULL,
      bale_reference VARCHAR(100) NOT NULL,
      article_code VARCHAR(50),
      product_name TEXT,
      weight_kg DECIMAL(15,3) NOT NULL DEFAULT 0,
      price_used DECIMAL(20,2) NOT NULL DEFAULT 0,
      amount DECIMAL(20,2) NOT NULL DEFAULT 0,
      scanned_by TEXT,
      scanned_at TIMESTAMP NOT NULL DEFAULT now(),
      removed_at TIMESTAMP,
      removal_reason TEXT
    )`,
  `CREATE INDEX IF NOT EXISTS cdbs_batch_idx ON customer_dispatch_bale_scans (batch_id)`,
  `CREATE INDEX IF NOT EXISTS cdbs_ride_idx ON customer_dispatch_bale_scans (truck_ride_id)`,
  `CREATE INDEX IF NOT EXISTS cdbs_bale_idx ON customer_dispatch_bale_scans (bale_id)`,
  // Partial unique index: one active (non-removed) scan per bale across all batches
  `CREATE UNIQUE INDEX IF NOT EXISTS cdbs_bale_active_unique ON customer_dispatch_bale_scans (company_id, bale_id) WHERE removed_at IS NULL`,
];
