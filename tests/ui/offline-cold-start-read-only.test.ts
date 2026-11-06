// @vitest-environment node
/**
 * Plan batch 5 (decision 10): a laptop that reaches neither the cloud nor the
 * factory server becomes a read-only viewer for at most 24 hours after the
 * user's last online sign-in. The ticket is sealed with the passphrase-derived
 * vault key, so only that passphrase opens it and its expiry cannot be edited.
 * Signing out, or a disabled account seen online, wipes it. Every write is
 * refused while it is open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  snapshots: new Map<string, any>(),
  grants: new Map<string, any>(),
  tickets: new Map<string, any>(),
}));

vi.mock("../../client/src/lib/db", () => {
  const table = (map: Map<string, any>) => ({
    get: async (key: string) => map.get(key),
    put: async (row: any) => {
      map.set(row.key, { ...row });
    },
    bulkPut: async (rows: any[]) => {
      for (const row of rows) map.set(row.key, { ...row });
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    bulkDelete: async (keys: string[]) => {
      for (const key of keys) map.delete(key);
    },
    toArray: async () => [...map.values()].map((row) => ({ ...row })),
    orderBy: (field: string) => ({
      reverse: () => ({
        toArray: async () => [...map.values()].map((row) => ({ ...row })).sort((a, b) => b[field] - a[field]),
      }),
    }),
    where: () => ({
      equals: ([companyId, userId]: [number, string]) => ({
        delete: async () => {
          for (const [key, row] of map) if (row.companyId === companyId && row.userId === userId) map.delete(key);
        },
      }),
    }),
  });
  return {
    db: {
      transaction: async (_mode: string, _a: any, _b: any, cb: () => Promise<void>) => cb(),
      offlineReadSnapshots: table(store.snapshots),
      offlineReadGrants: table(store.grants),
      offlineColdStartTickets: table(store.tickets),
    },
  };
});

const companyId = 16;
const userId = "factory-operator";
const source = "/api/factory/raw-stock";
const passphrase = "a-strong-device-passphrase";
const body = JSON.stringify({ data: [{ batch: "CONFIDENTIAL-001", kg: 100 }] });
const me = { id: userId, username: "operator", role: "Manager", active: true };
const sessionCompany = { companyId };
const companies = [{ companyId, companyName: "Factory", companyActive: true }];

function serveIdentity(user: unknown = me, assignments: unknown = companies) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const payload =
        url === "/api/auth/me" ? user : url === "/api/auth/session-company" ? sessionCompany : assignments;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
}

async function api() {
  return import("../../client/src/lib/offline/offlineReadCache");
}

/** Online: verify, prepare an encrypted cache, which seals the cold-start ticket. */
async function prepareOnline() {
  serveIdentity();
  const cache = await api();
  expect(await cache.verifyOfflineReadScope(companyId)).toEqual({ companyId, userId });
  await cache.saveVerifiedOfflineReadBatch(
    { companyId, userId, snapshots: [{ url: source, body }], total: 1 },
    passphrase
  );
  return cache;
}

/** A browser restart: in-memory state is gone, IndexedDB stays. */
async function restart() {
  vi.resetModules();
  vi.unstubAllGlobals();
  return api();
}

beforeEach(() => {
  store.snapshots.clear();
  store.grants.clear();
  store.tickets.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Read-only cold start (decision 10)", () => {
  it("seals a ticket online and, after a restart with no connection, opens the cache read-only with the passphrase", async () => {
    await prepareOnline();
    const [ticket] = [...store.tickets.values()];
    expect(ticket).toMatchObject({ companyId, userId });
    expect(ticket.expiresAt - ticket.verifiedAt).toBe(24 * 60 * 60 * 1000);
    expect(ticket.sealed).not.toContain("operator");

    const cache = await restart();
    const state = await import("../../client/src/lib/offline/coldStartState");
    expect(await cache.readPreparedOfflineResponse("GET", source)).toBeNull();
    expect(await cache.unlockColdStartReadOnly("wrong-passphrase-12345")).toBe(false);
    expect(cache.isColdStartReadOnly()).toBe(false);

    expect(await cache.unlockColdStartReadOnly(passphrase)).toBe(true);
    expect(cache.isColdStartReadOnly()).toBe(true);
    expect(state.coldStartReadOnlyActive()).toBe(true);
    expect(await (await cache.readPreparedOfflineResponse("GET", source))?.json()).toEqual(JSON.parse(body));
    expect(await cache.readColdStartIdentityResponse("GET", "/api/auth/me")?.json()).toEqual(me);
    expect(await cache.readColdStartIdentityResponse("GET", "/api/user/companies")?.json()).toEqual(companies);
    // Only the three identity reads, and never for a write.
    expect(cache.readColdStartIdentityResponse("GET", "/api/auth/permissions")).toBeNull();
    expect(cache.readColdStartIdentityResponse("POST", "/api/auth/me")).toBeNull();

    // Every write is refused locally while it is open.
    const refusal = state.coldStartReadOnlyResponse();
    expect(refusal.status).toBe(423);
    expect(await refusal.json()).toMatchObject({ code: "OFFLINE_COLD_START_READ_ONLY" });

    // Preparing new data is an online action only.
    await expect(
      cache.saveVerifiedOfflineReadBatch(
        { companyId, userId, snapshots: [{ url: source, body }], total: 1 },
        passphrase
      )
    ).rejects.toThrow();
  });

  it("refuses a ticket older than 24 hours, and one whose expiry was edited on disk", async () => {
    const realNow = Date.now();
    await prepareOnline();
    const cache = await restart();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 25 * 60 * 60 * 1000);
    expect(await cache.findColdStartTicket()).toBeNull();
    expect(await cache.unlockColdStartReadOnly(passphrase)).toBe(false);
    vi.restoreAllMocks();

    const [ticket] = [...store.tickets.values()];
    store.tickets.set(ticket.key, {
      ...ticket,
      verifiedAt: ticket.verifiedAt + 1000,
      expiresAt: ticket.expiresAt + 1000,
    });
    const again = await restart();
    expect(await again.unlockColdStartReadOnly(passphrase)).toBe(false);
    expect(again.isColdStartReadOnly()).toBe(false);
  });

  it("wipes the ticket on sign-out, and when the server says the account is disabled", async () => {
    let cache = await prepareOnline();
    await cache.wipeColdStartAccess(userId);
    expect(store.tickets.size).toBe(0);
    cache = await restart();
    expect(await cache.unlockColdStartReadOnly(passphrase)).toBe(false);

    cache = await prepareOnline();
    expect(store.tickets.size).toBe(1);
    serveIdentity({ ...me, active: false });
    expect(await cache.verifyOfflineReadScope(companyId)).toBeNull();
    expect(store.tickets.size).toBe(0);
  });

  it("wipes a company's ticket and cached data when the account no longer belongs to it", async () => {
    const cache = await prepareOnline();
    serveIdentity(me, []);
    expect(await cache.verifyOfflineReadScope(companyId)).toBeNull();
    expect(store.tickets.size).toBe(0);
    expect(store.grants.size).toBe(0);
    expect(store.snapshots.size).toBe(0);
  });

  it("ends the read-only view when the user is verified online again", async () => {
    await prepareOnline();
    const cache = await restart();
    const state = await import("../../client/src/lib/offline/coldStartState");
    expect(await cache.unlockColdStartReadOnly(passphrase)).toBe(true);
    serveIdentity();
    expect(await cache.verifyOfflineReadScope(companyId)).toEqual({ companyId, userId });
    expect(cache.isColdStartReadOnly()).toBe(false);
    expect(state.coldStartReadOnlyActive()).toBe(false);
  });
});
