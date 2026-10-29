import { describe, expect, it } from "vitest";
import { buildPacks } from "@/lib/offlinePrep";
import { normalizeOfflineReadUrl } from "@/lib/offline/offlineReadPolicy";

describe("Phase 2 offline preparation manifest contract", () => {
  it("has an exact replay policy for every prepared non-auth dataset", () => {
    const skipped = new Set(["user", "companies"]);
    const datasets = buildPacks().flatMap((pack) => pack.datasets);
    expect(datasets.length).toBeGreaterThan(15);
    const urls = new Set<string>();
    for (const dataset of datasets) {
      if (skipped.has(dataset.id)) continue;
      expect(normalizeOfflineReadUrl(dataset.endpoint), dataset.id).toBe(dataset.endpoint);
      expect(urls.has(dataset.endpoint), dataset.id).toBe(false);
      urls.add(dataset.endpoint);
    }
  });
});
