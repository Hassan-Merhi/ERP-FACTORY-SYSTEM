import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ensurePropertyUnitsWriteSchema } from "../server/startup/ensureRuntimeSchema";

const propertyColumns = [
  "id", "company_id", "module", "unit_type", "location_group", "unit_number",
  "size", "dimensions", "notes", "active", "sort_order", "created_at",
];

function fakePool(columns: string[]) {
  const query = vi.fn().mockResolvedValueOnce({
    rows: columns.map((column_name) => ({ column_name })),
  }).mockResolvedValue({ rows: [] });
  return { pool: { query } as unknown as Pool, query };
}

describe("Rental property unit startup schema catch-up", () => {
  it("does not write or lock a complete production table", async () => {
    const { pool, query } = fakePool(propertyColumns);
    await ensurePropertyUnitsWriteSchema(pool);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("adds only missing columns without changing existing units or vouchers", async () => {
    const { pool, query } = fakePool(propertyColumns.filter(
      (column) => column !== "sort_order" && column !== "notes"
    ));
    await ensurePropertyUnitsWriteSchema(pool);
    expect(query).toHaveBeenCalledTimes(2);
    const sql = String(query.mock.calls[1][0]);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "notes" TEXT');
    expect(sql).not.toMatch(/UPDATE|DELETE|TRUNCATE|vouchers|property_contracts/i);
  });

  it("stops startup if the base rental table does not exist", async () => {
    const { pool, query } = fakePool([]);
    await expect(ensurePropertyUnitsWriteSchema(pool)).rejects.toThrow(
      "RENTAL_PROPERTY_UNITS_TABLE_MISSING"
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});
