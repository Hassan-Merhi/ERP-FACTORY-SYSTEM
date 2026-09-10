import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/**
 * A soft-deleted loading still holds rows in customer_order_bales. Counting them
 * towards a proforma's consumed capacity makes the proforma look overloaded and
 * blocks scanning against bales that were never really loaded.
 *
 * Scanning and bulk import used to each count those rows themselves, so this
 * exclusion was asserted in both route files. Phase 2 moved the counting into
 * getProformaCapacitySnapshot and both routes now call it, so the exclusion is
 * asserted where it lives and the routes are held to sourcing their counts from
 * it rather than counting again.
 */
describe("factory loading proforma overload scope", () => {
  it("excludes soft-deleted proformas and orders from the shared capacity snapshot", () => {
    const source = read("server/routes/factory/customer-orders/proformaCapacity.ts");

    expect(source).toContain("AND deleted_at IS NULL");
    expect(source).toContain("AND co.deleted_at IS NULL");
    expect(source).toContain("AND co.status <> 'CANCELLED'");
  });

  it("counts individual scans through the shared snapshot rather than its own query", () => {
    const source = read("server/routes/factory/customer-orders/bale-scanning/scan.ts");

    expect(source).toContain("getProformaCapacitySnapshot(tx");
    expect(source.match(/getProformaCapacitySnapshot\(tx/g)).toHaveLength(1);
  });

  it("counts both bulk-import modes through the shared snapshot rather than its own query", () => {
    const source = read("server/routes/factory/customer-orders/bale-scanning/bulk-import.ts");

    expect(source.match(/getProformaCapacitySnapshot\(tx/g)).toHaveLength(2);
  });
});
