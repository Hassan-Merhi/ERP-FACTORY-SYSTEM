// Regression contract for the production bandwidth hotspots observed on August 5, 2026.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getBandwidthInvalidationScope,
  invalidateBandwidthReadCaches,
  shouldClearBandwidthEntry,
} from "../../client/src/lib/bandwidthInvalidationPolicy";

describe("Bandwidth Phase 1 invalidation policy", () => {
  it("preserves reference snapshots for ordinary live workflow writes", () => {
    expect(getBandwidthInvalidationScope("/api/factory/customer-orders/88/bales")).toBe("live");
    expect(getBandwidthInvalidationScope("/api/vouchers")).toBe("live");
    expect(getBandwidthInvalidationScope("/api/stock-transfers/44/finalize")).toBe("live");
    expect(getBandwidthInvalidationScope("/api/factory/customer-proforma-lines/42")).toBe("live");
    expect(getBandwidthInvalidationScope("/api/factory/customer-proformas/42")).toBe("live");
    expect(shouldClearBandwidthEntry("live", "live")).toBe(true);
    expect(shouldClearBandwidthEntry("reference", "live")).toBe(false);
  });

  it("clears every snapshot when the selected scope or reference data changes", () => {
    const fullInvalidationPaths = [
      "/api/auth/set-company",
      "/api/auth/logout",
      "/api/locations/12",
      "/api/ledger-accounts/7",
      "/api/factory/settings",
      "/api/factory/workers/9",
      "/api/factory/customers/31",
      "/api/factory/bale-products/12",
      "/api/factory/categories/7",
      "/api/stock-items/55",
    ];

    for (const pathname of fullInvalidationPaths) {
      expect(getBandwidthInvalidationScope(pathname), pathname).toBe("all");
    }
    expect(shouldClearBandwidthEntry("live", "all")).toBe(true);
    expect(shouldClearBandwidthEntry("reference", "all")).toBe(true);
  });

  it("does not broaden similar business paths into full invalidations", () => {
    expect(getBandwidthInvalidationScope("/api/factory/customer-orders/12/link-proforma")).toBe("live");
    expect(getBandwidthInvalidationScope("/api/accounts/vouchers/12")).toBe("live");
    expect(getBandwidthInvalidationScope("/api/factory/daily-bale-scans")).toBe("live");
  });

  it("contains the canonical production hotspots identified in the August bandwidth snapshots", () => {
    const source = readFileSync(resolve("client/src/lib/bandwidthPhase1HotspotGuard.ts"), "utf8");
    const requiredRoutes = [
      "shipping-container-rows",
      "invoice-container-tracking",
      "customer-orders\\/\\d+\\/verification-summary",
      "audit-log",
      "vouchers\\/\\d+",
      "locations",
      "factory\\/bale-products",
    ];

    for (const route of requiredRoutes) {
      expect(source, route).toContain(route);
    }
    expect(source).not.toContain("factory\\/api\\/factory\\/bale-products");
    expect(source).toContain("BANDWIDTH_INVALIDATION_CHANNEL");
    expect(source).toContain('scope: "reference"');
  });

  it("keeps reference generations reusable across ordinary live writes", () => {
    const requestGuard = readFileSync(resolve("client/src/lib/requestStormGuard.ts"), "utf8");
    const hotspotGuard = readFileSync(resolve("client/src/lib/bandwidthPhase1HotspotGuard.ts"), "utf8");

    for (const source of [requestGuard, hotspotGuard]) {
      expect(source).toContain("generationForScope");
      expect(source).toContain("bumpWriteGeneration");
      expect(source).toContain("referenceWriteGeneration");
      expect(source).toContain("getBandwidthInvalidationScope(url.pathname)");
      expect(source).toContain("BANDWIDTH_INVALIDATION_CHANNEL");
    }

    expect(requestGuard).toMatch(/customer-proformas\$\/,[\s\S]*scope: "live"/);
    expect(requestGuard).toMatch(/factory\\\/bale-products\$\/,[\s\S]*scope: "reference"/);
  });

  // A sale made by another user in another session never passes through this
  // tab's fetch wrapper, so only the realtime path can drop the snapshot it
  // invalidated. Without that, the refetch is answered from the cache and no
  // request is made at all.
  describe("cross-session realtime invalidation", () => {
    const networkCalls: string[] = [];

    // The guard wraps whatever fetch it finds when it loads, so the fake network
    // has to be in place before the import that installs it.
    beforeAll(async () => {
      const fakeNetwork = async (input: RequestInfo | URL) => {
        networkCalls.push(String(input));
        return new Response(JSON.stringify([{ stockItemId: 1, quantity: 64 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      vi.stubGlobal("fetch", fakeNetwork);
      window.fetch = fakeNetwork as typeof window.fetch;
      await import("../../client/src/lib/bandwidthPhase1HotspotGuard");
    });

    it("serves a repeated hotspot read from the cached snapshot", async () => {
      networkCalls.length = 0;
      await window.fetch("/api/locations/9/inventory");
      await window.fetch("/api/locations/9/inventory");
      expect(networkCalls).toHaveLength(1);
    });

    it("makes a real request again once a realtime write clears the snapshot", async () => {
      networkCalls.length = 0;
      await window.fetch("/api/locations/11/inventory");
      invalidateBandwidthReadCaches("live");
      await window.fetch("/api/locations/11/inventory");
      expect(networkCalls).toHaveLength(2);
    });
  });
});
