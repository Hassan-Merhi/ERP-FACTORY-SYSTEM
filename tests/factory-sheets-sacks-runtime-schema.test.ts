/**
 * Sheets & Sacks log schema.
 *
 * The log used to be created and converged from a legacy ad hoc shape at every
 * boot (server/startup/factorySheetsSacksSchema.ts). Migrations now define it,
 * and converging an older database is the job of `db:adopt` (which never drops
 * legacy columns), so only the shape a fresh database gets is asserted here,
 * against the schema manifest.
 */
import { describe, expect, it } from "vitest";

import { columnDefinition, hasIndex, schemaManifest, tableConstraints } from "./helpers/schemaManifest";

describe("factory sheets & sacks log schema", () => {
  it("has exactly the columns the app writes, with timestamptz created_at", () => {
    const columns = schemaManifest()
      .filter((entry) => entry.kind === "column" && entry.identity.startsWith("public.factory_sheets_sacks_log."))
      .map((entry) => entry.identity.slice("public.factory_sheets_sacks_log.".length))
      .sort();
    expect(columns).toEqual(
      [
        "id",
        "company_id",
        "item_id",
        "item_name",
        "item_type",
        "action",
        "pieces",
        "packs",
        "unit_price",
        "total_value",
        "notes",
        "created_at",
      ].sort()
    );
    expect(columnDefinition("factory_sheets_sacks_log", "pieces")).toMatchObject({ type: "integer", notNull: true });
    expect(columnDefinition("factory_sheets_sacks_log", "unit_price")?.type).toBe("numeric(20,6)");
    expect(columnDefinition("factory_sheets_sacks_log", "total_value")?.type).toBe("numeric(20,4)");
    expect(columnDefinition("factory_sheets_sacks_log", "created_at")).toMatchObject({
      type: "timestamp with time zone",
      notNull: true,
    });
  });

  it("checks the action and indexes the log without the legacy item index", () => {
    expect(tableConstraints("factory_sheets_sacks_log")).toContain(
      "CHECK (action = ANY (ARRAY['IN'::text, 'OUT'::text, 'ADJUST'::text]))"
    );
    expect(hasIndex("idx_fss_log_company_created")).toBe(true);
    expect(hasIndex("idx_fss_log_item")).toBe(true);
    expect(hasIndex("idx_factory_sheets_sacks_log_item_id")).toBe(false);
  });
});
