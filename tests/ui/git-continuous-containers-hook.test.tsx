import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePaginatedGITContainers } from "../../client/src/pages/git-containers/usePaginatedGITContainers";

const filters = {
  companyIdentity: 4,
  allCompanies: false,
  page: 1,
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("usePaginatedGITContainers Wave 3 continuous loading", () => {
  beforeEach(() => {
    window.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          mode: "single",
          companyId: 4,
          companyName: "HADI",
          containers: [{ id: 1, companyId: 4, containerNumber: "A" }],
          total: 2,
          limit: 1,
          hasMore: true,
          nextCursor: "cursor-2",
          asOf: "2026-09-11T06:00:00.000Z",
          facets: { statuses: ["Sea"] },
          summary: { totalCost: 10 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          mode: "single",
          companyId: 4,
          companyName: "HADI",
          containers: [{ id: 2, companyId: 4, containerNumber: "B" }],
          total: 2,
          limit: 1,
          hasMore: false,
          nextCursor: null,
          asOf: "2026-09-11T06:00:00.000Z",
          facets: { statuses: ["Sea"] },
          summary: { totalCost: 10 },
        })
      ) as typeof window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  it("paints the first chunk then automatically appends the finite cursor chain", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => usePaginatedGITContainers(filters), { wrapper });

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
});
