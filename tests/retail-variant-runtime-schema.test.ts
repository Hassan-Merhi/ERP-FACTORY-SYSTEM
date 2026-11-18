/**
 * Retail fashion variant schema. The color/image columns and the
 * (product_id, color, size) unique index used to be repaired at boot by
 * ensureRetailVariantSchema (server/startup/ensureRuntimeSchema.ts); the
 * migrations now define them and startup only verifies the schema.
 */
import { describe, expect, it } from "vitest";

import { columnDefinition, hasIndex, indexDefinition } from "./helpers/schemaManifest";

describe("retail variant schema", () => {
  it("defines color and image_urls with the defaults existing variants read as", () => {
    expect(columnDefinition("retail_product_variants", "color")).toMatchObject({
      type: "character varying(100)",
      notNull: true,
      default: "'Default'::character varying",
    });
    expect(columnDefinition("retail_product_variants", "image_urls")).toMatchObject({
      type: "jsonb",
      notNull: true,
      default: "'[]'::jsonb",
    });
  });

  it("keys variants on (product_id, color, size), not the old (product_id, size)", () => {
    expect(indexDefinition("retail_product_variants_product_color_size_unique")).toBe(
      "CREATE UNIQUE INDEX retail_product_variants_product_color_size_unique ON public.retail_product_variants USING btree (product_id, color, size)"
    );
    expect(hasIndex("retail_product_variants_product_size_unique")).toBe(false);
  });
});
