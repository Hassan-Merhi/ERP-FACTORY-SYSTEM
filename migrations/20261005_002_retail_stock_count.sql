-- Retail Wave 2, Track D: dedicated physical stock-count sessions.
--
-- A session belongs to one company + location and walks
-- Draft → Counting → Review → Recount (as needed) → Finalized. Finalizing writes
-- retail_stock_movements rows of type 'stock_count' that reference the session, so
-- inventory is never overwritten without a movement.

CREATE TABLE IF NOT EXISTS "retail_stock_count_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "location_id" integer NOT NULL REFERENCES "locations"("id") ON DELETE RESTRICT,
  "code" varchar(60) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'draft',
  "notes" text,
  "snapshot_at" timestamp,
  "counting_started_at" timestamp,
  "review_started_at" timestamp,
  "finalized_at" timestamp,
  "canceled_at" timestamp,
  "created_by" varchar(255) NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "finalized_by" varchar(255) REFERENCES "users"("id") ON DELETE RESTRICT,
  "canceled_by" varchar(255) REFERENCES "users"("id") ON DELETE RESTRICT,
  "line_count" integer NOT NULL DEFAULT 0,
  "counted_line_count" integer NOT NULL DEFAULT 0,
  "uncounted_line_count" integer NOT NULL DEFAULT 0,
  "variance_line_count" integer NOT NULL DEFAULT 0,
  "unexpected_line_count" integer NOT NULL DEFAULT 0,
  "recount_line_count" integer NOT NULL DEFAULT 0,
  "expected_quantity_total" numeric(20,6) NOT NULL DEFAULT '0',
  "counted_quantity_total" numeric(20,6) NOT NULL DEFAULT '0',
  "variance_quantity_total" numeric(20,6) NOT NULL DEFAULT '0',
  "variance_value_total" numeric(20,6) NOT NULL DEFAULT '0',
  "finalized_result" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "retail_stock_count_sessions_company_code_unique"
  ON "retail_stock_count_sessions" ("company_id", "code");
CREATE INDEX IF NOT EXISTS "retail_stock_count_sessions_company_idx"
  ON "retail_stock_count_sessions" ("company_id");
CREATE INDEX IF NOT EXISTS "retail_stock_count_sessions_company_status_idx"
  ON "retail_stock_count_sessions" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "retail_stock_count_sessions_location_idx"
  ON "retail_stock_count_sessions" ("location_id");

CREATE TABLE IF NOT EXISTS "retail_stock_count_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "session_id" integer NOT NULL REFERENCES "retail_stock_count_sessions"("id") ON DELETE CASCADE,
  "variant_id" integer NOT NULL REFERENCES "retail_product_variants"("id") ON DELETE RESTRICT,
  "expected_quantity" numeric(20,6) NOT NULL DEFAULT '0',
  "counted_quantity" numeric(20,6),
  "status" varchar(20) NOT NULL DEFAULT 'uncounted',
  "recount_required" boolean NOT NULL DEFAULT false,
  "notes" text,
  "expected_live_quantity" numeric(20,6),
  "variance_quantity" numeric(20,6),
  "movement_delta" numeric(20,6),
  "counted_by" varchar(255) REFERENCES "users"("id") ON DELETE RESTRICT,
  "counted_at" timestamp,
  "last_scanned_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "retail_stock_count_lines_session_variant_unique"
  ON "retail_stock_count_lines" ("session_id", "variant_id");
CREATE INDEX IF NOT EXISTS "retail_stock_count_lines_company_idx" ON "retail_stock_count_lines" ("company_id");
CREATE INDEX IF NOT EXISTS "retail_stock_count_lines_session_idx" ON "retail_stock_count_lines" ("session_id");
CREATE INDEX IF NOT EXISTS "retail_stock_count_lines_status_idx" ON "retail_stock_count_lines" ("status");

CREATE TABLE IF NOT EXISTS "retail_stock_count_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "session_id" integer NOT NULL REFERENCES "retail_stock_count_sessions"("id") ON DELETE CASCADE,
  "line_id" integer REFERENCES "retail_stock_count_lines"("id") ON DELETE SET NULL,
  "variant_id" integer REFERENCES "retail_product_variants"("id") ON DELETE SET NULL,
  "event_type" varchar(40) NOT NULL,
  "previous_quantity" numeric(20,6),
  "quantity" numeric(20,6),
  "delta" numeric(20,6),
  "note" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by" varchar(255) NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "retail_stock_count_events_company_idx" ON "retail_stock_count_events" ("company_id");
CREATE INDEX IF NOT EXISTS "retail_stock_count_events_session_idx" ON "retail_stock_count_events" ("session_id");
CREATE INDEX IF NOT EXISTS "retail_stock_count_events_created_at_idx" ON "retail_stock_count_events" ("created_at");
