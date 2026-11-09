/**
 * Independent truck verification records for one Factory customer loading.
 *
 * Option A: dispatch records are evidence only. These tables never mutate
 * customer_order_bales, factory_bales, inventory or accounting.
 *
 * Boot-time ensure is needed because production can skip bulk migrations.
 */
import type { Pool } from "pg";

export async function ensureFactoryLoadingDispatchSchema(pool: Pick<Pool, "query">): Promise<void> {
  // Composite keys make the company + order relationship enforceable by the DB,
  // rather than relying on route handlers to remember the scope.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_orders_id_company_dispatch_scope_uq
      ON customer_orders (id, company_id)
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS factory_bales_id_company_dispatch_scope_uq
      ON factory_bales (id, company_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_loading_dispatches (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      container_number_snapshot VARCHAR(100),
      dispatch_number INTEGER NOT NULL CHECK (dispatch_number > 0),
      status TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
      truck_plate VARCHAR(120),
      driver_name VARCHAR(200),
      destination TEXT,
      notes TEXT,
      created_by_user_id TEXT NOT NULL,
      created_by_username TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      closed_by_user_id TEXT,
      reopened_at TIMESTAMPTZ,
      reopened_by_user_id TEXT,
      reopen_reason TEXT,
      CONSTRAINT factory_loading_dispatch_order_fk
        FOREIGN KEY (order_id, company_id)
        REFERENCES customer_orders(id, company_id) ON DELETE RESTRICT,
      CONSTRAINT factory_loading_dispatch_order_number_uq
        UNIQUE (company_id, order_id, dispatch_number),
      CONSTRAINT factory_loading_dispatch_scope_uq
        UNIQUE (id, company_id, order_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_loading_dispatches_order_idx
      ON factory_loading_dispatches(company_id, order_id, created_at DESC)
  `);

  // Planned exact-bale allocations, set from the loading priority queue in
  // a later phase. A bale cannot be simultaneously expected on two trips.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_loading_dispatch_expected_bales (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      dispatch_id BIGINT NOT NULL,
      bale_id INTEGER NOT NULL,
      CONSTRAINT factory_loading_dispatch_expected_bale_scope_fk
        FOREIGN KEY (bale_id, company_id)
        REFERENCES factory_bales(id, company_id) ON DELETE RESTRICT,
      source TEXT NOT NULL DEFAULT 'PRIORITY',
      assigned_by_user_id TEXT,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      removed_at TIMESTAMPTZ,
      removed_by_user_id TEXT,
      removal_reason TEXT,
      CONSTRAINT factory_loading_dispatch_expected_parent_fk
        FOREIGN KEY (dispatch_id, company_id, order_id)
        REFERENCES factory_loading_dispatches(id, company_id, order_id) ON DELETE RESTRICT
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS factory_loading_dispatch_expected_one_trip_uq
      ON factory_loading_dispatch_expected_bales(company_id, order_id, bale_id)
      WHERE removed_at IS NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_loading_dispatch_expected_trip_idx
      ON factory_loading_dispatch_expected_bales(dispatch_id)
      WHERE removed_at IS NULL
  `);

  // Article-level trip targets for priority queues that allocate product
  // quantities before exact bale references become known.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_loading_dispatch_expected_articles (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      dispatch_id BIGINT NOT NULL,
      article_code TEXT NOT NULL,
      product_name TEXT,
      expected_qty INTEGER NOT NULL CHECK (expected_qty >= 0),
      priority_rank INTEGER,
      source TEXT NOT NULL DEFAULT 'PRIORITY',
      assigned_by_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT factory_loading_dispatch_expected_article_parent_fk
        FOREIGN KEY (dispatch_id, company_id, order_id)
        REFERENCES factory_loading_dispatches(id, company_id, order_id) ON DELETE RESTRICT,
      CONSTRAINT factory_loading_dispatch_expected_article_uq
        UNIQUE (dispatch_id, article_code)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_loading_dispatch_expected_articles_order_idx
      ON factory_loading_dispatch_expected_articles(company_id, order_id, dispatch_id)
  `);

  // Snapshot every physical scan for an auditable truck manifest. These are
  // separate from the main loading scan and have no stock or ledger effects.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_loading_dispatch_scans (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      dispatch_id BIGINT NOT NULL,
      bale_id INTEGER NOT NULL,
      CONSTRAINT factory_loading_dispatch_scan_bale_scope_fk
        FOREIGN KEY (bale_id, company_id)
        REFERENCES factory_bales(id, company_id) ON DELETE RESTRICT,
      bale_reference TEXT NOT NULL,
      article_code TEXT,
      product_name TEXT,
      weight_kg NUMERIC(18, 3) NOT NULL CHECK (weight_kg >= 0),
      scanned_by_user_id TEXT NOT NULL,
      scanned_by_username TEXT NOT NULL,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      removed_at TIMESTAMPTZ,
      removed_by_user_id TEXT,
      removal_reason TEXT,
      CONSTRAINT factory_loading_dispatch_scan_parent_fk
        FOREIGN KEY (dispatch_id, company_id, order_id)
        REFERENCES factory_loading_dispatches(id, company_id, order_id) ON DELETE RESTRICT
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS factory_loading_dispatch_scan_no_duplicate_uq
      ON factory_loading_dispatch_scans(company_id, order_id, bale_id)
      WHERE removed_at IS NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_loading_dispatch_scans_trip_idx
      ON factory_loading_dispatch_scans(dispatch_id, scanned_at DESC)
      WHERE removed_at IS NULL
  `);

  // Immutable-by-revision closure evidence. Reopen updates only its review
  // metadata; the signed snapshot and the original actor/time never change.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_loading_dispatch_closure_history (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      dispatch_id BIGINT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      close_fingerprint VARCHAR(64) NOT NULL,
      comparison_snapshot JSONB NOT NULL,
      summary_snapshot JSONB NOT NULL,
      issues_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      approved_with_discrepancies BOOLEAN NOT NULL DEFAULT FALSE,
      discrepancy_reason TEXT,
      closed_by_user_id TEXT NOT NULL,
      closed_by_username TEXT NOT NULL,
      closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reopened_at TIMESTAMPTZ,
      reopened_by_user_id TEXT,
      reopened_by_username TEXT,
      reopen_reason TEXT,
      CONSTRAINT factory_loading_dispatch_closure_parent_fk
        FOREIGN KEY (dispatch_id, company_id, order_id)
        REFERENCES factory_loading_dispatches(id, company_id, order_id) ON DELETE RESTRICT,
      CONSTRAINT factory_loading_dispatch_closure_revision_uq
        UNIQUE (dispatch_id, revision)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_loading_dispatch_closure_order_idx
      ON factory_loading_dispatch_closure_history
        (company_id, order_id, dispatch_id, closed_at DESC)
  `);

  // Append-only operational events (create, assign, scan, close, reopen etc.).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_loading_dispatch_events (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      dispatch_id BIGINT NOT NULL,
      event_type TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      actor_username TEXT NOT NULL,
      event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT factory_loading_dispatch_event_parent_fk
        FOREIGN KEY (dispatch_id, company_id, order_id)
        REFERENCES factory_loading_dispatches(id, company_id, order_id) ON DELETE RESTRICT
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_loading_dispatch_events_trip_idx
      ON factory_loading_dispatch_events(dispatch_id, created_at DESC)
  `);
}