import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("container offload historical cost immutability", () => {
  it("does not reprice posted sales after an offload", () => {
    const routes = [
      source("server/routes/containers/centralContainerOffloadRoute.ts"),
      source("server/routes/containers/offload/create.ts"),
    ];

    for (const route of routes) {
      expect(route).not.toContain("syncSalesItemCostsForStockItems");
      expect(route).not.toContain('action: "sync-sales-costs"');
    }
  });
});
