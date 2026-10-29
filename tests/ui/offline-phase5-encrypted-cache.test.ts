// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  snapshots: new Map<string, any>(),
  grants: new Map<string, any>(),
}));

vi.mock("../../client/src/lib/db", () => {
  const table = (map: Map<string, any>) => ({
    get: async (key: string) => map.get(key),
    put: async (row: any) => { map.set(row.key, { ...row }); },
    bulkPut: async (rows: any[]) => {
      for (const row of rows) map.set(row.key, { ...row });
    },
  });
  return {
    db: {
      transaction: async (_mode: string, _snapshots: any, _grants: any, cb: () => Promise<void>) => cb(),
      offlineReadSnapshots: table(store.snapshots),
      offlineReadGrants: table(store.grants),
    },
  };
});

const actor = { companyId: 16, userId: "factory-operator" };
const source = "/api/factory/raw-stock";
const passphrase = "a-strong-device-passphrase";
const body = JSON.stringify({ data: [{ batch: "CONFIDENTIAL-001", kg: 100 }] });

async function api() {
  return import("../../client/src/lib/offline/offlineReadCache");
}

beforeEach(() => {
  store.snapshots.clear();
  store.grants.clear();
  vi.resetModules();
});

describe("Phase 5 encrypted read-cache integration", () => {
  it("atomically stores sealed snapshots and requires the live session plus unlock", async () => {
    const cache = await api();
    cache.activateVerifiedOfflineReadScope(actor);
    await cache.saveVerifiedOfflineReadBatch(
      { ...actor, snapshots: [{ url: source, body }], total: 1 },
      passphrase
    );
    const row = [...store.snapshots.values()][0];
    const grant = [...store.grants.values()][0];
    expect(row.body).not.toContain("CONFIDENTIAL-001");
    expect(grant.vaultSalt).toBeTruthy();
    expect(grant.protection).toBe("erp-offline-aes-gcm-v1");
    expect(grant.vaultCheck).not.toContain(passphrase);
    expect(await (await cache.readPreparedOfflineResponse("GET", source))?.json()).toEqual(JSON.parse(body));
    cache.lockVerifiedOfflineReadVault();
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
    expect(await cache.unlockVerifiedOfflineReadVault("wrong-passphrase-12345")).toBe(false);
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
    expect(await cache.unlockVerifiedOfflineReadVault(passphrase)).toBe(true);
    expect(await (await cache.readPreparedOfflineResponse("GET", source))?.json()).toEqual(JSON.parse(body));
  });

  it("cannot cold-start or switch actor/company into a previous user's vault", async () => {
    const cache = await api();
    cache.activateVerifiedOfflineReadScope(actor);
    await cache.saveVerifiedOfflineReadBatch({ ...actor, snapshots: [{ url: source, body }], total: 1 }, passphrase);
    cache.revokeOfflineReadScope();
    expect(await cache.unlockVerifiedOfflineReadVault(passphrase)).toBe(false);
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
    cache.activateVerifiedOfflineReadScope({ ...actor, userId: "new-operator" });
    expect(await cache.unlockVerifiedOfflineReadVault(passphrase)).toBe(false);
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
    cache.activateVerifiedOfflineReadScope({ ...actor, companyId: 99 });
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
  });

  it("fails closed on grant tampering, stale grants and ciphertext modification", async () => {
    const cache = await api();
    cache.activateVerifiedOfflineReadScope(actor);
    await cache.saveVerifiedOfflineReadBatch({ ...actor, snapshots: [{ url: source, body }], total: 1 }, passphrase);
    const grant = [...store.grants.values()][0];
    const row = [...store.snapshots.values()][0];
    grant.vaultSalt = "ZmFrZQ==";
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
    expect(await cache.unlockVerifiedOfflineReadVault(passphrase)).toBe(false);
    const validSalt = (await api()).getOfflineReadGrant;
    // Restore the valid salt from another authenticated, complete preparation.
    await cache.saveVerifiedOfflineReadBatch({ ...actor, snapshots: [{ url: source, body }], total: 1 }, passphrase);
    expect(validSalt).toBeDefined();
    const currentRow = [...store.snapshots.values()][0];
    currentRow.body = JSON.stringify({ data: [{ batch: "FORGED-RESPONSE" }] });
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
    currentRow.body = row.body;
    const newGrant = [...store.grants.values()][0];
    newGrant.expiresAt = Date.now() - 1;
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
  });

  it("rejects missing authentication before storing a protected batch", async () => {
    const cache = await api();
    await expect(
      cache.saveVerifiedOfflineReadBatch({ ...actor, snapshots: [{ url: source, body }], total: 1 }, passphrase)
    ).rejects.toThrow("OFFLINE_READ_SCOPE_MISMATCH");
    expect(store.snapshots.size).toBe(0);
    expect(store.grants.size).toBe(0);
  });

  it("preserves legacy compatibility without treating legacy plaintext as a sealed record", async () => {
    const cache = await api();
    cache.activateVerifiedOfflineReadScope(actor);
    await cache.saveVerifiedOfflineReadBatch({ ...actor, snapshots: [{ url: source, body }], total: 1 });
    expect(await (await cache.readPreparedOfflineResponse("GET", source))?.json()).toEqual(JSON.parse(body));
    cache.lockVerifiedOfflineReadVault();
    store.snapshots.values().next().value.body = JSON.stringify({
      format: "erp-offline-aes-gcm-v1", nonce: "AA==", ciphertext: "AA=="
    });
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
  });
});
