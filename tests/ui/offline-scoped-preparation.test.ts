import { describe, expect, it, vi } from "vitest";
import { downloadCompleteOfflineDataset } from "@/lib/offline/scopedOfflinePrep";

describe("Phase 2 paginated snapshot download", () => {
  it("downloads every inventory page and synthesizes a complete response", async () => {
    const calls: string[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const page = url.includes("page=2") ? 2 : 1;
      return new Response(
        JSON.stringify({
          data: [{ id: page }],
          total: 2,
          page,
          pageSize: 1,
          totalPages: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const result = await downloadCompleteOfflineDataset("/api/inventory", transport);
    expect(calls).toEqual(["/api/inventory", "/api/inventory?page=2&pageSize=1"]);
    expect(JSON.parse(result)).toMatchObject({
      data: [{ id: 1 }, { id: 2 }],
      total: 2,
      pageSize: 2,
    });
  });

  it("fails closed when a page is missing or a count changes", async () => {
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const page = String(input).includes("page=2") ? 2 : 1;
      return new Response(
        JSON.stringify({
          data: page === 1 ? [{ id: 1 }] : [],
          total: 2,
          page,
          pageSize: 1,
          totalPages: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;
    await expect(downloadCompleteOfflineDataset("/api/inventory", transport)).rejects.toThrow(
      "OFFLINE_PAGINATION_INCOMPLETE"
    );
  });

  it("never mistakes a 403 or an HTML app-shell response for prepared data", async () => {
    await expect(
      downloadCompleteOfflineDataset(
        "/api/inventory",
        vi.fn(async () => new Response("Forbidden", { status: 403 })) as typeof fetch
      )
    ).rejects.toThrow("OFFLINE_PREP_HTTP_403");
    await expect(
      downloadCompleteOfflineDataset(
        "/api/inventory",
        vi.fn(
          async () =>
            new Response("<html>login</html>", {
              status: 200,
              headers: { "Content-Type": "text/html" },
            })
        ) as typeof fetch
      )
    ).rejects.toThrow("OFFLINE_PREP_EXPECTED_JSON");
  });
});
