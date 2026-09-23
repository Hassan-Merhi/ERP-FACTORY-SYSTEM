/**
 * Behaviour of the window.fetch interceptors installed at app start.
 *
 * These wrap every request the app makes, so a regression in any of them is
 * invisible in the UI until money is posted twice or a list silently shows its
 * first page only:
 *
 *  - accountingRequestFetchGuard attaches a retry-stable `clientRequestId` to
 *    protected accounting and operational voucher writes, keeps it across
 *    uncertain outcomes (network, 409, 5xx) and releases it only on a definite
 *    one. Losing it turns a retried commit into a duplicate voucher.
 *  - containerPaginationClient / supplierPurchaseOrderPaginationClient turn
 *    legacy "give me everything" GETs into paged requests and stitch the pages
 *    back into the array shape callers expect.
 *  - bandwidthPhase2PayloadGuard adds the lighter payload profile only while
 *    the inventory On-the-way tab is open.
 *
 * Each case installs the guard fresh over a recording fetch stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/bandwidthPhase1HotspotGuard", () => ({}));

type Call = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installRecorder(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // queryClient prefetches the CSRF token once on first import; it is not
    // part of what these guards decide.
    if (url === "/api/csrf-token") return jsonResponse({ csrfToken: "t" });
    calls.push({ url, init });
    return responder(url, init);
  }) as any;
  return calls;
}

const INSTALL_FLAGS = [
  "__accountingRequestFetchGuardInstalled",
  "__bandwidthPhase2PayloadGuardInstalled",
  "__erpContainerPaginationInstalled",
  "__erpSupplierPurchaseOrderPaginationInstalled",
];

const originalFetch = window.fetch;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  for (const flag of INSTALL_FLAGS) delete (window as any)[flag];
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.fetch = originalFetch;
});

describe("accountingRequestFetchGuard", () => {
  async function install(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const calls = installRecorder(responder);
    await import("@/lib/accountingRequestFetchGuard");
    return calls;
  }

  const journal = {
    voucherDate: "2026-09-01",
    entries: [
      { accountId: 1, debit: 10 },
      { accountId: 2, credit: 10 },
    ],
  };

  it("attaches a clientRequestId to a protected journal write", async () => {
    const calls = await install(() => jsonResponse({ ok: true }, 201));
    await window.fetch("/api/vouchers/journal", { method: "POST", body: JSON.stringify(journal) });

    const sent = JSON.parse(String(calls[0].init?.body));
    expect(typeof sent.clientRequestId).toBe("string");
    expect(sent.clientRequestId.length).toBeGreaterThan(8);
    expect(new Headers(calls[0].init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("reuses the same identity when a 5xx retry sends the same payload", async () => {
    let status = 503;
    const calls = await install(() => jsonResponse({ message: "down" }, status));
    await window.fetch("/api/vouchers/journal", { method: "POST", body: JSON.stringify(journal) });
    status = 201;
    await window.fetch("/api/vouchers/journal", { method: "POST", body: JSON.stringify(journal) });

    const first = JSON.parse(String(calls[0].init?.body)).clientRequestId;
    const second = JSON.parse(String(calls[1].init?.body)).clientRequestId;
    expect(second).toBe(first);
  });

  it("keeps the identity after a 409 with no readable code (fail-closed uncertain outcome)", async () => {
    let status = 409;
    const calls = await install(() => new Response("conflict", { status }));
    await window.fetch("/api/vouchers/journal", { method: "POST", body: JSON.stringify(journal) });
    status = 201;
    await window.fetch("/api/vouchers/journal", { method: "POST", body: JSON.stringify(journal) });

    expect(JSON.parse(String(calls[1].init?.body)).clientRequestId).toBe(
      JSON.parse(String(calls[0].init?.body)).clientRequestId
    );
  });

  it("mints a fresh identity after a definite success", async () => {
    const calls = await install(() => jsonResponse({ ok: true }, 201));
    await window.fetch("/api/vouchers/journal", { method: "POST", body: JSON.stringify(journal) });
    await window.fetch("/api/vouchers/journal", { method: "POST", body: JSON.stringify(journal) });

    expect(JSON.parse(String(calls[1].init?.body)).clientRequestId).not.toBe(
      JSON.parse(String(calls[0].init?.body)).clientRequestId
    );
  });

  it("mints a fresh identity after a definite client rejection (4xx other than uncertain 409)", async () => {
    let status = 400;
    const calls = await install(() => jsonResponse({ message: "bad" }, status));
    await window.fetch("/api/vouchers/journal", { method: "POST", body: JSON.stringify(journal) });
    status = 201;
    await window.fetch("/api/vouchers/journal", { method: "POST", body: JSON.stringify(journal) });

    expect(JSON.parse(String(calls[1].init?.body)).clientRequestId).not.toBe(
      JSON.parse(String(calls[0].init?.body)).clientRequestId
    );
  });

  it("keeps a caller-supplied clientRequestId", async () => {
    const calls = await install(() => jsonResponse({}, 201));
    await window.fetch("/api/vouchers/journal", {
      method: "POST",
      body: JSON.stringify({ ...journal, clientRequestId: "caller-key" }),
    });
    expect(JSON.parse(String(calls[0].init?.body)).clientRequestId).toBe("caller-key");
  });

  it("gives a bodyless phase-5 DELETE a JSON identity body", async () => {
    const calls = await install(() => jsonResponse({}, 200));
    await window.fetch("/api/factory/containers/41", { method: "DELETE" });

    const sent = JSON.parse(String(calls[0].init?.body));
    expect(typeof sent.clientRequestId).toBe("string");
    expect(calls[0].init?.method).toBe("DELETE");
  });

  it("persists an unresolved identity so a reload retries with the same key", async () => {
    const calls = await install(() => {
      throw new TypeError("network down");
    });
    await expect(
      window.fetch("/api/factory/containers/41/reverse-offload", { method: "POST", body: "{}" })
    ).rejects.toThrow("network down");

    const stored = localStorage.getItem("erp_pending_phase5_voucher_request_ids_v1");
    expect(stored).toContain(JSON.parse(String(calls[0].init?.body)).clientRequestId);
  });

  it("leaves GETs, unprotected writes and non-JSON bodies untouched", async () => {
    const calls = await install(() => jsonResponse([]));
    await window.fetch("/api/vouchers");
    await window.fetch("/api/notes", { method: "POST", body: JSON.stringify({ text: "hi" }) });
    const form = new FormData();
    form.append("file", "x");
    await window.fetch("/api/vouchers/journal", { method: "POST", body: form });

    expect(calls[0].init).toBeUndefined();
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ text: "hi" });
    expect(calls[2].init?.body).toBe(form);
  });

  it("leaves a malformed JSON string body untouched", async () => {
    const calls = await install(() => jsonResponse({}));
    await window.fetch("/api/vouchers/journal", { method: "POST", body: "{not json" });
    expect(calls[0].init?.body).toBe("{not json");
  });

  it("reads the body from a Request object", async () => {
    const calls = await install(() => jsonResponse({}, 201));
    const req = new Request(`${window.location.origin}/api/vouchers/journal`, {
      method: "POST",
      body: JSON.stringify(journal),
    });
    await window.fetch(req);
    expect(JSON.parse(String(calls[0].init?.body)).clientRequestId).toBeTruthy();
  });
});

describe("containerPaginationClient", () => {
  it("stitches every page of /api/containers into one array", async () => {
    const calls = installRecorder((url) => {
      const page = Number(new URL(url, window.location.origin).searchParams.get("page"));
      return jsonResponse({
        items: [{ id: page * 10 }, { id: page * 10 + 1 }],
        total: 6,
        page,
        limit: 250,
        totalPages: 3,
      });
    });
    await import("@/lib/containerPaginationClient");

    const res = await window.fetch("/api/containers?status=otw");
    const body = await res.json();
    expect(body.map((c: any) => c.id)).toEqual([10, 11, 20, 21, 30, 31]);
    expect(res.headers.get("X-Total-Count")).toBe("6");
    expect(calls).toHaveLength(3);
    const first = new URL(calls[0].url, window.location.origin);
    expect(first.searchParams.get("pagination")).toBe("1");
    expect(first.searchParams.get("limit")).toBe("250");
    expect(first.searchParams.get("status")).toBe("otw");
  });

  it("passes through an explicitly paginated request and other endpoints", async () => {
    const calls = installRecorder(() => jsonResponse({ items: [] }));
    await import("@/lib/containerPaginationClient");

    await window.fetch("/api/containers?pagination=1&page=2");
    await window.fetch("/api/customers");
    await window.fetch("/api/containers", { method: "POST", body: "{}" });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/containers?pagination=1&page=2",
      "/api/customers",
      "/api/containers",
    ]);
  });

  it("returns the failing page's response when a later page fails", async () => {
    installRecorder((url) => {
      const page = Number(new URL(url, window.location.origin).searchParams.get("page"));
      return page === 2 ? new Response("boom", { status: 500 }) : jsonResponse({ items: [1], total: 2, totalPages: 2 });
    });
    await import("@/lib/containerPaginationClient");

    const res = await window.fetch("/api/containers/active");
    expect(res.status).toBe(500);
  });

  it("returns the first response unchanged when it is not a page envelope", async () => {
    installRecorder(() => jsonResponse([{ id: 1 }]));
    await import("@/lib/containerPaginationClient");

    const res = await window.fetch("/api/containers/sold");
    expect(await res.json()).toEqual([{ id: 1 }]);
  });
});

describe("supplierPurchaseOrderPaginationClient", () => {
  it("stitches supplier purchase-order pages and keeps the total", async () => {
    installRecorder((url) => {
      const page = Number(new URL(url, window.location.origin).searchParams.get("page"));
      return jsonResponse({ items: [`po-${page}`], total: 2, totalPages: 2 });
    });
    await import("@/lib/supplierPurchaseOrderPaginationClient");

    const res = await window.fetch("/api/suppliers/12/purchase-orders");
    expect(await res.json()).toEqual(["po-1", "po-2"]);
    expect(res.headers.get("X-Total-Count")).toBe("2");
  });

  it("does not touch other supplier routes or a failing first page", async () => {
    const calls = installRecorder((url) =>
      url.includes("purchase-orders") ? new Response("nope", { status: 403 }) : jsonResponse({})
    );
    await import("@/lib/supplierPurchaseOrderPaginationClient");

    await window.fetch("/api/suppliers/12");
    const res = await window.fetch("/api/suppliers/12/purchase-orders");
    expect(calls[0].url).toBe("/api/suppliers/12");
    expect(res.status).toBe(403);
  });
});

describe("bandwidthPhase2PayloadGuard", () => {
  async function install() {
    const calls = installRecorder(() => jsonResponse([]));
    await import("@/lib/bandwidthPhase2PayloadGuard");
    return calls;
  }

  it("adds the payload profile to container and inventory GETs on the On-the-way tab", async () => {
    window.history.replaceState(null, "", "/inventory?tab=on-the-way");
    const calls = await install();

    await window.fetch("/api/containers");
    await window.fetch("/api/containers/otw-items");
    await window.fetch("/api/inventory?page=1&pageSize=100");
    await window.fetch("/api/containers/77");

    const profiles = calls.map((c) => new URL(c.url, window.location.origin).searchParams.get("profile"));
    expect(profiles).toEqual(["otw-summary", "stock-otw", "combined", "combined-detail"]);
  });

  it("leaves requests alone off the On-the-way tab, for writes, and when a profile is already set", async () => {
    window.history.replaceState(null, "", "/inventory?tab=by-location");
    const calls = await install();
    await window.fetch("/api/containers");

    window.history.replaceState(null, "", "/inventory?tab=on-the-way");
    await window.fetch("/api/containers", { method: "POST", body: "{}" });
    await window.fetch("/api/containers?profile=full");
    await window.fetch("/api/inventory?page=2&pageSize=100");

    expect(calls.map((c) => c.url)).toEqual([
      "/api/containers",
      "/api/containers",
      "/api/containers?profile=full",
      "/api/inventory?page=2&pageSize=100",
    ]);
  });

  it("clears profiled container queries when navigating into or out of the On-the-way tab", async () => {
    await install();
    const { queryClient } = await import("@/lib/queryClient");
    queryClient.setQueryData(["/api/containers"], [{ id: 1 }]);
    queryClient.setQueryData(["/api/customers"], [{ id: 2 }]);

    window.history.pushState(null, "", "/inventory?tab=on-the-way");
    expect(queryClient.getQueryData(["/api/containers"])).toBeUndefined();
    expect(queryClient.getQueryData(["/api/customers"])).toEqual([{ id: 2 }]);

    queryClient.setQueryData(["/api/containers/5"], { id: 5 });
    window.history.replaceState(null, "", "/inventory?tab=on-the-way&x=1");
    expect(queryClient.getQueryData(["/api/containers/5"])).toEqual({ id: 5 });

    window.history.pushState(null, "", "/dashboard");
    expect(queryClient.getQueryData(["/api/containers/5"])).toBeUndefined();
  });
});
