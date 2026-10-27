import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openPressingQueue, pressingRetryDelay, recordWithState,
  type PressingQueuedScan,
} from "./pressingOfflineQueue";

const row: PressingQueuedScan = {
  companyId: 4, userId: "employee-A",
  barcode: "REF300208",
  requestId: "c72872fc-3403-48dc-b915-bca0b82d0d68",
  payload: {
    barcode: "REF300208", machineId: 7, assignmentId: 8,
    requestId: "c72872fc-3403-48dc-b915-bca0b82d0d68",
    deviceCapturedAt: "2026-10-27T08:00:00.000Z",
  },
  state: "pending", attempts: 0, nextAttemptAt: 0,
  createdAt: "2026-10-27T08:00:00.000Z",
  updatedAt: "2026-10-27T08:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("pressing offline queue integrity", () => {
  it("preserves original idempotency key, actor, barcode and request payload through retries", () => {
    const attempted = recordWithState(row, "syncing", {
      attempts: 1, requestId: "different", companyId: 400,
      userId: "another-user", barcode: "ANOTHER_BALE",
      payload: { ...row.payload, requestId: "different" },
    });
    expect(attempted.state).toBe("syncing");
    expect(attempted.attempts).toBe(1);
    expect(attempted.requestId).toBe(row.requestId);
    expect(attempted.companyId).toBe(row.companyId);
    expect(attempted.userId).toBe(row.userId);
    expect(attempted.barcode).toBe(row.barcode);
    expect(attempted.payload).toEqual(row.payload);
    expect(attempted.createdAt).toBe(row.createdAt);
  });

  it("uses bounded retry delays, avoiding a hot reconnect loop", () => {
    expect(pressingRetryDelay(0)).toBe(1500);
    expect(pressingRetryDelay(1)).toBe(3000);
    expect(pressingRetryDelay(2)).toBe(6000);
    expect(pressingRetryDelay(10)).toBe(60000);
  });

  it("fails closed instead of submitting untracked scans without IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(openPressingQueue()).rejects.toThrow("Offline scan storage is unavailable");
  });
});
