import { supplierTrackingDefaultsSchema } from "../startup-schema/028-supplier-tracking-defaults";

const FACTORY_STAFF_TRACKING_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS factory_staff_tracking_entries (
    id serial PRIMARY KEY,
    company_id integer NOT NULL,
    page_type varchar(20) NOT NULL,
    period_type varchar(20) NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    person_type varchar(20) NOT NULL,
    person_id integer NOT NULL,
    category varchar(150),
    target_bales numeric(12, 2),
    produced_bales numeric(12, 2),
    status varchar(20) NOT NULL DEFAULT 'Present',
    notes text,
    created_by varchar(255),
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_staff_tracking_page_check CHECK (page_type IN ('production', 'attendance')),
    CONSTRAINT factory_staff_tracking_period_check CHECK (period_type IN ('daily', 'weekly', 'monthly')),
    CONSTRAINT factory_staff_tracking_person_check CHECK (person_type IN ('worker', 'employee')),
    CONSTRAINT factory_staff_tracking_status_check CHECK (status IN ('Present', 'Absent', 'New')),
    CONSTRAINT factory_staff_tracking_period_order_check CHECK (period_end >= period_start),
    CONSTRAINT factory_staff_tracking_target_nonnegative CHECK (target_bales IS NULL OR target_bales >= 0),
    CONSTRAINT factory_staff_tracking_produced_nonnegative CHECK (produced_bales IS NULL OR produced_bales >= 0)
  )
`;

const FACTORY_STAFF_TRACKING_LOCK_SCHEMA_SQL = `
  ALTER TABLE factory_staff_tracking_entries
    ADD COLUMN IF NOT EXISTS group_name varchar(200);

  ALTER TABLE factory_staff_tracking_entries
    ADD COLUMN IF NOT EXISTS target_overridden boolean NOT NULL DEFAULT false;

  -- Existing saved daily rows predate category defaults, so preserve their
  -- stored category as a day-specific override. New rows default to false.
  ALTER TABLE factory_staff_tracking_entries
    ADD COLUMN IF NOT EXISTS category_overridden boolean NOT NULL DEFAULT true;

  ALTER TABLE factory_staff_tracking_entries
    ALTER COLUMN category_overridden SET DEFAULT false;

  ALTER TABLE factory_staff_tracking_entries
    ALTER COLUMN created_by TYPE varchar(255)
    USING created_by::text;

  CREATE TABLE IF NOT EXISTS factory_staff_tracking_period_closures (
    id serial PRIMARY KEY,
    company_id integer NOT NULL,
    page_type varchar(20) NOT NULL,
    period_type varchar(20) NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    ended_by varchar(255),
    ended_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_staff_tracking_closure_page_check CHECK (page_type IN ('production', 'attendance')),
    CONSTRAINT factory_staff_tracking_closure_period_check CHECK (period_type IN ('daily', 'weekly', 'monthly')),
    CONSTRAINT factory_staff_tracking_closure_period_order_check CHECK (period_end >= period_start),
    CONSTRAINT factory_staff_tracking_closure_unique UNIQUE
      (company_id, page_type, period_type, period_start, period_end)
  );

  ALTER TABLE factory_staff_tracking_period_closures
    ALTER COLUMN ended_by TYPE varchar(255)
    USING ended_by::text;
`;

const FACTORY_WORKER_PRODUCTION_TARGET_DEFAULTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS factory_worker_production_target_defaults (
    id serial PRIMARY KEY,
    company_id integer NOT NULL,
    worker_id integer NOT NULL,
    effective_from date NOT NULL,
    category varchar(150),
    target_bales numeric(12, 2),
    created_by varchar(255),
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_worker_production_target_default_nonnegative
      CHECK (target_bales IS NULL OR target_bales >= 0)
  );

  ALTER TABLE factory_worker_production_target_defaults
    ADD COLUMN IF NOT EXISTS category varchar(150);

  CREATE UNIQUE INDEX IF NOT EXISTS factory_worker_production_target_default_unique
    ON factory_worker_production_target_defaults (company_id, worker_id, effective_from);

  CREATE INDEX IF NOT EXISTS factory_worker_production_target_default_lookup_idx
    ON factory_worker_production_target_defaults (company_id, worker_id, effective_from DESC);
`;


const FACTORY_WORKER_PRODUCTION_LINKS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS factory_worker_production_links (
    id serial PRIMARY KEY,
    company_id integer NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_by varchar(255),
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_worker_production_link_period_check
      CHECK (effective_to IS NULL OR effective_to >= effective_from)
  );

  CREATE INDEX IF NOT EXISTS factory_worker_production_link_lookup_idx
    ON factory_worker_production_links (company_id, effective_from, effective_to);

  CREATE TABLE IF NOT EXISTS factory_worker_production_link_members (
    id serial PRIMARY KEY,
    link_id integer NOT NULL REFERENCES factory_worker_production_links(id) ON DELETE CASCADE,
    company_id integer NOT NULL,
    worker_id integer NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_worker_production_link_member_unique UNIQUE (link_id, worker_id)
  );

  CREATE INDEX IF NOT EXISTS factory_worker_production_link_member_lookup_idx
    ON factory_worker_production_link_members (company_id, worker_id, link_id);

  CREATE TABLE IF NOT EXISTS factory_worker_production_link_target_defaults (
    id serial PRIMARY KEY,
    link_id integer NOT NULL REFERENCES factory_worker_production_links(id) ON DELETE CASCADE,
    company_id integer NOT NULL,
    effective_from date NOT NULL,
    target_bales numeric(12, 2),
    created_by varchar(255),
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_worker_production_link_target_nonnegative
      CHECK (target_bales IS NULL OR target_bales >= 0),
    CONSTRAINT factory_worker_production_link_target_unique UNIQUE (link_id, effective_from)
  );

  CREATE INDEX IF NOT EXISTS factory_worker_production_link_target_lookup_idx
    ON factory_worker_production_link_target_defaults (company_id, link_id, effective_from DESC);
`;


const FACTORY_TARGET_BONUS_SCHEMA_SQL = `
  -- Bonus proposals are audit records only. A separate payment phase will
  -- deliberately select approved, unposted snapshots; no voucher is made here.
  CREATE TABLE IF NOT EXISTS factory_target_bonus_rates (
    id serial PRIMARY KEY,
    company_id integer NOT NULL,
    worker_id integer NOT NULL,
    effective_from date NOT NULL,
    rate_per_bale numeric(16,4) NOT NULL CHECK (rate_per_bale > 0),
    created_by varchar(255),
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_target_bonus_rate_unique
      UNIQUE (company_id, worker_id, effective_from)
  );
  CREATE INDEX IF NOT EXISTS factory_target_bonus_rate_history_idx
    ON factory_target_bonus_rates (company_id, worker_id, effective_from DESC);

  CREATE TABLE IF NOT EXISTS factory_target_bonus_reviews (
    id serial PRIMARY KEY,
    company_id integer NOT NULL,
    production_date date NOT NULL,
    worker_id integer NOT NULL,
    target_bales numeric(12,2) NOT NULL CHECK (target_bales >= 0),
    produced_bales integer NOT NULL CHECK (produced_bales >= 0),
    extra_bales numeric(12,2) NOT NULL CHECK (extra_bales >= 0),
    rate_per_bale numeric(16,4) NOT NULL CHECK (rate_per_bale >= 0),
    bonus_amount numeric(18,2) NOT NULL CHECK (bonus_amount >= 0),
    status varchar(12) NOT NULL CHECK (status IN ('approved', 'rejected')),
    reviewed_by varchar(255) NOT NULL,
    reviewed_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_target_bonus_review_unique
      UNIQUE (company_id, production_date, worker_id)
  );
  CREATE INDEX IF NOT EXISTS factory_target_bonus_review_history_idx
    ON factory_target_bonus_reviews (company_id, production_date DESC, status);
`;

/**
 * Phase 2: effective-dated, append-only rates for the Production Targets bonus.
 * This is separate from position-planner/payroll bonus rules. Neither rate
 * changes nor previews post any accounting movement.
 */
const FACTORY_PRODUCTION_TARGET_BONUS_RATES_SQL = `
  CREATE TABLE IF NOT EXISTS factory_production_target_bonus_rates (
    id serial PRIMARY KEY,
    company_id integer NOT NULL,
    scope varchar(12) NOT NULL CHECK (scope IN ('company', 'worker')),
    worker_id integer REFERENCES factory_workers(id) ON DELETE RESTRICT,
    effective_from date NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    rate_per_extra_bale numeric(20, 4) NOT NULL DEFAULT 0
      CHECK (rate_per_extra_bale >= 0 AND rate_per_extra_bale <= 10000),
    note varchar(500),
    request_key varchar(128) NOT NULL,
    created_by varchar(255),
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT factory_production_target_bonus_scope_check
      CHECK ((scope = 'company' AND worker_id IS NULL) OR (scope = 'worker' AND worker_id IS NOT NULL))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS factory_production_target_bonus_req_unique
    ON factory_production_target_bonus_rates (company_id, request_key);

  CREATE INDEX IF NOT EXISTS factory_production_target_bonus_history_idx
    ON factory_production_target_bonus_rates (company_id, worker_id, effective_from DESC, id DESC);
`;

/**
 * Phase 8: append-only category-specific bonus amounts, isolated from the
 * already-approved Phase 1-7 worker/day payout contract. A category version
 * is NOT a payable claim and never books an expense or cash movement.
 */
const FACTORY_PRODUCTION_TARGET_BONUS_CATEGORY_RATES_SQL = `
  CREATE TABLE IF NOT EXISTS factory_production_target_bonus_category_rates (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    category_key VARCHAR(100) NOT NULL,
    category_label VARCHAR(100) NOT NULL,
    effective_from DATE NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    rate_per_extra_bale NUMERIC(20,4) NOT NULL DEFAULT 0
      CHECK (rate_per_extra_bale >= 0 AND rate_per_extra_bale <= 10000),
    note VARCHAR(500),
    request_key VARCHAR(128) NOT NULL,
    created_by VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_bonus_category_key_not_empty CHECK (BTRIM(category_key) <> ''),
    CONSTRAINT factory_bonus_category_rate_request_key_unique UNIQUE (company_id, request_key)
  );
  CREATE INDEX IF NOT EXISTS factory_bonus_category_rate_effective_idx
    ON factory_production_target_bonus_category_rates
      (company_id, category_key, effective_from DESC, id DESC);
`;


/** Phase 12: versioned company-wide bonus method per Monday-Sunday production week.
 * This is configuration only. Existing per-bale approval and payment paths are
 * unchanged until weekly claim, review and accounting integration is certified.
 */
const FACTORY_PRODUCTION_TARGET_BONUS_WEEKLY_METHOD_SQL = `
  CREATE TABLE IF NOT EXISTS factory_production_target_bonus_weekly_methods (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    effective_week DATE NOT NULL,
    method VARCHAR(20) NOT NULL CHECK (method IN ('per_extra_bale', 'weekly_flat')),
    flat_bonus_usd NUMERIC(20,2) NOT NULL DEFAULT 0
      CHECK (flat_bonus_usd >= 0 AND flat_bonus_usd <= 100000),
    note VARCHAR(500),
    request_key VARCHAR(128) NOT NULL,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT factory_bonus_weekly_method_amount_check CHECK (
      (method = 'per_extra_bale' AND flat_bonus_usd = 0) OR
      (method = 'weekly_flat' AND flat_bonus_usd > 0)
    ),
    CONSTRAINT factory_bonus_weekly_method_monday_check
      CHECK (EXTRACT(ISODOW FROM effective_week) = 1),
    CONSTRAINT factory_bonus_weekly_method_request_unique UNIQUE (company_id, request_key)
  );
  CREATE INDEX IF NOT EXISTS factory_bonus_weekly_method_history_idx
    ON factory_production_target_bonus_weekly_methods (company_id, effective_week DESC, id DESC);
  CREATE OR REPLACE FUNCTION prevent_bonus_weekly_method_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $
    BEGIN
      RAISE EXCEPTION 'Production bonus weekly method versions are immutable';
    END;
    $;
  DO $
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'factory_bonus_weekly_method_immutable'
        AND tgrelid = 'factory_production_target_bonus_weekly_methods'::regclass
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER factory_bonus_weekly_method_immutable
        BEFORE UPDATE OR DELETE ON factory_production_target_bonus_weekly_methods
        FOR EACH ROW EXECUTE FUNCTION prevent_bonus_weekly_method_mutation();
    END IF;
  END
  $;
`;

/** Phase 9: frozen physical-bale category evidence and one target claim per
 * worker/day. Captured in the same transaction that locks End Production.
 * Historical days never gain fabricated evidence by re-reading changed bales.
 */
const FACTORY_BONUS_CATEGORY_EVIDENCE_SQL = `
  CREATE TABLE IF NOT EXISTS factory_target_bonus_category_day_captures (
    company_id INTEGER NOT NULL,
    production_date DATE NOT NULL,
    captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
    captured_by VARCHAR(255),
    PRIMARY KEY (company_id, production_date)
  );
  CREATE TABLE IF NOT EXISTS factory_target_bonus_category_bale_snapshots (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    production_date DATE NOT NULL,
    bale_id INTEGER NOT NULL,
    worker_id INTEGER NOT NULL,
    category_label TEXT,
    finalized_at TIMESTAMP,
    source_stock_date DATE NOT NULL,
    captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_bonus_bale_once_per_day UNIQUE (company_id, production_date, bale_id),
    CONSTRAINT factory_bonus_bale_capture_fk
      FOREIGN KEY (company_id, production_date)
      REFERENCES factory_target_bonus_category_day_captures(company_id, production_date)
      ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS factory_bonus_category_bale_worker_idx
    ON factory_target_bonus_category_bale_snapshots
      (company_id, production_date, worker_id);
  CREATE TABLE IF NOT EXISTS factory_target_bonus_category_allocation_sets (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    production_date DATE NOT NULL,
    worker_id INTEGER NOT NULL,
    daily_target_bales NUMERIC(12,2) NOT NULL CHECK (daily_target_bales >= 0),
    allocated_by VARCHAR(255) NOT NULL,
    allocated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_bonus_category_set_unique
      UNIQUE (company_id, production_date, worker_id),
    CONSTRAINT factory_bonus_category_set_capture_fk
      FOREIGN KEY (company_id, production_date)
      REFERENCES factory_target_bonus_category_day_captures(company_id, production_date)
      ON DELETE RESTRICT
  );
  CREATE TABLE IF NOT EXISTS factory_target_bonus_category_allocations (
    id BIGSERIAL PRIMARY KEY,
    allocation_set_id BIGINT NOT NULL REFERENCES factory_target_bonus_category_allocation_sets(id)
      ON DELETE RESTRICT,
    category_key VARCHAR(100) NOT NULL,
    category_label VARCHAR(100) NOT NULL,
    credited_bales INTEGER NOT NULL CHECK (credited_bales >= 0),
    target_bales NUMERIC(12,2) NOT NULL CHECK (target_bales >= 0),
    CONSTRAINT factory_bonus_category_once_per_set UNIQUE (allocation_set_id, category_key)
  );
`;

/** Phase 11: immutable reviewed category bonuses; no category money movement yet. */
const FACTORY_BONUS_CATEGORY_REVIEW_SQL = `
  CREATE TABLE IF NOT EXISTS factory_target_bonus_category_reviews (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    production_date DATE NOT NULL,
    worker_id INTEGER NOT NULL REFERENCES factory_workers(id) ON DELETE RESTRICT,
    allocation_set_id BIGINT NOT NULL REFERENCES factory_target_bonus_category_allocation_sets(id) ON DELETE RESTRICT,
    calculation_version VARCHAR(80) NOT NULL,
    currency_code VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency_code = 'USD'),
    target_bales NUMERIC(12,2) NOT NULL CHECK (target_bales > 0),
    credited_bales INTEGER NOT NULL CHECK (credited_bales >= 0),
    extra_bales NUMERIC(12,2) NOT NULL CHECK (extra_bales >= 0),
    bonus_amount NUMERIC(18,2) NOT NULL CHECK (bonus_amount > 0),
    status VARCHAR(12) NOT NULL CHECK (status IN ('approved','rejected')),
    snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
    snapshot_hash CHAR(64) NOT NULL,
    reviewed_by VARCHAR(255) NOT NULL,
    reviewed_at TIMESTAMP NOT NULL DEFAULT now(),
    review_note VARCHAR(500),
    CONSTRAINT factory_bonus_category_review_one_worker_day UNIQUE (company_id, production_date, worker_id),
    CONSTRAINT factory_bonus_category_review_hash_format CHECK (snapshot_hash ~ '^[a-f0-9]{64}$')
  );
  CREATE INDEX IF NOT EXISTS factory_bonus_category_reviews_history_idx
    ON factory_target_bonus_category_reviews(company_id, production_date DESC, worker_id);
  CREATE OR REPLACE FUNCTION prevent_category_bonus_review_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Category bonus reviews are immutable';
    END;
    $$;
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'factory_bonus_category_review_immutable'
        AND tgrelid = 'factory_target_bonus_category_reviews'::regclass AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER factory_bonus_category_review_immutable
        BEFORE UPDATE OR DELETE ON factory_target_bonus_category_reviews
        FOR EACH ROW EXECUTE FUNCTION prevent_category_bonus_review_mutation();
    END IF;
  END
  $$;
`;

/** Phase 14: approved/rejected weekly worker decisions are immutable audit-only records. */
const FACTORY_BONUS_WEEKLY_REVIEW_SQL = `
  CREATE TABLE IF NOT EXISTS factory_target_bonus_weekly_reviews (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    worker_id INTEGER NOT NULL REFERENCES factory_workers(id) ON DELETE RESTRICT,
    method_version_id BIGINT NOT NULL REFERENCES factory_production_target_bonus_weekly_methods(id) ON DELETE RESTRICT,
    calculation_version VARCHAR(80) NOT NULL,
    currency_code CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency_code = 'USD'),
    worker_name_snapshot TEXT NOT NULL,
    target_bales NUMERIC(12,2) NOT NULL CHECK (target_bales > 0),
    credited_bales INTEGER NOT NULL CHECK (credited_bales >= 0),
    extra_bales NUMERIC(12,2) NOT NULL CHECK (extra_bales > 0),
    bonus_amount NUMERIC(18,2) NOT NULL CHECK (bonus_amount > 0),
    status VARCHAR(12) NOT NULL CHECK (status IN ('approved','rejected')),
    snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
    snapshot_hash CHAR(64) NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}
  FACTORY_STAFF_TRACKING_TABLE_SQL,
  `CREATE UNIQUE INDEX IF NOT EXISTS factory_staff_tracking_unique_period_person
   ON factory_staff_tracking_entries
     (company_id, page_type, period_type, period_start, period_end, person_type, person_id)`,
  `CREATE INDEX IF NOT EXISTS factory_staff_tracking_company_period_idx
   ON factory_staff_tracking_entries (company_id, page_type, period_start, period_end)`,
];

type StartupQueryable = {
  query: (queryText: string) => Promise<unknown>;
};

export async function ensureFactoryStaffTrackingSchema(database: StartupQueryable): Promise<void> {
  for (const statement of factoryStaffTrackingSchema) {
    await database.query(statement);
  }

  // Keep the pinned startupMigrations array stable while still applying the
  // production-day locking schema on every boot. Production calls this ensure
  // path unconditionally even when the bulk startup migration pass is disabled.
  await database.query(FACTORY_STAFF_TRACKING_LOCK_SCHEMA_SQL);

  // Daily worker targets are versioned by effective date. A new default applies
  // to that day and future days without rewriting any historical day snapshots.
  await database.query(FACTORY_WORKER_PRODUCTION_TARGET_DEFAULTS_SCHEMA_SQL);

  // Linked production workers use effective-dated membership and one shared
  // target history, so unlinking never rewrites earlier production days.
  await database.query(FACTORY_WORKER_PRODUCTION_LINKS_SCHEMA_SQL);

  // Core effective-dated bonus rates are ensured before approvals and payments.
  await database.query(FACTORY_PRODUCTION_TARGET_BONUS_RATES_SQL);

  // Category settings are created on every boot but do not affect payable bonus rows.
  await database.query(FACTORY_PRODUCTION_TARGET_BONUS_CATEGORY_RATES_SQL);

  // Company weekly method settings are append-only and never trigger payouts.
  await database.query(FACTORY_PRODUCTION_TARGET_BONUS_WEEKLY_METHOD_SQL);

  // Immutable bale evidence and explicit daily target splits for Phase 9.
  await database.query(FACTORY_BONUS_CATEGORY_EVIDENCE_SQL);

  // Production Targets review tables are required even without bulk migrations.
  await database.query(FACTORY_TARGET_BONUS_SCHEMA_SQL);

  // Ensure immutable Phase 11 category reviews after their allocation and legacy schemas.
  await database.query(FACTORY_BONUS_CATEGORY_REVIEW_SQL);

  // Phase 14 weekly audit records are ensured after method and daily review tables.
  await database.query(FACTORY_BONUS_WEEKLY_REVIEW_SQL);

  // Production can run with RUN_STARTUP_MIGRATIONS=false. Supplier tracking
  // defaults are required by ordinary ERP requests, so ensure their idempotent
  // table/index/function/trigger stage here as part of the same unconditional
  // startup path instead of requiring a manual SQL deploy.
  for (const statement of supplierTrackingDefaultsSchema) {
    await database.query(statement);
  }
}
),
    reviewed_by VARCHAR(255) NOT NULL,
    reviewed_at TIMESTAMP NOT NULL DEFAULT now(),
    review_note VARCHAR(500),
    CONSTRAINT factory_bonus_weekly_one_worker_week UNIQUE (company_id, week_start, worker_id),
    CONSTRAINT factory_bonus_weekly_monday CHECK (EXTRACT(ISODOW FROM week_start) = 1),
    CONSTRAINT factory_bonus_weekly_end CHECK (week_end = week_start + 6)
  );
  CREATE INDEX IF NOT EXISTS factory_bonus_weekly_review_history_idx
    ON factory_target_bonus_weekly_reviews (company_id, week_start DESC, worker_id);
  CREATE OR REPLACE FUNCTION prevent_weekly_bonus_review_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $
    BEGIN
      RAISE EXCEPTION 'Production bonus weekly reviews are immutable';
    END;
    $;
  DO $
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'factory_bonus_weekly_review_immutable'
      AND tgrelid = 'factory_target_bonus_weekly_reviews'::regclass AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER factory_bonus_weekly_review_immutable
        BEFORE UPDATE OR DELETE ON factory_target_bonus_weekly_reviews
        FOR EACH ROW EXECUTE FUNCTION prevent_weekly_bonus_review_mutation();
    END IF;
  END
  $;
`;

export const factoryStaffTrackingSchema = [
  FACTORY_STAFF_TRACKING_TABLE_SQL,
  `CREATE UNIQUE INDEX IF NOT EXISTS factory_staff_tracking_unique_period_person
   ON factory_staff_tracking_entries
     (company_id, page_type, period_type, period_start, period_end, person_type, person_id)`,
  `CREATE INDEX IF NOT EXISTS factory_staff_tracking_company_period_idx
   ON factory_staff_tracking_entries (company_id, page_type, period_start, period_end)`,
];

type StartupQueryable = {
  query: (queryText: string) => Promise<unknown>;
};

export async function ensureFactoryStaffTrackingSchema(database: StartupQueryable): Promise<void> {
  for (const statement of factoryStaffTrackingSchema) {
    await database.query(statement);
  }

  // Keep the pinned startupMigrations array stable while still applying the
  // production-day locking schema on every boot. Production calls this ensure
  // path unconditionally even when the bulk startup migration pass is disabled.
  await database.query(FACTORY_STAFF_TRACKING_LOCK_SCHEMA_SQL);

  // Daily worker targets are versioned by effective date. A new default applies
  // to that day and future days without rewriting any historical day snapshots.
  await database.query(FACTORY_WORKER_PRODUCTION_TARGET_DEFAULTS_SCHEMA_SQL);

  // Linked production workers use effective-dated membership and one shared
  // target history, so unlinking never rewrites earlier production days.
  await database.query(FACTORY_WORKER_PRODUCTION_LINKS_SCHEMA_SQL);

  // Core effective-dated bonus rates are ensured before approvals and payments.
  await database.query(FACTORY_PRODUCTION_TARGET_BONUS_RATES_SQL);

  // Category settings are created on every boot but do not affect payable bonus rows.
  await database.query(FACTORY_PRODUCTION_TARGET_BONUS_CATEGORY_RATES_SQL);

  // Company weekly method settings are append-only and never trigger payouts.
  await database.query(FACTORY_PRODUCTION_TARGET_BONUS_WEEKLY_METHOD_SQL);

  // Immutable bale evidence and explicit daily target splits for Phase 9.
  await database.query(FACTORY_BONUS_CATEGORY_EVIDENCE_SQL);

  // Production Targets review tables are required even without bulk migrations.
  await database.query(FACTORY_TARGET_BONUS_SCHEMA_SQL);

  // Ensure immutable Phase 11 category reviews after their allocation and legacy schemas.
  await database.query(FACTORY_BONUS_CATEGORY_REVIEW_SQL);

  // Production can run with RUN_STARTUP_MIGRATIONS=false. Supplier tracking
  // defaults are required by ordinary ERP requests, so ensure their idempotent
  // table/index/function/trigger stage here as part of the same unconditional
  // startup path instead of requiring a manual SQL deploy.
  for (const statement of supplierTrackingDefaultsSchema) {
    await database.query(statement);
  }
}
