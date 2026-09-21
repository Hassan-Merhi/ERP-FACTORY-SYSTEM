import { QueryClient } from "@tanstack/react-query";
import { applyReferenceMutationResponse, updateReferenceListPayload } from "@/lib/referenceMutationCache";
import { QUERY_STALE_TIMES, staleTimeForQueryKey } from "@/lib/queryPolicies";

describe("Bandwidth Phase 3 cache contracts", () => {
  it("applies long reference lifetimes to canonical query-string keys only", () => {
    expect(staleTimeForQueryKey(["/api/locations?includeInactive=true", 7])).toBe(QUERY_STALE_TIMES.referenceData);
    expect(staleTimeForQueryKey(["/api/factory/workers?active=true", 7])).toBe(QUERY_STALE_TIMES.referenceData);
    expect(staleTimeForQueryKey(["/api/locations/7/inventory", 7])).not.toBe(QUERY_STALE_TIMES.referenceData);
  });

  it("upserts and deletes list rows without discarding computed fields", () => {
    const updated = updateReferenceListPayload([{ id: 1, name: "Old", computedBalance: "15.00" }], {
      method: "PATCH",
      entity: { id: 1, name: "New" },
      id: 1,
    });
    expect(updated).toEqual([{ id: 1, name: "New", computedBalance: "15.00" }]);
    expect(updateReferenceListPayload(updated, { method: "DELETE", entity: null, id: 1 })).toEqual([]);
  });

  it("updates every canonical reference cache locally from a successful mutation response", async () => {
    const client = new QueryClient();
    client.setQueryData(["/api/locations", 3], [{ id: 1, name: "Lubumbashi" }]);
    client.setQueryData(["/api/locations?includeInactive=true", 3], [{ id: 1, name: "Lubumbashi" }]);

    const applied = await applyReferenceMutationResponse({
      client,
      method: "POST",
      pathname: "/api/locations",
      response: new Response(JSON.stringify({ id: 2, name: "Kolwezi" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });

    expect(applied).toBe(true);
    expect(client.getQueryData(["/api/locations", 3])).toEqual([
      { id: 2, name: "Kolwezi" },
      { id: 1, name: "Lubumbashi" },
    ]);
    expect(client.getQueryData(["/api/locations?includeInactive=true", 3])).toEqual([
      { id: 2, name: "Kolwezi" },
      { id: 1, name: "Lubumbashi" },
    ]);
  });

  it("keeps full and compact reference profiles synchronized after a successful write", async () => {
    const client = new QueryClient();
    client.setQueryData(["/api/factory/bale-products", 3], [
      { id: 7, articleCode: "HMD10007", name: "Old", description: "full-only" },
    ]);
    client.setQueryData(["/api/factory/bale-products?profile=picker", 3], [
      { id: 7, articleCode: "HMD10007", name: "Old" },
    ]);

    const applied = await applyReferenceMutationResponse({
      client,
      method: "PATCH",
      pathname: "/api/factory/bale-products/7",
      response: new Response(JSON.stringify({ id: 7, articleCode: "HMD10007", name: "Updated" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });

    expect(applied).toBe(true);
    expect(client.getQueryData(["/api/factory/bale-products", 3])).toEqual([
      { id: 7, articleCode: "HMD10007", name: "Updated", description: "full-only" },
    ]);
    expect(client.getQueryData(["/api/factory/bale-products?profile=picker", 3])).toEqual([
      { id: 7, articleCode: "HMD10007", name: "Updated" },
    ]);
  });

  it("replaces settings objects locally instead of refetching the list", async () => {
    const client = new QueryClient();
    client.setQueryData(["/api/factory/settings"], { language: "en", allowNegativeStock: false });

    await applyReferenceMutationResponse({
      client,
      method: "PATCH",
      pathname: "/api/factory/settings",
      response: new Response(JSON.stringify({ settings: { allowNegativeStock: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });

    expect(client.getQueryData(["/api/factory/settings"])).toEqual({
      language: "en",
      allowNegativeStock: true,
    });
  });

  it("keeps server ETag coverage on the stable reference endpoints", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("server/routes/performance/readMicrocache.ts", "utf8")
    );
    for (const endpoint of [
      "/api/company-settings",
      "/api/user/preferences",
      "/api/customers",
      "/api/bank-accounts",
      "/api/fixed-assets",
      "/api/stock-categories",
      "/api/stock-grades",
      "/api/factory/my-access",
      "/api/factory/worker-categories",
    ]) {
      expect(source).toContain(`["${endpoint}", 300_000]`);
    }
    expect(source).toContain('res.setHeader?.("ETag", entry.etag)');
    expect(source).toContain("res.status(304).end()");
  });
});
