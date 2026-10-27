import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PressingActor, PressingQueuedScan, PressingServerReceipt } from "./pressingOfflineQueue";

// In-memory stand-in for the IndexedDB queue with the same immutability rules.
const store = vi.hoisted(() => new Map<string, PressingQueuedScan>());
vi.mock("./pressingOfflineQueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pressingOfflineQueue")>();
  const scopeOf = (actor: PressingActor) => (row: PressingQueuedScan) =>
    row.companyId === actor.companyId && row.userId === actor.userId;
  return {
    ...actual,
    listPressingScans: async (actor: PressingActor) => [...store.values()].filter(scopeOf(actor)),
    enqueuePressingScan: async (actor: PressingActor, payload: PressingQueuedScan["payload"]) => {
      const barcode = payload.barcode.trim().toUpperCase();
      const duplicate = [...store.values()].find(
        (r) => scopeOf(actor)(r) && r.barcode === barcode && (r.state === "pending" || r.state === "syncing")
      );
      if (duplicate) return { record: duplicate, existing: true };
      const now = new Date().toISOString();
      const record: PressingQueuedScan = {
        ...actor,
        requestId: payload.requestId,
        barcode,
        payload: { ...payload, barcode },
        createdAt: now,
        updatedAt: now,
        state: "pending",
        attempts: 0,
        nextAttemptAt: Date.now(),
      };
      store.set(record.requestId, record);
      return { record, existing: false };
    },
    transitionPressingScan: async (
      actor: PressingActor,
      requestId: string,
      state: PressingQueuedScan["state"],
      changes: Partial<PressingQueuedScan> = {}
    ) => {
      const row = store.get(requestId);
      if (!row || !scopeOf(actor)(row)) return null;
      if (row.state === "confirmed" || row.state === "rejected") return row;
      const next = actual.recordWithState(row, state, changes);
      store.set(requestId, next);
      return next;
    },
  };
});
const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./pressingConfirmClient", () => ({ sendQueuedPressingScan: transport.send }));

import { usePressingOfflineSync } from "./usePressingOfflineSync";

const actor = { companyId: 7, userId: "worker-1" };
function receiptFor(row: PressingQueuedScan, id: number): PressingServerReceipt {
  return {
    id,
    status: "PRESSING_COMPLETED",
    referenceNumber: row.barcode,
    weightKg: "45.000",
    machineName: "Press 01",
    confirmedAt: "2026-10-27T09:26:15.000Z",
    productionDate: "2026-10-27",
    timezoneName: "UTC",
    replayed: false,
    inventoryFinalized: false,
    machineId: row.payload.machineId,
    assignmentId: row.payload.assignmentId,
    requestId: row.requestId,
    operatorUserId: row.userId,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const capture = (barcode: string) => ({
  barcode,
  deviceCapturedAt: new Date().toISOString(),
  assignmentId: 2,
  machineId: 1,
});

beforeEach(() => {
  store.clear();
  transport.send.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ ...actor }) }))
  );
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  vi.stubGlobal("crypto", { randomUUID: () => `uuid-${store.size + 1}-${Math.random().toString(16).slice(2)}` });
});
afterEach(() => vi.unstubAllGlobals());

describe("usePressingOfflineSync delivery ordering", () => {
  it("delivers a scan made during an in-flight request after it, with its own real outcome", async () => {
    const first = deferred<Awaited<ReturnType<typeof transport.send>>>();
    transport.send
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (row: PressingQueuedScan) => ({
        kind: "confirmed",
        receipt: receiptFor(row, 2),
        message: "Pressing completed and saved",
      }));
    const { result } = renderHook(() => usePressingOfflineSync(actor, true));
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    let outcomeA: unknown, outcomeB: unknown;
    const promiseA = result.current.submit(capture("REF-A")).then((o) => {
      outcomeA = o;
    });
    await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
    const promiseB = result.current.submit(capture("REF-B")).then((o) => {
      outcomeB = o;
    });
    // B is durably saved immediately but must not race A on the wire.
    await waitFor(() => expect([...store.values()].map((r) => r.barcode)).toEqual(["REF-A", "REF-B"]));
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(outcomeB).toBeUndefined();

    const rowA = [...store.values()][0];
    await act(async () => {
      first.resolve({ kind: "rejected", code: "PRESSING_ALREADY_CONFIRMED", message: "Already confirmed on Press 02" });
      await promiseA;
      await promiseB;
    });
    expect(outcomeA).toMatchObject({ kind: "duplicate", message: "Already confirmed on Press 02" });
    expect(outcomeB).toMatchObject({ kind: "confirmed", confirmationId: 2, referenceNumber: "REF-B" });
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(transport.send.mock.calls[0][0].requestId).toBe(rowA.requestId);
    expect(transport.send.mock.calls[1][0].barcode).toBe("REF-B");
    expect(store.get(rowA.requestId)?.state).toBe("rejected");
    await waitFor(() =>
      expect(result.current.snapshot).toMatchObject({ confirmed: 1, rejected: 1, pending: 0, syncing: 0 })
    );
  });

  it("stores only while offline and never reports success without a server receipt", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const { result } = renderHook(() => usePressingOfflineSync(actor, true));
    const outcome = await result.current.submit(capture("REF-OFF"));
    expect(outcome.kind).toBe("queued");
    expect(outcome.message).toContain("NOT yet counted");
    expect(transport.send).not.toHaveBeenCalled();
    expect([...store.values()][0]).toMatchObject({ state: "pending", barcode: "REF-OFF" });
    // The same barcode scanned again offline is not queued twice.
    const again = await result.current.submit(capture("ref-off"));
    expect(again.message).toContain("will not be counted twice");
    expect(store.size).toBe(1);
  });

  it("keeps the original request ID on retry after an uncertain network failure", async () => {
    transport.send
      .mockImplementationOnce(async () => ({
        kind: "retry",
        code: "PRESSING_CONNECTION_UNCERTAIN",
        message: "Connection or server unavailable.",
      }))
      .mockImplementationOnce(async (row: PressingQueuedScan) => ({
        kind: "confirmed",
        receipt: receiptFor(row, 9),
        message: "Pressing completed and saved",
      }));
    const { result } = renderHook(() => usePressingOfflineSync(actor, true));
    // Let the mount-time sync pass finish so the submit is the first delivery.
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const outcome = await result.current.submit(capture("REF-RETRY"));
    expect(outcome.kind).toBe("queued");
    const [row] = [...store.values()];
    expect(row).toMatchObject({ state: "pending", attempts: 1 });
    expect(row.nextAttemptAt).toBeGreaterThan(Date.now());
    // "Retry pending" is an explicit worker action and ignores the backoff.
    await act(async () => {
      await result.current.retryNow();
    });
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(transport.send.mock.calls[1][0].requestId).toBe(row.requestId);
    expect(store.get(row.requestId)).toMatchObject({ state: "confirmed", attempts: 2 });
    expect(store.get(row.requestId)?.receipt?.id).toBe(9);
  });

  it("refuses to replay rows when the signed-in company or operator changed", async () => {
    store.set("stale", {
      ...actor,
      requestId: "stale",
      barcode: "REF-STALE",
      payload: {
        barcode: "REF-STALE",
        machineId: 1,
        assignmentId: 2,
        deviceCapturedAt: "2026-10-27T08:00:00.000Z",
        requestId: "stale",
      },
      createdAt: "2026-10-27T08:00:00.000Z",
      updatedAt: "2026-10-27T08:00:00.000Z",
      state: "syncing",
      attempts: 1,
      nextAttemptAt: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ companyId: 8, userId: "someone-else" }) }))
    );
    const { result } = renderHook(() => usePressingOfflineSync(actor, true));
    await waitFor(() =>
      expect(result.current.snapshot.error).toContain("reconnect as the original company and operator")
    );
    expect(transport.send).not.toHaveBeenCalled();
    expect(store.get("stale")?.state).toBe("syncing");
    // A different actor never sees this row at all.
    const other = renderHook(() => usePressingOfflineSync({ companyId: 8, userId: "someone-else" }, true));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(other.result.current.snapshot.items).toEqual([]);
  });
});
