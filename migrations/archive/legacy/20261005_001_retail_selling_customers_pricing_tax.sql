-- Retail Wave 2, Tracks A-C: optional customer on retail sales, separated
-- original/discount/final pricing snapshots, manager-approved discounts and a
-- disabled-by-default tax foundation. Every statement is idempotent; existing
-- rows keep their current values (walk-in, no discount, no tax).

-- Tables first: the sale columns below reference the promotion and approval tables.
CREATE TABLE IF NOT EXISTS "retail_pos_settings" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL UNIQUE REFERENCES "companies"("id") ON DELETE CASCADE,
  "discount_limit_percent" numeric(6,2) NOT NULL DEFAULT '10',
  "require_manager_approval" boolean NOT NULL DEFAULT true,
  "price_override_requires_approval" boolean NOT NULL DEFAULT true,
  "tax_enabled" boolean NOT NULL DEFAULT false,
  "tax_label" varchar(40) NOT NULL DEFAULT 'Tax',
  "tax_rate" numeric(8,5) NOT NULL DEFAULT '0',
  "tax_inclusive" boolean NOT NULL DEFAULT false,
  "updated_by" varchar(255),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "retail_pos_settings_company_idx" ON "retail_pos_settings" ("company_id");

CREATE TABLE IF NOT EXISTS "retail_promotions" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" varchar(160) NOT NULL,
  "description" text,
  "scope" varchar(20) NOT NULL DEFAULT 'all',
  "brand_id" integer REFERENCES "retail_brands"("id") ON DELETE CASCADE,
  "product_id" integer REFERENCES "retail_products"("id") ON DELETE CASCADE,
  "variant_id" integer REFERENCES "retail_product_variants"("id") ON DELETE CASCADE,
  "discount_type" varchar(20) NOT NULL,
  "value" numeric(20,6) NOT NULL,
  "starts_at" timestamp,
  "ends_at" timestamp,
  "active" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 0,
  "created_by" varchar(255) REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "retail_promotions_company_idx" ON "retail_promotions" ("company_id");
CREATE INDEX IF NOT EXISTS "retail_promotions_company_active_idx" ON "retail_promotions" ("company_id", "active");
CREATE INDEX IF NOT EXISTS "retail_promotions_company_window_idx"
  ON "retail_promotions" ("company_id", "starts_at", "ends_at");

CREATE TABLE IF NOT EXISTS "retail_discount_approvals" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "token_id" varchar(64) NOT NULL,
  "manager_user_id" varchar(255) NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "manager_name" text NOT NULL,
  "cashier_user_id" varchar(255) NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" text,
  "requested_discount_percent" numeric(6,2) NOT NULL DEFAULT '0',
  "allows_price_override" boolean NOT NULL DEFAULT false,
  "expires_at" timestamp NOT NULL,
  "consumed_sale_id" integer,
  "consumed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "retail_discount_approvals_company_token_unique"
  ON "retail_discount_approvals" ("company_id", "token_id");
CREATE INDEX IF NOT EXISTS "retail_discount_approvals_company_idx" ON "retail_discount_approvals" ("company_id");
CREATE INDEX IF NOT EXISTS "retail_discount_approvals_manager_idx" ON "retail_discount_approvals" ("manager_user_id");

ALTER TABLE "retail_pos_sales"
  ADD COLUMN IF NOT EXISTS "customer_id" integer REFERENCES "customers"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "customer_name" varchar(191) NOT NULL DEFAULT 'Walk-in',
  ADD COLUMN IF NOT EXISTS "list_subtotal" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "discount_total" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "subtotal" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "order_discount_type" varchar(20) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "order_discount_value" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "order_discount_amount" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "order_discount_reason" text,
  ADD COLUMN IF NOT EXISTS "tax_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "tax_label" varchar(40) NOT NULL DEFAULT 'Tax',
  ADD COLUMN IF NOT EXISTS "tax_rate" numeric(8,5) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "tax_inclusive" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "tax_amount" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "approval_id" integer REFERENCES "retail_discount_approvals"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" varchar(255),
  ADD COLUMN IF NOT EXISTS "approved_by_name" text;

-- Existing sales become faithfully walk-in, undiscounted, untaxed history:
-- their historical total is their subtotal and list subtotal.
UPDATE "retail_pos_sales"
   SET "list_subtotal" = "total_amount",
       "subtotal" = "total_amount"
 WHERE "list_subtotal" = '0' AND "subtotal" = '0' AND "total_amount" <> '0';

ALTER TABLE "retail_pos_sale_items"
  ADD COLUMN IF NOT EXISTS "original_unit_price" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "gross_unit_price" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "line_discount_amount" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "line_discount_type" varchar(20) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "line_discount_value" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "discount_reason" text,
  ADD COLUMN IF NOT EXISTS "price_override" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "promotion_id" integer REFERENCES "retail_promotions"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "tax_amount" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "line_total" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" varchar(255);

-- Historical lines: the price they were sold at is both the original and the paid price.
UPDATE "retail_pos_sale_items"
   SET "original_unit_price" = "unit_price",
       "gross_unit_price" = "unit_price",
       "line_total" = ("unit_price" * "quantity")
 WHERE "original_unit_price" = '0' AND "line_total" = '0' AND "unit_price" <> '0';

ALTER TABLE "retail_pos_returns"
  ADD COLUMN IF NOT EXISTS "refund_amount" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "refund_tax_amount" numeric(20,6) NOT NULL DEFAULT '0';

ALTER TABLE "retail_pos_return_items"
  ADD COLUMN IF NOT EXISTS "gross_unit_price" numeric(20,6) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "tax_amount" numeric(20,6) NOT NULL DEFAULT '0';

UPDATE "retail_pos_return_items"
   SET "gross_unit_price" = "unit_price"
 WHERE "gross_unit_price" = '0' AND "unit_price" <> '0';

CREATE INDEX IF NOT EXISTS "retail_pos_sales_customer_idx" ON "retail_pos_sales" ("customer_id");
CREATE INDEX IF NOT EXISTS "retail_pos_sales_company_created_idx" ON "retail_pos_sales" ("company_id", "created_at");
