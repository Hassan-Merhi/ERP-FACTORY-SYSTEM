/**
 * Retail barcode and label schema. It used to be repaired at boot by
 * ensureRetailBarcodeLabelSchema (server/startup/ensureRuntimeSchema.ts); the
 * migrations now define it and startup only verifies the schema.
 */
import { describe, expect, it } from "vitest";

import { columnDefinition, hasTable } from "./helpers/schemaManifest";

describe("retail barcode and label schema", () => {
  it("defines barcode_source (existing variants read as manual), the sequence and label-print tables", () => {
    expect(columnDefinition("retail_product_variants", "barcode_source")).toMatchObject({
      type: "character varying(20)",
      notNull: true,
      default: "'manual'::character varying",
    });
    expect(hasTable("retail_barcode_sequences")).toBe(true);
    expect(hasTable("retail_label_print_events")).toBe(true);
  });
});
