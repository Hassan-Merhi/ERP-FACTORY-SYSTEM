import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("container offload historical cost immutability", () => {
  it("does not reprice posted sales after an offload", () => {
    // centralContainerOffloadRoute.ts is the only offload create/replace handler; the shadowed
    // copy in offload/create.ts was removed by the dead-code cleanup (Phase 3).
    const routes = [source("server/routes/containers/centralContainerOffloadRoute.ts")];

    for (const route of routes) {
      expect(route).not.toContain("syncSalesItemCostsForStockItems");
      expect(route).not.toContain('action: "sync-sales-costs"');
    }
  });

  it("blocks manual current-average repricing and keeps the compatibility sync read-only for sales", () => {
    const statsRoute = source("server/routes/stats/statsSalesRoutes.ts");
    const syncService = source("server/services/syncSalesItemCosts.ts");

    expect(statsRoute).toContain("HISTORICAL_SALE_COST_IMMUTABLE");
    expect(statsRoute).not.toContain(".update(salesItems)");
    expect(syncService).not.toContain(".update(salesItems)");
  });
});
