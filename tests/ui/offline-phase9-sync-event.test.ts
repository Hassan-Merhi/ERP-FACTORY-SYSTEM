import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/featureFlags", () => ({ OFFLINE_MODE_ENABLED: true }));
const state = vi.hoisted(() => ({
  deliver: vi.fn(async () => ({
    acknowledged: 1, rejected: 0, conflicts: 0, retried: 0, paused: false,
  })),
  globalState: vi.fn(),
}));
vi.mock("@/lib/offline/durableOutbox", () => ({
  deliverOfflineOperations: state.deliver,
}));
vi.mock("@/lib/db", () => ({
  db: {},
  appendSyncLog: vi.fn(),
  upsertGlobalSyncState: state.globalState,
  addConflict: vi.fn(),
}));
vi.mock("@/lib/offlineQueue", () => ({
  getQueue: vi.fn(() => []),
  removeFromQueue: vi.fn(),
  updateItemStatus: vi.fn(),
  setLastSynced: vi.fn(),
}));

import { runSync } from "@/lib/syncEngine";

describe("Phase 9 device acknowledgement is not cloud sync", () => {
  it("does not advance cloud-synced timestamp when an HTTP voucher was merely acknowledged", async () => {
    const events: Array<Record<string, unknown>> = [];
    const handler = (event: Event) => events.push((event as CustomEvent<Record<string, unknown>>).detail);
    window.addEventListener("erp:sync", handler);
    try {
      await runSync();
      expect(state.deliver).toHaveBeenCalledTimes(1);
      expect(events).toEqual([{ syncing: true }, { syncing: false, conflictDetected: false }]);
      expect(events.some((event) => "lastSyncedAt" in event)).toBe(false);
      expect(state.globalState).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("erp:sync", handler);
    }
  });
});
