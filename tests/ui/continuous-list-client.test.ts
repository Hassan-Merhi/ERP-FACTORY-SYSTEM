import { describe, expect, it, vi } from "vitest";
import {
  collectContinuousChunks,
  ContinuousListHttpError,
  fetchContinuousJson,
  withContinuousCursor,
} from "../../client/src/lib/continuousListClient";

describe("continuous list client", () => {
  it("replaces legacy page params with a finite cursor request", () => {
    const url = withContinuousCursor("/api/daybook?page=9&offset=800&pagination=1&search=abc", {
      cursor: "next-token",
      limit: 250,
    });
    const parsed = new URL(url, window.location.origin);

    expect(parsed.pathname).toBe("/api/daybook");
    expect(parsed.searchParams.get("continuous")).toBe("1");
    expect(parsed.searchParams.get("cursor")).toBe("next-token");
    expect(parsed.searchParams.get("limit")).toBe("250");
    expect(parsed.searchParams.get("search")).toBe("abc");
    expect(parsed.searchParams.has("page")).toBe(false);
    expect(parsed.searchParams.has("offset")).toBe(false);
    expect(parsed.searchParams.has("pagination")).toBe(false);
  });

  it("collects a cursor chain in order and rejects repeated cursors", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [1, 2], total: 3, hasMore: true, nextCursor: "c2" })
      .mockResolvedValueOnce({ items: [3], total: 3, hasMore: false, nextCursor: null });

    await expect(collectContinuousChunks({ load })).resolves.toEqual({
      rows: [1, 2, 3],
      first: { items: [1, 2], total: 3, hasMore: true, nextCursor: "c2" },
    });
    expect(load).toHaveBeenNthCalledWith(1, null, undefined);
    expect(load).toHaveBeenNthCalledWith(2, "c2", undefined);

    const loopingLoad = vi
      .fn()
      .mockResolvedValueOnce({ items: [1], total: 3, hasMore: true, nextCursor: "same" })
      .mockResolvedValueOnce({ items: [2], total: 3, hasMore: true, nextCursor: "same" });
    await expect(collectContinuousChunks({ load: loopingLoad })).rejects.toThrow("continuous-list-cursor-stalled");
  });

  it("surfaces server status and error code for retry decisions", async () => {
    const previousFetch = window.fetch;
    window.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Snapshot expired", code: "SNAPSHOT_EXPIRED" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
    ) as typeof window.fetch;
    try {
      await expect(
        fetchContinuousJson("/api/git/containers", { fallbackError: "Failed to load" })
      ).rejects.toMatchObject<Partial<ContinuousListHttpError>>({
        status: 409,
        code: "SNAPSHOT_EXPIRED",
        message: "Snapshot expired",
      });
    } finally {
      window.fetch = previousFetch;
    }
  });
});
