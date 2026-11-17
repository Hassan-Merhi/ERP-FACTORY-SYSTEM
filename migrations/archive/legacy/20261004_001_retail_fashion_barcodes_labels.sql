ALTER TABLE "retail_product_variants"
  ADD COLUMN IF NOT EXISTS "barcode_source" varchar(20) NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS "retail_barcode_sequences" (
  "company_id" integer PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "next_value" bigint NOT NULL DEFAULT 1,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "retail_label_print_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "variant_id" integer NOT NULL REFERENCES "retail_product_variants"("id") ON DELETE RESTRICT,
  "barcode" varchar(191) NOT NULL,
  "copies" integer NOT NULL DEFAULT 1,
  "layout" varchar(40) NOT NULL,
  "is_reprint" boolean NOT NULL DEFAULT false,
  "created_by" varchar NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "retail_label_print_events_company_idx" ON "retail_label_print_events" ("company_id");
CREATE INDEX IF NOT EXISTS "retail_label_print_events_variant_idx" ON "retail_label_print_events" ("variant_id");
CREATE INDEX IF NOT EXISTS "retail_stock_movements_variant_created_idx" ON "retail_stock_movements" ("variant_id", "created_at");
