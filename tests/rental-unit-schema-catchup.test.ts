import { describe, expect, it } from "vitest";

import { columnDefinition, hasTable, schemaManifest } from "./helpers/schemaManifest";

// The rental unit columns used to be caught up at boot by
// ensurePropertyUnitsWriteSchema (server/startup/ensureRuntimeSchema.ts).
// Migrations now define the complete table; startup only verifies it.
const propertyColumns = [
  "id",
  "company_id",
  "module",
  "unit_type",
  "location_group",
  "unit_number",
  "size",
  "dimensions",
  "notes",
  "active",
  "sort_order",
  "created_at",
];

describe("Rental property unit schema", () => {
  it("migrations define the base rental table with every column the write routes use", () => {
    expect(hasTable("property_units")).toBe(true);
    const columns = schemaManifest()
      .filter((entry) => entry.kind === "column" && entry.identity.startsWith("public.property_units."))
      .map((entry) => entry.identity.slice("public.property_units.".length));
    expect(columns.sort()).toEqual([...propertyColumns].sort());
  });

  it("defines the caught-up columns with their write-route shapes", () => {
    expect(columnDefinition("property_units", "sort_order")).toMatchObject({
      type: "integer",
      notNull: true,
      default: "0",
    });
    expect(columnDefinition("property_units", "notes")).toMatchObject({ type: "text", notNull: false });
  });
});
