// @vitest-environment node
/**
 * Plan batch 5 (owner-approved 2026-11-05): the old browser queues.
 *
 * Entries from the pre-Phase 9 queues move into an encrypted store and the
 * originals are removed. The list shows date, type and amount. A choice is
 * applied only after the server has recorded it. Entries are deleted after 30
 * days. Nothing is ever sent automatically.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  entries: new Map<string, any>(),
  keys: new Map<string, any>(),
  syncQueue: new Map<number, any>(),
  local: new Map<string, string>(),
}));

vi.mock("../../client/src/lib/db", () => {
  const table = (map: Map<any, any>, keyField: string) => ({
    get: async (key: any) => map.get(key),
    bulkGet: async (keys: any[]) => keys.map((key) => map.get(key)),
    put: async (row: any) => {
      map.set(row[keyField], row);
    },
    bulkPut: async (rows: any[]) => {
      for (const row of rows) map.set(row[keyField], { ...row });
    },
    bulkDelete: async (keys: any[]) => {
      for (const key of keys) map.delete(key);
    },
    update: async (key: any, changes: any) => {
      map.set(key, { ...map.get(key), ...changes });
    },
    toArray: async () => [...map.values()].map((row) => ({ ...row })),
  });
  return {
    db: {
      legacyRecoveryEntries: table(store.entries, "id"),
      legacyRecoveryKeys: table(store.keys, "id"),
      syncQueue: table(store.syncQueue, "id"),
    },
  };
});

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.local.get(key) ?? null,
  setItem: (key: string, value: string) => store.local.set(key, value),
  removeItem: (key: string) => store.local.delete(key),
});

async function api() {
  return import("../../client/src/lib/offline/legacyQueueRecovery");
}

const day = 24 * 60 * 60 * 1000;

beforeEach(() => {
  store.entries.clear();
  store.keys.clear();
  store.syncQueue.clear();
  store.local.clear();
  store.local.set(
    "erp_offline_queue",
    JSON.stringify([
      {
        id: "a1",
        url: "/api/vouchers/payment-receipt",
        method: "POST",
        body: JSON.stringify({ companyId: 7, entries: [{ amount: "40" }, { amount: "2.5" }], notes: "SECRET-NOTE" }),
        description: "Payment / Receipt",
        timestamp: 1_700_000_000_000,
        status: "pending",
      },
    ])
  );
  store.syncQueue.set(5, {
    id: 5,
    idempotencyKey: "k-5",
    url: "/api/pos/sales",
    method: "POST",
    payload: JSON.stringify({ totalAmount: "99.9" }),
    companyId: 8,
    description: "POS Sale",
    createdAt: 1_700_000_100_000,
    status: "failed",
  });
});

describe("Old browser queues", () => {
  it("moves both queues into the encrypted store, removes the originals, and never repeats the move", async () => {
    const recovery = await api();
    const now = 1_800_000_000_000;
    expect(await recovery.migrateLegacyQueues(now)).toBe(2);
    expect(store.local.has("erp_offline_queue")).toBe(false);
    expect(store.syncQueue.size).toBe(0);

    const payment = store.entries.get("ls:a1");
    expect(payment).toMatchObject({ kind: "Payment / Receipt", amount: "42.50", companyId: 7, state: "pending" });
    expect(payment.expiresAt).toBe(now + 30 * day);
    expect(payment.sealed).not.toContain("SECRET-NOTE");
    expect(store.entries.get("idb:k-5")).toMatchObject({ kind: "POS Sale", amount: "99.90", companyId: 8 });

    // The original request comes back intact for the person re-entering it.
    expect(await recovery.openLegacyRecoveryEntry(payment)).toMatchObject({
      method: "POST",
      url: "/api/vouchers/payment-receipt",
      body: { notes: "SECRET-NOTE" },
    });

    // Nothing left to move.
    expect(await recovery.migrateLegacyQueues(now)).toBe(0);
    expect(store.entries.size).toBe(2);
  });

  it("lists only this company's entries (and those with no known company), oldest first", async () => {
    const recovery = await api();
    await recovery.migrateLegacyQueues(1_800_000_000_000);
    const listed = await recovery.listLegacyRecoveryEntries(7, 1_800_000_000_000);
    expect(listed.map((entry) => entry.id)).toEqual(["ls:a1"]);
  });

  it("applies a choice only after the server recorded it", async () => {
    const recovery = await api();
    await recovery.migrateLegacyQueues(1_800_000_000_000);
    const [entry] = await recovery.listLegacyRecoveryEntries(7, 1_800_000_000_000);

    const refused = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(recovery.decideLegacyRecoveryEntry(entry, "discarded", refused)).rejects.toThrow("offline");
    expect(store.entries.get("ls:a1").state).toBe("pending");

    const recorded = vi.fn(async () => ({ recorded: true }));
    await recovery.decideLegacyRecoveryEntry(entry, "discarded", recorded);
    expect(recorded).toHaveBeenCalledWith({
      entryId: "ls:a1",
      decision: "discarded",
      kind: "Payment / Receipt",
      recordedAt: new Date(1_700_000_000_000).toISOString(),
      amount: "42.50",
      source: "localStorage",
    });
    expect(store.entries.get("ls:a1").state).toBe("discarded");
    expect(await recovery.listLegacyRecoveryEntries(7, 1_800_000_000_000)).toEqual([]);
  });

  it("deletes entries after 30 days, handled or not", async () => {
    const recovery = await api();
    const now = 1_800_000_000_000;
    await recovery.migrateLegacyQueues(now);
    expect(await recovery.purgeExpiredLegacyEntries(now + 30 * day - 1)).toBe(0);
    expect(await recovery.purgeExpiredLegacyEntries(now + 30 * day)).toBe(2);
    expect(store.entries.size).toBe(0);
  });
});
