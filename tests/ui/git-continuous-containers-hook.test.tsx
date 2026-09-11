import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePaginatedGITContainers } from "../../client/src/pages/git-containers/usePaginatedGITContainers";

const filters = {
  companyIdentity: 4,
  allCompanies: false,
  pageSize: 1,
  companyFilter: "ALL",
  containerFilters: [],
  supplierFilters: [],
  transporterFilters: [],
  agentFilters: [],
  truckFilters: [],
  locationFilters: [],
  docsFilter: "ALL",
  delayedFilter: "ALL",
  freightFilter: "ALL",
  etaFilter: "ALL" as const,
  notesFilter: "ALL",
  sortOrder: "DEFAULT",
  search: "",
  enabled: true,
};

const originalFetch = window.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function trackingChunk(options: {
  id: number;
  containerNumber: string;
  total?: number;
  hasMore: boolean;
  nextCursor: string | null;
}) {
  return {
    mode: "single" as const,
    companyId: 4,
    companyName: "HADI",
    containers: [{ id: options.id, companyId: 4, containerNumber: options.containerNumber }],
    total: options.total ?? 2,
    limit: 1,
    hasMore: options.hasMore,
    nextCursor: options.nextCursor,
    asOf: "2026-09-11T06:00:00.000Z",
    facets: { statuses: ["Sea"] },
    summary: { totalCost: 10 },
  };
}

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe("usePaginatedGITContainers continuous loading", () => {
  afterEach(() => {
    window.fetch = originalFetch;
  });

  it("paints the first chunk then automatically appends the finite cursor chain", async () => {
    window.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(trackingChunk({ id: 1, containerNumber: "A", hasMore: true, nextCursor: "cursor-2" }))
      )
      .mockResolvedValueOnce(
        jsonResponse(trackingChunk({ id: 2, containerNumber: "B", hasMore: false, nextCursor: null }))
      ) as typeof window.fetch;

    const { result } = renderHook(() => usePaginatedGITContainers(filters), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data?.containers).toHaveLength(2));

    expect(result.current.data).toMatchObject({
      total: 2,
      page: 1,
      totalPages: 1,
      hasMore: false,
      containers: [
        { id: 1, companyId: 4, containerNumber: "A" },
        { id: 2, companyId: 4, containerNumber: "B" },
      ],
    });

    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    const firstUrl = new URL(String(calls[0][0]), window.location.origin);
    const secondUrl = new URL(String(calls[1][0]), window.location.origin);
    expect(firstUrl.searchParams.get("continuous")).toBe("1");
    expect(firstUrl.searchParams.get("limit")).toBe("1");
    expect(firstUrl.searchParams.has("page")).toBe(false);
    expect(secondUrl.searchParams.get("cursor")).toBe("cursor-2");
    expect(secondUrl.searchParams.has("page")).toBe(false);
  });

  it("restarts from the first chunk when the process-local snapshot expires mid-chain", async () => {
    window.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          trackingChunk({ id: 1, containerNumber: "OLD-A", hasMore: true, nextCursor: "expired-cursor" })
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "git-continuous-snapshot-expired", code: "GIT_CONTINUOUS_SNAPSHOT_EXPIRED" },
          409
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          trackingChunk({ id: 10, containerNumber: "FRESH-A", hasMore: true, nextCursor: "fresh-cursor" })
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(trackingChunk({ id: 20, containerNumber: "FRESH-B", hasMore: false, nextCursor: null }))
      ) as typeof window.fetch;

    const { result } = renderHook(() => usePaginatedGITContainers(filters), { wrapper: createWrapper() });

    await waitFor(() =>
      expect(result.current.data?.containers.map((row) => row.containerNumber)).toEqual(["FRESH-A", "FRESH-B"])
    );
    expect(result.current.isError).toBe(false);

    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(4);
    const urls = calls.map((call) => new URL(String(call[0]), window.location.origin));
    expect(urls[0].searchParams.has("cursor")).toBe(false);
    expect(urls[1].searchParams.get("cursor")).toBe("expired-cursor");
    expect(urls[2].searchParams.has("cursor")).toBe(false);
    expect(urls[3].searchParams.get("cursor")).toBe("fresh-cursor");
  });
});
