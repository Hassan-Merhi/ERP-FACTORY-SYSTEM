/**
 * Plan batch 5 (decision 10): the screens of a read-only cold start.
 * - The passphrase screen opens the cached data or says the passphrase
 *   failed.
 * - The banner shows on every page while the tab is a read-only viewer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/featureFlags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  OFFLINE_MODE_ENABLED: true,
}));

const unlock = vi.hoisted(() => vi.fn<(passphrase: string) => Promise<boolean>>());
vi.mock("@/lib/offline/offlineReadCache", () => ({
  unlockColdStartReadOnly: unlock,
  findColdStartTicket: async () => ({ key: "k" }),
  coldStartReadOnlyUntil: () => null,
}));

import { ColdStartReadOnlyBanner, ColdStartUnlockScreen } from "../../client/src/components/OfflineColdStartGate";
import { setColdStartReadOnlyUntil } from "../../client/src/lib/offline/coldStartState";

afterEach(() => {
  setColdStartReadOnlyUntil(null);
  unlock.mockReset();
});

describe("Read-only cold start screens", () => {
  it("unlocks with the right passphrase and says when it is wrong", async () => {
    const onUnlocked = vi.fn();
    render(<ColdStartUnlockScreen onUnlocked={onUnlocked} />);
    unlock.mockResolvedValueOnce(false);
    fireEvent.change(screen.getByTestId("input-cold-start-passphrase"), { target: { value: "wrong-pass" } });
    fireEvent.click(screen.getByTestId("button-cold-start-unlock"));
    expect(await screen.findByTestId("text-cold-start-failed")).toHaveTextContent(
      "That passphrase did not open the offline data on this laptop."
    );
    expect(onUnlocked).not.toHaveBeenCalled();

    unlock.mockResolvedValueOnce(true);
    fireEvent.change(screen.getByTestId("input-cold-start-passphrase"), { target: { value: "right-pass" } });
    fireEvent.click(screen.getByTestId("button-cold-start-unlock"));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(unlock).toHaveBeenLastCalledWith("right-pass");
  });

  it("shows the view-only banner only while the tab is a read-only viewer", async () => {
    const { rerender } = render(<ColdStartReadOnlyBanner />);
    expect(screen.queryByTestId("banner-cold-start-read-only")).toBeNull();
    setColdStartReadOnlyUntil(Date.now() + 60_000);
    act(() => {
      window.dispatchEvent(new Event("erp:offline-cold-start-changed"));
    });
    rerender(<ColdStartReadOnlyBanner />);
    expect(await screen.findByTestId("banner-cold-start-read-only")).toHaveTextContent(
      "Offline: entries that work offline are saved on this laptop and sent when the connection is back"
    );
  });
});
