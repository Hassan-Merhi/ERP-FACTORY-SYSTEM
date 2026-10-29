import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineOperation } from "@/lib/offline/operationContract";

const state = vi.hoisted(() => ({
  records: new Map<string, any>(),
  serial: 0,
  failStorage: false,
}));

vi.mock("@/lib/db", () => ({
  db: {
    transaction: async (_mode: string, _table: unknown, cb: () => Promise<unknown>) => cb(),
    offlineOperations: {
      add: async (record: OfflineOperation) => {
        if (state.failStorage) throw new Error("Quota exceeded");
        if (state.records.has(record.id)) throw new Error("Duplicate ID");
        state.records.set(record.id, { ...record });
      },
      put: async (record: OfflineOperation) => {
        state.records.set(record.id, { ...record });
      },
      get: async (id: string) => state.records.get(id),
      bulkGet: async (ids: string[]) => ids.map((id) => state.records.get(id)),
      where: (field: string) => ({
        equals: (value: unknown) => ({
          toArray: async () => [...state.records.values()].filter((row) => row[field] === value),
        }),
      }),
    },
    syncQueue: { count: async () => 2 },
  },
}));

const actor = { companyId: 6, userId: "operator-1" };
const payload = { voucher: { narration: "Test" }, entries: [{ debitAmount: "20", creditAmount: "0" }] };

beforeEach(() => {
  vi.resetModules();
  state.records.clear();
  state.serial = 0;
  state.failStorage = false;
  localStorage.clear();
  vi.stubGlobal("crypto", {
    randomUUID: () => `00000000-0000-4000-a000-${String(++state.serial).padStart(12, "0")}`,
  });
});

function transportFor(
  status: number | "network" = 201,
  sessionActor = actor
): { transport: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    calls.push({ url: path, init });
    if (path === "/api/auth/me") return new Response(JSON.stringify({ id: sessionActor.userId }), { status: 200 });
    if (path === "/api/auth/session-company") {
      return new Response(JSON.stringify({ companyId: sessionActor.companyId }), { status: 200 });
    }
    if (status === "network") throw new TypeError("Connection lost after sending");
    return new Response(JSON.stringify({ voucherId: 71 }), { status });
  }) as typeof fetch;
  return { transport, calls };
}

async function queue() {
  const { queueOfflineOperation } = await import("@/lib/offline/durableOutbox");
  return queueOfflineOperation({
    actor,
    mode: "erp",
    entityType: "voucher-with-entries",
    method: "POST",
    url: "/api/vouchers/with-entries",
    clientDate: "2026-10-29",
    payload,
  });
}

describe("durable outbox — capture before delivery", () => {
  it("writes an immutable request identity and payload before any HTTP", async () => {
    const item = await queue();
    expect(state.records.get(item.id)).toMatchObject({
      companyId: 6,
      userId: "operator-1",
      state: "pending",
      payload: JSON.stringify(payload),
      attempts: 0,
    });
    expect(item.deviceId).toMatch(/^00000000-0000-4000-/);
  });

  it("fails closed when durable storage is unavailable", async () => {
    state.failStorage = true;
    await expect(queue()).rejects.toThrow("Quota exceeded");
    expect(state.records.size).toBe(0);
  });

  it("does not allow unverified writes to enter the outbox", async () => {
    const { queueOfflineOperation } = await import("@/lib/offline/durableOutbox");
    await expect(
      queueOfflineOperation({
        actor,
        mode: "factory",
        entityType: "stock",
        method: "POST",
        url: "/api/factory/customer-orders/1/bales",
        clientDate: "2026-10-29",
        payload: { baleId: 1 },
      })
    ).rejects.toThrow("replay guarantee");
    expect(state.records.size).toBe(0);
  });

  it("retains an acknowledged receipt instead of deleting operation history", async () => {
    const row = await queue();
    const { transport, calls } = transportFor();
    const { deliverOfflineOperations } = await import("@/lib/offline/durableOutbox");
    expect(await deliverOfflineOperations(transport)).toMatchObject({ acknowledged: 1 });
    expect(state.records.get(row.id)).toMatchObject({
      state: "acknowledged",
      response: JSON.stringify({ voucherId: 71 }),
      lastError: null,
    });
    const sent = calls.find((call) => call.url === "/api/vouchers/with-entries");
    expect(new Headers(sent?.init?.headers).get("X-Idempotency-Key")).toBe(row.id);
    expect(new Headers(sent?.init?.headers).get("X-Client-Date")).toBe("2026-10-29");
    expect(sent?.init?.body).toBe(JSON.stringify(payload));
    expect(calls).toHaveLength(3);
  });

  it("keeps the original ID after a lost acknowledgement and replays safely later", async () => {
    const row = await queue();
    const { deliverOfflineOperations } = await import("@/lib/offline/durableOutbox");
    const first = transportFor("network");
    expect(await deliverOfflineOperations(first.transport)).toMatchObject({ retried: 1 });
    expect(state.records.get(row.id)).toMatchObject({ state: "pending", attempts: 1 });
    state.records.get(row.id).nextAttemptAt = 0;
    const second = transportFor();
    await deliverOfflineOperations(second.transport);
    const firstHeader = new Headers(first.calls[2]?.init?.headers).get("X-Idempotency-Key");
    const secondHeader = new Headers(second.calls[2]?.init?.headers).get("X-Idempotency-Key");
    expect([firstHeader, secondHeader]).toEqual([row.id, row.id]);
    expect(state.records.get(row.id).state).toBe("acknowledged");
  });

  it("refuses to replay for another user or another company", async () => {
    const row = await queue();
    const { deliverOfflineOperations } = await import("@/lib/offline/durableOutbox");
    const { transport, calls } = transportFor(201, { companyId: 7, userId: "operator-1" });
    await deliverOfflineOperations(transport);
    expect(calls).toHaveLength(2);
    expect(state.records.get(row.id).state).toBe("pending");
    const otherUser = transportFor(201, { companyId: 6, userId: "operator-2" });
    await deliverOfflineOperations(otherUser.transport);
    expect(otherUser.calls).toHaveLength(2);
  });

  it("retains conflicts and terminal rejections for operator review", async () => {
    const { deliverOfflineOperations } = await import("@/lib/offline/durableOutbox");
    const conflictRow = await queue();
    await deliverOfflineOperations(transportFor(409).transport);
    expect(state.records.get(conflictRow.id)).toMatchObject({ state: "conflict" });
    const rejectedRow = await queue();
    await deliverOfflineOperations(transportFor(422).transport);
    expect(state.records.get(rejectedRow.id)).toMatchObject({ state: "rejected" });
    expect(state.records.size).toBe(2);
  });

  it("pauses without deleting requests when session authentication fails", async () => {
    const row = await queue();
    const { deliverOfflineOperations } = await import("@/lib/offline/durableOutbox");
    const { transport } = transportFor(401);
    await deliverOfflineOperations(transport);
    // Session checks succeeded, but the business write was rejected for auth.
    expect(state.records.get(row.id).state).toBe("pending");
  });

  it("retains legacy queues for explicit migration instead of auto-replaying", async () => {
    localStorage.setItem("erp_offline_queue", JSON.stringify([{ id: "old-1" }]));
    const { countLegacyOfflineOperations } = await import("@/lib/offline/durableOutbox");
    expect(await countLegacyOfflineOperations()).toEqual({ indexedDb: 2, localStorage: 1 });
    expect(localStorage.getItem("erp_offline_queue")).toContain("old-1");
  });
});
