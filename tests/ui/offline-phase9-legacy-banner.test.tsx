import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineOperation } from "@/lib/offline/operationContract";

const state = vi.hoisted(() => ({
  actor: null as { companyId: number; userId: string } | null,
  operations: [] as OfflineOperation[],
  legacyLocal: 2,
  legacyIdb: 1,
  online: true,
  sync: vi.fn(async () => undefined),
  refreshCounts: vi.fn(async () => undefined),
}));

vi.mock("@/lib/featureFlags", () => ({ OFFLINE_MODE_ENABLED: true }));
vi.mock("@/contexts/ConnectivityContext", () => ({
  useConnectivity: () => ({
    isOnline: state.online,
    isSyncing: false,
    refreshCounts: state.refreshCounts,
  }),
}));
vi.mock("@/lib/db", () => ({
  db: { syncQueue: { count: async () => state.legacyIdb } },
}));
vi.mock("@/lib/offlineQueue", () => ({
  getQueue: () => Array.from({ length: state.legacyLocal }, (_, n) => ({ id: String(n) })),
}));
vi.mock("@/lib/offline/offlineReadCache", () => ({
  getVerifiedOfflineReadScope: () => state.actor,
}));
vi.mock("@/lib/offline/durableOutbox", () => ({
  listOfflineOperations: async () => state.operations,
}));
vi.mock("@/lib/syncEngine", () => ({
  runSync: state.sync,
}));

import { OfflineBanner } from "@/components/OfflineBanner";

const pending = {
  id: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c",
  companyId: 3,
  userId: "operator-1",
  clientDate: "2026-10-30",
  state: "pending",
} as OfflineOperation;

beforeEach(() => {
  state.actor = null;
  state.operations = [];
  state.legacyLocal = 2;
  state.legacyIdb = 1;
  state.online = true;
  state.sync.mockClear();
  state.refreshCounts.mockClear();
});

describe("Phase 9 offline banner refuses unverified legacy replays", () => {
  it("preserves legacy records without exposing their payload or enabling retry", async () => {
    render(<OfflineBanner />);
    await waitFor(() => expect(screen.getByTestId("offline-banner")).toHaveTextContent("3 blocked legacy records"));
    fireEvent.click(screen.getByTestId("offline-banner"));
    expect(screen.getByTestId("offline-legacy-blocked")).toHaveTextContent("NOT sent, retried, or deleted");
    expect(screen.getByTestId("offline-safe-retry")).toBeDisabled();
    expect(screen.queryByText("POS Sale")).not.toBeInTheDocument();
    expect(state.sync).not.toHaveBeenCalled();
  });

  it("only enables the approved durable outbox for the currently verified actor", async () => {
    state.actor = { companyId: 3, userId: "operator-1" };
    state.operations = [pending, { ...pending, id: "11111111-1111-4111-8111-111111111111", state: "acknowledged" }];
    render(<OfflineBanner />);
    await waitFor(() => expect(screen.getByTestId("offline-banner")).toHaveTextContent("1 device-pending"));
    fireEvent.click(screen.getByTestId("offline-banner"));
    expect(screen.getByText("LAN acknowledged · cloud posting NOT verified")).toBeInTheDocument();
    const retry = screen.getByTestId("offline-safe-retry");
    expect(retry).toBeEnabled();
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(state.sync).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("offline-legacy-blocked")).toBeInTheDocument();
  });

  it("refuses even vetted retry when only a legacy queue exists", async () => {
    state.actor = { companyId: 3, userId: "operator-1" };
    render(<OfflineBanner />);
    await waitFor(() => expect(screen.getByTestId("offline-banner")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("offline-banner"));
    expect(screen.getByTestId("offline-safe-retry")).toBeDisabled();
    expect(state.sync).not.toHaveBeenCalled();
  });
});
