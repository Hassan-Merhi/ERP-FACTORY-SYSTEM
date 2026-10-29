import { describe, expect, it } from "vitest";
import { buildPacks } from "@/lib/offlinePrep";
import { selectOfflinePrepPacks } from "@/lib/offline/scopedOfflinePrep";
import { normalizeOfflineReadUrl } from "@/lib/offline/offlineReadPolicy";

describe("Phase 2 offline preparation manifest contract", () => {
  it("does not report unsupported or unrelated company types ready", () => {
    expect(selectOfflinePrepPacks("erp")).toEqual(["shared", "erp"]);
    expect(selectOfflinePrepPacks("factory")).toContain("factory");
    expect(selectOfflinePrepPacks("factory_v2")).toContain("factory");
    expect(selectOfflinePrepPacks("retail")).toEqual(["shared", "pos"]);
    expect(selectOfflinePrepPacks("properties")).toEqual([]);
    expect(selectOfflinePrepPacks("supplier_partner")).toEqual([]);
  });

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
