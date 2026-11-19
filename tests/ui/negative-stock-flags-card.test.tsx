/**
 * Full offline mode (Phase B2): the negative-stock flags card in the Conflict
 * Center. Hidden when PC sync is off (404) or for anyone but an Admin or
 * Developer (403); lists open flags and closes one with a note.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock("@/lib/queryClient", () => ({ apiRequest: harness.apiRequest }));

import { NegativeStockFlagsCard } from "@/components/NegativeStockFlagsCard";

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

const openFlag = {
  id: 7,
  kind: "stock.quick-adjust.v1",
  conflictCode: "PHASE9_STOCK_WOULD_GO_NEGATIVE",
  cloudRef: 412,
  createdBy: "user-1",
  createdAt: "2026-11-18T10:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
};

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NegativeStockFlagsCard />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  harness.apiRequest.mockReset();
});

describe("negative stock flags card", () => {
  it.each([403, 404])("shows nothing when the server answers %i", async (status) => {
    harness.apiRequest.mockImplementation(async () => {
      throw httpError(status);
    });
    const { container } = renderCard();
    await waitFor(() => expect(harness.apiRequest).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[data-testid="negative-stock-flags"]')).toBeNull();
  });

  it("lists open flags and closes one with a note", async () => {
    harness.apiRequest.mockImplementation(async (method: string) => {
      if (method === "GET") return { json: async () => ({ flags: [openFlag] }) };
      return { json: async () => ({ resolved: true }) };
    });
    renderCard();
    expect(await screen.findByTestId("negative-stock-flag-7")).toBeTruthy();
    expect(screen.getByText("stock.quick-adjust.v1")).toBeTruthy();

    const close = screen.getByTestId("negative-stock-flag-close-7") as HTMLButtonElement;
    expect(close.disabled).toBe(true); // a note is required
    fireEvent.change(screen.getByTestId("negative-stock-flag-note-7"), { target: { value: "Counted the shelf" } });
    fireEvent.click(close);

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/offline/pc-sync/negative-stock-flags/7/resolve", {
        note: "Counted the shelf",
      })
    );
  });

  it("says when there are no flags", async () => {
    harness.apiRequest.mockResolvedValue({ json: async () => ({ flags: [] }) });
    renderCard();
    expect(await screen.findByText("No negative-stock flags.")).toBeTruthy();
  });
});
