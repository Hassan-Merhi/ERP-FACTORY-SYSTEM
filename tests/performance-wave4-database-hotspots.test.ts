import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const route = readFileSync(
  resolve(process.cwd(), "server/routes/factory/bale-exports/production-value-report.ts"),
  "utf8"
);

describe("Performance Wave 4 database hotspot guards", () => {
  it("batches read-only supplier lookups instead of issuing N+1 queries", () => {
    expect(route).toContain("getLockedSupplierRatesReadOnlyBulk");
    expect(route).not.toContain("getLockedSupplierRateReadOnly(");
    expect(route).not.toContain("SELECT name FROM factory_suppliers WHERE id = $1");
    expect(route).toContain("SELECT id, name FROM factory_suppliers WHERE id = ANY($1)");
    expect(route).toContain("SELECT id, supplier_id FROM factory_containers WHERE id = ANY($1)");
  });

  it("projects only the mix-source fields consumed by the report", () => {
    const sourceProjection = route.slice(
      route.indexOf("const mixSourceRows ="),
      route.indexOf("// Resolve current locked USD rate")
    );

    expect(sourceProjection).toContain("mixBatchId: factoryMixBatchSources.mixBatchId");
    expect(sourceProjection).toContain("sourceBatchId: factoryMixBatchSources.sourceBatchId");
    expect(sourceProjection).toContain("supplierId: factoryMixBatchSources.supplierId");
    expect(sourceProjection).toContain("inventorySupplierId: factoryMixBatchSources.inventorySupplierId");
    expect(sourceProjection).toContain("containerId: factoryMixBatchSources.containerId");
    expect(sourceProjection).toContain("weightKg: factoryMixBatchSources.weightKg");
    expect(sourceProjection).toContain("costPerKg: factoryMixBatchSources.costPerKg");
    expect(sourceProjection).not.toContain(".select()");
  });

  it("runs only independent report reads concurrently", () => {
    expect(route).toContain(
      "const [baleRows, mixBatchRows] = await Promise.all([baleRowsPromise, mixBatchRowsPromise])"
    );
    expect(route).toContain("const [mixAllTimeResult, baleAllTimeResult] = await Promise.all([");
  });
});
