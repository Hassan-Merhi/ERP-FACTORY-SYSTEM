import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TARGET = "/api/factory/location-inventory/7";
let underlyingFetch: ReturnType<typeof vi.fn>;
let bandwidthModule: typeof import("../../client/src/lib/operationalBandwidthFetch");

function compactResponse(value: unknown, dictionary: string[] = []): Response {
  return new Response(JSON.stringify({ __erpWire: 1, d: dictionary, v: value }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": "100",
      "x-erp-compact-response": "v1",
    },
  });
}

function sentUrl(call: unknown[]): URL {
  const input = call[0];
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  return new URL(raw, "http://localhost");
}

function sentHeaders(call: unknown[]): Headers {
  const init = (call[1] ?? {}) as RequestInit;
  return new Headers(init.headers);
}

beforeAll(async () => {
  window.history.replaceState({}, "", "/factory/location-inventory");
  delete (window as Window & { __operationalPhase4BandwidthFetchInstalled?: boolean })
    .__operationalPhase4BandwidthFetchInstalled;
  underlyingFetch = vi.fn(async () => compactResponse({ ok: true }));
  window.fetch = underlyingFetch as unknown as typeof window.fetch;
  bandwidthModule = await import("../../client/src/lib/operationalBandwidthFetch");
});

beforeEach(() => {
  window.history.replaceState({}, "", "/factory/location-inventory");
  underlyingFetch.mockClear();
  underlyingFetch.mockImplementation(async () => compactResponse({ ok: true }));
});

describe("operational Phase 4 compact bandwidth fetch", () => {
  it("requests the compact location profile and decodes the response", async () => {
    underlyingFetch.mockImplementationOnce(async () =>
      compactResponse({ "~a": [["name", "status"], [["~0", "~1"]]] }, ["Warehouse", "available"])
    );

    const response = await window.fetch(`${TARGET}?companyId=1`);
    const body = await response.json();

    expect(body).toEqual([{ name: "Warehouse", status: "available" }]);
    const call = underlyingFetch.mock.calls[0];
    const url = sentUrl(call);
    expect(url.searchParams.get("_erpProfile")).toBe("location-inventory-summary-v1");
    expect(sentHeaders(call).get("x-erp-compact-response")).toBe("v1");
    expect(sentHeaders(call).get("x-erp-response-profile")).toBe("location-inventory-summary-v1");
    expect(response.headers.get("x-erp-compact-decoded")).toBe("v1");
    expect(response.headers.has("content-length")).toBe(false);
  });

  it("keeps target requests compact even when no page-specific profile applies", async () => {
    window.history.replaceState({}, "", "/factory/dashboard");
    await window.fetch("/api/factory/daily-bale-scans");

    const call = underlyingFetch.mock.calls[0];
    expect(sentHeaders(call).get("x-erp-compact-response")).toBe("v1");
    expect(sentHeaders(call).has("x-erp-response-profile")).toBe(false);
    expect(sentUrl(call).searchParams.has("_erpProfile")).toBe(false);
  });

  it("does not rewrite unrelated, cross-origin, or non-GET requests", async () => {
    await window.fetch("/api/health");
    await window.fetch("https://example.com/api/factory/daily-bale-scans");
    await window.fetch("/api/factory/daily-bale-scans", { method: "POST" });

    for (const call of underlyingFetch.mock.calls) {
      expect(sentHeaders(call).has("x-erp-compact-response")).toBe(false);
    }
  });

  it("decodes dictionary tokens, escaped tokens, nested objects, and compact rows", () => {
    const { decodeValue } = bandwidthModule.operationalPhase4BandwidthWireInternals;
    const decoded = decodeValue(
      {
        token: "~0",
        escaped: "~~0",
        nested: ["~1", { value: "~0" }],
        rows: {
          "~a": [
            ["name", "qty"],
            [
              ["~0", 3],
              ["~1", 5],
            ],
          ],
        },
      },
      ["Alpha", "Beta"]
    );

    expect(decoded).toEqual({
      token: "Alpha",
      escaped: "~0",
      nested: ["Beta", { value: "Alpha" }],
      rows: [
        { name: "Alpha", qty: 3 },
        { name: "Beta", qty: 5 },
      ],
    });
  });

  it("leaves malformed compact envelopes readable as the original response", async () => {
    underlyingFetch.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ __erpWire: 1, d: "not-a-dictionary", v: 1 }), {
          status: 200,
          headers: { "x-erp-compact-response": "v1" },
        })
    );

    const response = await window.fetch("/api/factory/daily-bale-scans");
    expect(await response.json()).toEqual({
      __erpWire: 1,
      d: "not-a-dictionary",
      v: 1,
    });
    expect(response.headers.has("x-erp-compact-decoded")).toBe(false);
  });

  it("recognizes only the intended high-bandwidth endpoint families", () => {
    const { isTargetPath } = bandwidthModule.operationalPhase4BandwidthWireInternals;
    expect(isTargetPath("/api/factory/customer-proformas")).toBe(true);
    expect(isTargetPath("/api/factory/customer-orders/42")).toBe(true);
    expect(isTargetPath("/api/factory/customer-orders/42/verification-summary")).toBe(true);
    expect(isTargetPath("/api/factory/location-inventory/42")).toBe(true);
    expect(isTargetPath("/api/factory/location-inventory/all")).toBe(false);
    expect(isTargetPath("/api/factory/customer-orders/all/details")).toBe(false);
  });
});
