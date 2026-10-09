ALTER TABLE "retail_product_variants"
  ADD COLUMN IF NOT EXISTS "color" varchar(100) NOT NULL DEFAULT 'Default';

ALTER TABLE "retail_product_variants"
  ADD COLUMN IF NOT EXISTS "image_urls" jsonb NOT NULL DEFAULT '[]'::jsonb;

DROP INDEX IF EXISTS "retail_product_variants_product_size_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "retail_product_variants_product_color_size_unique"
  ON "retail_product_variants" ("product_id", "color", "size");
