CREATE TABLE IF NOT EXISTS "retail_pos_sales" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "location_id" integer NOT NULL REFERENCES "locations"("id") ON DELETE restrict,
  "idempotency_key" varchar(191) NOT NULL,
  "status" varchar(32) DEFAULT 'completed' NOT NULL,
  "total_amount" numeric(20,6) DEFAULT '0' NOT NULL,
  "created_by" integer NOT NULL,
  "notes" text,
  "canceled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_pos_sales_company_idempotency_unique" ON "retail_pos_sales" USING btree ("company_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_sales_company_idx" ON "retail_pos_sales" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_sales_location_idx" ON "retail_pos_sales" USING btree ("location_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retail_pos_sale_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "sale_id" integer NOT NULL REFERENCES "retail_pos_sales"("id") ON DELETE cascade,
  "variant_id" integer NOT NULL REFERENCES "retail_product_variants"("id") ON DELETE restrict,
  "quantity" numeric(20,6) NOT NULL,
  "returned_quantity" numeric(20,6) DEFAULT '0' NOT NULL,
  "unit_price" numeric(20,6) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_sale_items_company_idx" ON "retail_pos_sale_items" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_sale_items_sale_idx" ON "retail_pos_sale_items" USING btree ("sale_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_sale_items_variant_idx" ON "retail_pos_sale_items" USING btree ("variant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retail_pos_returns" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "sale_id" integer NOT NULL REFERENCES "retail_pos_sales"("id") ON DELETE restrict,
  "idempotency_key" varchar(191) NOT NULL,
  "created_by" integer NOT NULL,
  "notes" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_pos_returns_company_idempotency_unique" ON "retail_pos_returns" USING btree ("company_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_returns_company_idx" ON "retail_pos_returns" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_returns_sale_idx" ON "retail_pos_returns" USING btree ("sale_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retail_pos_return_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "return_id" integer NOT NULL REFERENCES "retail_pos_returns"("id") ON DELETE cascade,
  "sale_item_id" integer NOT NULL REFERENCES "retail_pos_sale_items"("id") ON DELETE restrict,
  "variant_id" integer NOT NULL REFERENCES "retail_product_variants"("id") ON DELETE restrict,
  "location_id" integer NOT NULL REFERENCES "locations"("id") ON DELETE restrict,
  "quantity" numeric(20,6) NOT NULL,
  "unit_price" numeric(20,6) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_return_items_company_idx" ON "retail_pos_return_items" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_return_items_return_idx" ON "retail_pos_return_items" USING btree ("return_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_pos_return_items_sale_item_idx" ON "retail_pos_return_items" USING btree ("sale_item_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retail_stock_operations" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "operation_type" varchar(40) NOT NULL,
  "idempotency_key" varchar(191) NOT NULL,
  "reference_id" varchar(191),
  "created_by" integer NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_stock_operations_company_idempotency_unique" ON "retail_stock_operations" USING btree ("company_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_stock_operations_company_idx" ON "retail_stock_operations" USING btree ("company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retail_stock_movements" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "variant_id" integer NOT NULL REFERENCES "retail_product_variants"("id") ON DELETE restrict,
  "location_id" integer NOT NULL REFERENCES "locations"("id") ON DELETE restrict,
  "movement_type" varchar(40) NOT NULL,
  "quantity_delta" numeric(20,6) NOT NULL,
  "quantity_before" numeric(20,6) NOT NULL,
  "quantity_after" numeric(20,6) NOT NULL,
  "event_key" varchar(255) NOT NULL,
  "reference_type" varchar(40),
  "reference_id" varchar(191),
  "created_by" integer NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_stock_movements_company_event_unique" ON "retail_stock_movements" USING btree ("company_id","event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_stock_movements_company_idx" ON "retail_stock_movements" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_stock_movements_variant_idx" ON "retail_stock_movements" USING btree ("variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_stock_movements_location_idx" ON "retail_stock_movements" USING btree ("location_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_stock_movements_created_at_idx" ON "retail_stock_movements" USING btree ("created_at");
