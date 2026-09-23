/**
 * The offline sync engine replays writes the factory floor made while offline.
 * Getting its classification wrong either loses work (dropping a retryable
 * item) or duplicates it (replaying a conflict), so each server outcome is
 * pinned here:
 *
 *   2xx  → removed from the queue
 *   401  → stop the run and send the user to /login, queue untouched
 *   409  → recorded as a conflict for a human, removed from the queue
 *   4xx  → permanent failure, never retried
 *   5xx / network → retried with exponential backoff, failed after 5 tries
 *
 * IndexedDB is replaced by an in-memory table with the same Dexie surface the
 * engine uses; the legacy localStorage queue is the real module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Item = {
  id?: number;
  url: string;
  method: string;
  payload?: string;
  description: string;
  entityType?: string;
  operation?: string;
  status: "pending" | "failed";
  retryCount: number;
  nextRetryAt?: number;
  lastError?: string;
};

const store = vi.hoisted(() => ({
  rows: new Map<number, any>(),
  nextId: 1,
  logs: [] as Array<{ type: string; message: string }>,
  conflicts: [] as any[],
  state: {} as Record<string, unknown>,
}));

vi.mock("@/lib/db", () => {
  const syncQueue = {
    where: (field: string) => ({
      equals: (value: unknown) => ({
        toArray: async () => [...store.rows.values()].filter((r) => r[field] === value).map((r) => ({ ...r })),
      }),
    }),
    update: async (id: number, patch: Record<string, unknown>) => {
      const row = store.rows.get(id);
      if (row) store.rows.set(id, { ...row, ...patch });
    },
    delete: async (id: number) => {
      store.rows.delete(id);
    },
  };
  return {
    db: { syncQueue },
    appendSyncLog: async (type: string, message: string) => {
      store.logs.push({ type, message });
    },
    upsertGlobalSyncState: async (patch: Record<string, unknown>) => {
      Object.assign(store.state, patch);
    },
    addConflict: async (conflict: unknown) => {
      store.conflicts.push(conflict);
    },
  };
});

function enqueue(item: Partial<Item> & { url: string }): number {
  const id = store.nextId++;
  store.rows.set(id, {
    id,
    method: "POST",
    description: `item ${id}`,
    status: "pending",
    retryCount: 0,
    payload: JSON.stringify({ n: id }),
    ...item,
  });
  return id;
}

function respondWith(map: Record<string, Response | Error>) {
  const calls: string[] = [];
  window.fetch = vi.fn(async (url: any) => {
    calls.push(String(url));
    const r = map[String(url)];
    if (r instanceof Error) throw r;
    return r ? r.clone() : new Response("{}", { status: 200 });
  }) as any;
  return calls;
}

const originalFetch = window.fetch;
const originalLocation = window.location;

beforeEach(() => {
  vi.resetModules();
  store.rows.clear();
  store.nextId = 1;
  store.logs = [];
  store.conflicts = [];
  store.state = {};
  localStorage.clear();
  Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, href: "/" } });
});

afterEach(() => {
  window.fetch = originalFetch;
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

async function load() {
  return import("@/lib/syncEngine");
}

describe("runSync outcome classification", () => {
  it("removes items the server accepted and records the run as idle", async () => {
    const id = enqueue({ url: "/api/factory/bales" });
    respondWith({});
    const events: any[] = [];
    window.addEventListener("erp:sync", (e: any) => events.push(e.detail));

    const { runSync } = await load();
    await runSync();

    expect(store.rows.has(id)).toBe(false);
    expect(store.state).toMatchObject({ status: "idle", errorMessage: null });
    expect(events[0]).toEqual({ syncing: true });
    expect(events.at(-1)).toMatchObject({ syncing: false, conflictDetected: false });
    expect(store.logs.at(-1)?.message).toBe("Sync done: 1 ok, 0 failed");
  });

  it("records a 409 as a conflict and removes it so it is never replayed", async () => {
    const id = enqueue({ url: "/api/factory/bales/9", method: "PATCH", entityType: "bale", operation: "update" });
    respondWith({
      "/api/factory/bales/9": new Response(JSON.stringify({ message: "Bale already sold" }), { status: 409 }),
    });

    const { runSync } = await load();
    await runSync();

    expect(store.rows.has(id)).toBe(false);
    expect(store.conflicts).toHaveLength(1);
    expect(store.conflicts[0]).toMatchObject({
      syncQueueItemId: id,
      entityType: "bale",
      conflictReason: "Bale already sold",
      method: "PATCH",
    });
    expect(store.logs.at(-1)?.message).toContain("conflicts detected");
  });

  it("marks a 4xx as a permanent failure that will not be retried", async () => {
    const id = enqueue({ url: "/api/factory/bales" });
    respondWith({ "/api/factory/bales": new Response("not json", { status: 422 }) });

    const { runSync } = await load();
    await runSync();

    expect(store.rows.get(id)).toMatchObject({
      status: "failed",
      lastError: "not json",
      retryCount: 5,
      nextRetryAt: Number.MAX_SAFE_INTEGER,
    });
  });

  it("retries a 5xx with exponential backoff", async () => {
    const id = enqueue({ url: "/api/factory/bales", retryCount: 2 });
    respondWith({ "/api/factory/bales": new Response(JSON.stringify({ message: "db down" }), { status: 503 }) });
    const before = Date.now();

    const { runSync } = await load();
    await runSync();

    const row = store.rows.get(id);
    expect(row).toMatchObject({ status: "pending", retryCount: 3, lastError: "db down" });
    // 3s * 2^3 = 24s backoff.
    expect(row.nextRetryAt - before).toBeGreaterThanOrEqual(24_000);
    expect(row.nextRetryAt - before).toBeLessThan(26_000);
  });

  it("fails an item for good on its fifth network error", async () => {
    const id = enqueue({ url: "/api/factory/bales", retryCount: 4 });
    respondWith({ "/api/factory/bales": new TypeError("Failed to fetch") });

    const { runSync } = await load();
    await runSync();

    expect(store.rows.get(id)).toMatchObject({ status: "failed", retryCount: 5, lastError: "Failed to fetch" });
  });

  it("skips items still inside their backoff window", async () => {
    enqueue({ url: "/api/factory/later", nextRetryAt: Date.now() + 60_000 });
    const calls = respondWith({});

    const { runSync } = await load();
    await runSync();

    expect(calls).toEqual([]);
  });

  it("stops at a 401, leaves the rest queued and sends the user to sign in", async () => {
    enqueue({ url: "/api/a" });
    const second = enqueue({ url: "/api/b" });
    const calls = respondWith({ "/api/a": new Response("", { status: 401 }) });

    const { runSync } = await load();
    await runSync();

    expect(calls).toEqual(["/api/a"]);
    expect(store.rows.has(second)).toBe(true);
    expect(window.location.href).toBe("/login");
  });

  it("replays the legacy localStorage queue after the IndexedDB queue", async () => {
    const { enqueueRequest, getQueue } = await import("@/lib/offlineQueue");
    enqueueRequest("/api/factory/waste", "POST", JSON.stringify({ kg: 5 }), "Waste entry", "2026-09-01");
    enqueueRequest("/api/factory/waste-bad", "POST", JSON.stringify({ kg: 1 }), "Bad waste");
    respondWith({ "/api/factory/waste-bad": new Response(JSON.stringify({ message: "invalid" }), { status: 400 }) });

    const { runSync } = await load();
    await runSync();

    const sent = (window.fetch as any).mock.calls.find((c: any[]) => c[0] === "/api/factory/waste");
    expect(sent[1].headers["X-Client-Date"]).toBe("2026-09-01");
    const left = getQueue();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ url: "/api/factory/waste-bad", status: "failed" });
  });

  it("does not start a second run while one is in progress", async () => {
    enqueue({ url: "/api/slow" });
    let release!: () => void;
    window.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response("{}"));
        })
    ) as any;

    const { runSync, isSyncInProgress } = await load();
    const first = runSync();
    await vi.waitFor(() => expect(window.fetch).toHaveBeenCalledTimes(1));
    expect(isSyncInProgress()).toBe(true);
    await runSync();
    expect(window.fetch).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(isSyncInProgress()).toBe(false);
  });
});

describe("deduplicateQueue", () => {
  it("keeps only the newest pending PATCH/PUT per URL and leaves POSTs alone", async () => {
    const oldPatch = enqueue({ url: "/api/bales/1", method: "PATCH" });
    const post1 = enqueue({ url: "/api/bales", method: "POST" });
    const newPatch = enqueue({ url: "/api/bales/1", method: "PATCH" });
    const post2 = enqueue({ url: "/api/bales", method: "POST" });
    const put = enqueue({ url: "/api/bales/2", method: "PUT" });

    const { deduplicateQueue } = await load();
    await deduplicateQueue();

    expect([...store.rows.keys()].sort()).toEqual([post1, newPatch, post2, put].sort());
    expect(store.rows.has(oldPatch)).toBe(false);
  });
});
