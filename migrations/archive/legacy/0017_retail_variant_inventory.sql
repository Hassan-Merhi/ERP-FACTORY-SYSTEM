CREATE TABLE IF NOT EXISTS "retail_brands" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "normalized_name" text NOT NULL,
  "is_no_brand" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_brands_company_name_unique" ON "retail_brands" USING btree ("company_id","normalized_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_brands_company_idx" ON "retail_brands" USING btree ("company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retail_products" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "code" varchar(100) NOT NULL,
  "name" text NOT NULL,
  "brand_id" integer REFERENCES "retail_brands"("id") ON DELETE SET NULL,
  "category" text,
  "description" text,
  "image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_products_company_code_unique" ON "retail_products" USING btree ("company_id","code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_products_company_idx" ON "retail_products" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_products_brand_idx" ON "retail_products" USING btree ("brand_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retail_product_variants" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "product_id" integer NOT NULL REFERENCES "retail_products"("id") ON DELETE CASCADE,
  "size" varchar(100) NOT NULL,
  "barcode" varchar(191) NOT NULL,
  "sku" varchar(191),
  "cost" numeric(20,6) DEFAULT '0' NOT NULL,
  "selling_price" numeric(20,6) DEFAULT '0' NOT NULL,
  "low_stock_threshold" numeric(20,6) DEFAULT '0' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_product_variants_company_barcode_unique" ON "retail_product_variants" USING btree ("company_id","barcode");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_product_variants_company_sku_unique" ON "retail_product_variants" USING btree ("company_id","sku");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_product_variants_product_size_unique" ON "retail_product_variants" USING btree ("product_id","size");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_product_variants_company_idx" ON "retail_product_variants" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_product_variants_product_idx" ON "retail_product_variants" USING btree ("product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retail_variant_inventory" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "variant_id" integer NOT NULL REFERENCES "retail_product_variants"("id") ON DELETE CASCADE,
  "location_id" integer NOT NULL REFERENCES "locations"("id") ON DELETE RESTRICT,
  "quantity" numeric(20,6) DEFAULT '0' NOT NULL,
  "average_cost" numeric(20,6) DEFAULT '0' NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retail_variant_inventory_variant_location_unique" ON "retail_variant_inventory" USING btree ("variant_id","location_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_variant_inventory_company_idx" ON "retail_variant_inventory" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_variant_inventory_variant_idx" ON "retail_variant_inventory" USING btree ("variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retail_variant_inventory_location_idx" ON "retail_variant_inventory" USING btree ("location_id");
--> statement-breakpoint
INSERT INTO "retail_brands" ("company_id", "name", "normalized_name", "is_no_brand")
SELECT c.id, 'Other / No Brand', 'other / no brand', true
FROM "companies" c
WHERE c."company_type" = 'retail'
  AND NOT EXISTS (
    SELECT 1 FROM "retail_brands" b
    WHERE b."company_id" = c.id AND b."normalized_name" = 'other / no brand'
  );
