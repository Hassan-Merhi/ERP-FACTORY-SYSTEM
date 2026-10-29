import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  grants: new Map<string, any>(),
}));

vi.mock("../../client/src/lib/db", () => {
  const table = (map: Map<string, any>) => ({
    get: async (key: string) => map.get(key),
    put: async (row: any) => { map.set(row.key, { ...row }); },
    bulkPut: async (rows: any[]) => { for (const row of rows) map.set(row.key, { ...row }); },
  });
  return { db: {
    transaction: async (_mode: string, _t1: any, _t2: any, cb: () => Promise<unknown>) => cb(),
    offlineReadSnapshots: table(state.rows),
    offlineReadGrants: table(state.grants),
  }};
});

const company = 6;
const userId = "operator-1";
const source = "/api/inventory";

beforeEach(() => {
  state.rows.clear();
  state.grants.clear();
  vi.resetModules();
});

describe("Phase 2 scoped read snapshots", () => {
  it("refuses every read without live verified scope", async () => {
    const { readPreparedOfflineResponse } = await import("../../client/src/lib/offline/offlineReadCache");
    expect(await readPreparedOfflineResponse("GET", source)).toBeNull();
  });

  it("is exact-URL, actor and expiry scoped", async () => {
    const {
      activateVerifiedOfflineReadScope,
      readPreparedOfflineResponse,
      saveVerifiedOfflineReadBatch,
      revokeOfflineReadScope,
    } = await import("../../client/src/lib/offline/offlineReadCache");
    activateVerifiedOfflineReadScope({ companyId: company, userId }, 60_000);
    await saveVerifiedOfflineReadBatch({
      companyId: company, userId,
      snapshots: [{ url: source, body: JSON.stringify({ data: [{ inventoryId: 1 }] }) }],
      total: 1,
    });
    const result = await readPreparedOfflineResponse("GET", source);
    expect(await result?.json()).toEqual({ data: [{ inventoryId: 1 }] });
    expect(result?.headers.get("X-ERP-Offline-Snapshot")).toBe("1");
    expect(await readPreparedOfflineResponse("GET", "/api/inventory?limit=999")).toBeNull();
    expect(await readPreparedOfflineResponse("POST", source)).toBeNull();
    revokeOfflineReadScope();
    expect(await readPreparedOfflineResponse("GET", source)).toBeNull();
    activateVerifiedOfflineReadScope({ companyId: 7, userId });
    expect(await readPreparedOfflineResponse("GET", source)).toBeNull();
    activateVerifiedOfflineReadScope({ companyId: 6, userId: "other-user" });
    expect(await readPreparedOfflineResponse("GET", source)).toBeNull();
  });

  it("rejects expired offline grants even with a matching snapshot", async () => {
    const { activateVerifiedOfflineReadScope, readPreparedOfflineResponse, saveVerifiedOfflineReadBatch } =
      await import("../../client/src/lib/offline/offlineReadCache");
    activateVerifiedOfflineReadScope({ companyId: company, userId });
    await saveVerifiedOfflineReadBatch({
      companyId: company, userId,
      snapshots: [{ url: source, body: "[]" }],
      total: 1,
    });
    for (const value of state.grants.values()) value.expiresAt = Date.now() - 1;
    expect(await readPreparedOfflineResponse("GET", source)).toBeNull();
  });

  it("does not trust the Phase 1 legacy cache table for reads", async () => {
    const { activateVerifiedOfflineReadScope, readPreparedOfflineResponse } =
      await import("../../client/src/lib/offline/offlineReadCache");
    activateVerifiedOfflineReadScope({ companyId: company, userId });
    expect(await readPreparedOfflineResponse("GET", source)).toBeNull();
  });
});
