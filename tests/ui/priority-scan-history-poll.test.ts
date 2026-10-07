import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRIORITY_SCAN_HISTORY_URL,
  fetchPriorityScanHistory,
  type PriorityScanHistoryResponse,
} from "@/pages/factory/priorityScanHistory";

const key = [PRIORITY_SCAN_HISTORY_URL, 12] as const;
const scan = {
  id: 7,
  referenceNumber: "R-7",
  productName: null,
  articleCode: "A",
  orderId: 1,
  priority: 1,
  color: "Lime",
  scannedBy: "u",
  scannedAt: "2026-10-07T10:00:00Z",
};

function respond(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

describe("priority scan history polling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the full list first and keeps the held list when the server says unchanged", async () => {
    const client = new QueryClient();
    const first = respond({ businessDate: "2026-10-07", serverNow: "t1", signature: "2026-10-07:1:7", scans: [scan] });
    vi.stubGlobal("fetch", first);
    const full = await fetchPriorityScanHistory(client, key);
    expect(first).toHaveBeenCalledWith(PRIORITY_SCAN_HISTORY_URL, expect.anything());
    expect(full.scans).toEqual([scan]);
    client.setQueryData<PriorityScanHistoryResponse>(key, full);

    const second = respond({
      businessDate: "2026-10-07",
      serverNow: "t2",
      signature: "2026-10-07:1:7",
      unchanged: true,
    });
    vi.stubGlobal("fetch", second);
    const kept = await fetchPriorityScanHistory(client, key);
    expect(second).toHaveBeenCalledWith(
      `${PRIORITY_SCAN_HISTORY_URL}&known=${encodeURIComponent("2026-10-07:1:7")}`,
      expect.anything()
    );
    expect(kept).toEqual({ ...full, serverNow: "t2" });
  });

  it("replaces the list when the server sends a new one", async () => {
    const client = new QueryClient();
    client.setQueryData<PriorityScanHistoryResponse>(key, {
      businessDate: "2026-10-07",
      serverNow: "t1",
      signature: "2026-10-07:0:0",
      scans: [],
    });
    vi.stubGlobal(
      "fetch",
      respond({ businessDate: "2026-10-07", serverNow: "t3", signature: "2026-10-07:1:7", scans: [scan] })
    );
    const next = await fetchPriorityScanHistory(client, key);
    expect(next).toEqual({ businessDate: "2026-10-07", serverNow: "t3", signature: "2026-10-07:1:7", scans: [scan] });
  });

  it("throws on an error response so the query keeps its last good data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );
    await expect(fetchPriorityScanHistory(new QueryClient(), key)).rejects.toThrow();
  });
});
