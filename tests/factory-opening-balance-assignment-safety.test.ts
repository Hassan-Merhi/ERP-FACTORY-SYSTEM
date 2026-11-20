import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Opening-balance bale assignment safety", () => {
  const source = readFileSync(
    resolve(process.cwd(), "server/routes/factory/raw-stock/openingBalanceAssignmentRoutesV5.ts"),
    "utf8"
  );

  it("coordinates with replay and locks all operational rows", () => {
    expect(source).toContain("pg_advisory_xact_lock(9003");
    expect(source).toContain("pg_advisory_xact_lock(9004");
    expect(source).toContain("FOR UPDATE OF frs, fc");
    expect(source).toContain("ORDER BY id\n           FOR UPDATE");
  });

  it("refuses a container without a supplier instead of writing an unowned source", () => {
    expect(source).toContain("OPENING_BALANCE_SUPPLIER_REQUIRED");
    expect(source).not.toContain("CONTAINER_DIRECT");
    expect(source).not.toContain("cost_per_kg_usd ?? rawStock.cost_per_kg");
  });

  it("writes supplier-linked consumption without changing the supplier rate", () => {
    expect(source).toContain("SUPPLIER_LOCKED_RATE");
    expect(source).toContain("supplierRateChanged: false");
    expect(source).not.toContain("getLockedSupplierRate");
    expect(source).not.toContain("applyOffloadMovingAverage");
  });
});
