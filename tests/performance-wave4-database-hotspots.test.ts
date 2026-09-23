import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const route = readFileSync(
  resolve(process.cwd(), "server/routes/factory/bale-exports/production-value-report.ts"),
  "utf8"
);
const baleLedger = readFileSync(
  resolve(process.cwd(), "server/routes/performance/bandwidthPhase3FactoryReads.ts"),
  "utf8"
);
const snapshotRoutes = readFileSync(
  resolve(process.cwd(), "server/routes/factory/factoryBilingualSnapshotRoutes.ts"),
  "utf8"
);
const snapshotService = readFileSync(
  resolve(process.cwd(), "server/services/factoryBilingualSnapshotService.ts"),
  "utf8"
);
const baleScanRoute = readFileSync(
  resolve(process.cwd(), "server/routes/factory/customer-orders/bale-scanning/scan.ts"),
  "utf8"
);
const incrementalTotals = readFileSync(
  resolve(process.cwd(), "server/routes/factory/customer-orders/bale-scanning/incrementalTotals.ts"),
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

  it("aggregates bale order-state once instead of repeating correlated EXISTS probes", () => {
    expect(baleLedger).toContain(
      "BOOL_OR(co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED')) AS has_pending"
    );
    expect(baleLedger).toContain(
      "BOOL_OR(co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')) AS has_sold"
    );
    expect(baleLedger).toContain("LEFT JOIN order_state os ON os.bale_id = fb.id");
    expect(baleLedger).not.toContain("WHERE cob.bale_id = fb.id");
  });

  it("keeps compact bale-scan bilingual snapshots inline and off the synchronous resolver hot path", () => {
    expect(snapshotRoutes).toContain("responseRecord?.compactBaleScan === true");
    expect(snapshotRoutes).toContain("return originalJson(payload)");
    expect(baleScanRoute).toContain("canonicalProductNameAr");
    expect(baleScanRoute).toContain("baleNameAr: bale.canonicalProductNameAr");
    expect(incrementalTotals).toContain("MAX(NULLIF(cob.bale_name_ar, '')) AS bale_name_ar");
    expect(incrementalTotals).toContain("bale_name_ar,");
    // Non-scan order writes retain the original order-scoped behavior.
    expect(snapshotService).toContain('item.table === "customer_order_bales"');
    expect(snapshotService).toContain('item.table === "customer_order_lines"');
    expect(snapshotService).toContain("return `t.order_id=${orderId}`");
  });
});
