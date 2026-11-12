/**
 * Standalone browser offline mode (Phase 16): the laptop queue panel shows the
 * connection, counters and each record's status, and its controls call the
 * queue and delivery functions. Approval is offered only to Admin/Developer for
 * an overridable conflict; the cloud checks both again.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  online: true,
  role: "Admin",
  records: [] as any[],
  paused: false,
  calls: [] as string[],
}));

vi.mock("@/contexts/ConnectivityContext", () => ({
  useConnectivity: () => ({ isOnline: state.online, refreshCounts: async () => undefined }),
}));
vi.mock("@/lib/offline/offlineReadCache", () => ({
  getVerifiedOfflineReadScope: () => ({ companyId: 7, userId: "u-1" }),
}));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { getQueryData: () => ({ id: "u-1", currentRole: state.role }) },
}));
vi.mock("@/lib/syncEngine", () => ({
  runSync: async () => {
    state.calls.push("sync");
  },
}));
vi.mock("@/lib/offline/browserOutbox", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/offline/browserOutbox")>();
  return {
    ...real,
    listBrowserOperations: async () => state.records,
    clearFinishedBrowserOperations: async () => {
      state.calls.push("clear");
      return 1;
    },
    exportUnsyncedBrowserOperations: async () => [],
  };
});
vi.mock("@/lib/offline/browserSync", () => ({
  isBrowserSyncPaused: () => state.paused,
  setBrowserSyncPaused: (_actor: unknown, paused: boolean) => {
    state.paused = paused;
    state.calls.push(paused ? "pause" : "resume");
  },
  retryBrowserOperation: async (_a: unknown, id: string) => {
    state.calls.push(`retry:${id}`);
  },
  approveBrowserOperation: async (_a: unknown, id: string) => {
    state.calls.push(`approve:${id}`);
  },
  discardBrowserOperation: async (_a: unknown, id: string) => {
    state.calls.push(`discard:${id}`);
    return "discarded";
  },
}));

import { OfflineModePanel } from "@/components/OfflineModePanel";

function record(id: string, extra: Record<string, unknown>) {
  return {
    id,
    companyId: 7,
    userId: "u-1",
    kind: "stock.quick-adjust.v1",
    label: "Add 4",
    capturedAt: "2026-11-09T08:00:00.000Z",
    state: "saved",
    conflictCode: null,
    conflictOverridable: false,
    lastError: null,
    cloudRef: null,
    ...extra,
  };
}

beforeEach(() => {
  state.online = true;
  state.role = "Admin";
  state.paused = false;
  state.calls = [];
  state.records = [
    record("aaaaaaaa-0000-4000-8000-000000000001", { state: "saved" }),
    record("aaaaaaaa-0000-4000-8000-000000000002", { state: "synced", cloudRef: 91 }),
    record("aaaaaaaa-0000-4000-8000-000000000003", {
      state: "conflict",
      conflictCode: "PHASE9_STOCK_WOULD_GO_NEGATIVE",
      conflictOverridable: true,
    }),
  ];
  Object.defineProperty(globalThis.navigator, "storage", {
    configurable: true,
    value: { estimate: async () => ({ usage: 2 * 1024 * 1024, quota: 100 * 1024 * 1024 }) },
  });
});

describe("Offline mode panel", () => {
  it("shows the connection, counters, statuses and the reason for a conflict", async () => {
    render(<OfflineModePanel />);
    await waitFor(() => expect(screen.getAllByTestId("offline-mode-record")).toHaveLength(3));
    expect(screen.getByTestId("offline-mode-connection").textContent).toContain("Online");
    expect(screen.getByTestId("offline-mode-count-saved-locally").textContent).toBe("1");
    expect(screen.getByTestId("offline-mode-count-synced").textContent).toBe("1");
    expect(screen.getByTestId("offline-mode-count-failed").textContent).toBe("1");
    expect(screen.getByText("The cloud has less stock than this would take.")).toBeTruthy();
    expect(screen.getByTestId("offline-mode-storage").textContent).toContain("2.0 MB");
    expect(screen.getByTestId("offline-mode-supported").textContent).toContain("POS sale");
    expect(screen.getByTestId("offline-mode-unavailable").textContent).toContain("Pressing scans");
  });

  it("syncs, pauses, approves, discards and clears through the queue functions", async () => {
    render(<OfflineModePanel />);
    await waitFor(() => expect(screen.getAllByTestId("offline-mode-record")).toHaveLength(3));
    await act(async () => fireEvent.click(screen.getByTestId("offline-mode-sync-now")));
    await act(async () => fireEvent.click(screen.getByTestId("offline-mode-pause")));
    await act(async () => fireEvent.click(screen.getByTestId("offline-mode-approve")));
    await act(async () => fireEvent.click(screen.getByTestId("offline-mode-discard")));
    await act(async () => fireEvent.click(screen.getByTestId("offline-mode-clear-synced")));
    expect(state.calls).toEqual([
      "sync",
      "pause",
      "approve:aaaaaaaa-0000-4000-8000-000000000003",
      "discard:aaaaaaaa-0000-4000-8000-000000000003",
      "clear",
    ]);
  });

  it("offers approval only to Admin/Developer, and no sync while offline", async () => {
    state.role = "Manager";
    state.online = false;
    render(<OfflineModePanel />);
    await waitFor(() => expect(screen.getAllByTestId("offline-mode-record")).toHaveLength(3));
    expect(screen.queryByTestId("offline-mode-approve")).toBeNull();
    expect((screen.getByTestId("offline-mode-sync-now") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("offline-mode-connection").textContent).toContain("Offline");
  });
});
