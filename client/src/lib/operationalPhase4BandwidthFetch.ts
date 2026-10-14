import { resolveFetchUrl as resolveRequestUrl, fetchRequestMethod as requestMethod } from "./fetchRequestUtils";

const REQUEST_HEADER = "x-erp-compact-response";
const RESPONSE_HEADER = "x-erp-compact-response";
const PROFILE_HEADER = "x-erp-response-profile";
const PROFILE_QUERY = "_erpProfile";
const WIRE_VERSION = "v1";
const DICT_TOKEN = /^~([0-9a-z]+)$/;

type CompactEnvelope = {
  __erpWire: 1;
  d: string[];
  v: unknown;
};

type PatchedWindow = Window & { __operationalPhase4BandwidthFetchInstalled?: boolean };

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
}

function isTargetPath(path: string): boolean {
  if (
    path === "/api/factory/customer-proformas" ||
    path === "/api/factory/daily-bale-scans" ||
    path === "/api/factory/daily-bale-scans/produced" ||
    path === "/api/factory/waste-dispatch/bales" ||
    path === "/api/factory/waste-dispatch/history" ||
    path === "/api/factory/production-value-report"
  ) {
    return true;
  }
  if (/^\/api\/factory\/location-inventory\/\d+$/.test(path)) return true;
  if (/^\/api\/factory\/customer-orders\/\d+$/.test(path)) return true;
  if (/^\/api\/factory\/customer-orders\/\d+\/verification-summary$/.test(path)) return true;
  return false;
}

function responseProfileFor(path: string): string | null {
  const pagePath = window.location.pathname;
  if (pagePath === "/factory/location-inventory" && /^\/api\/factory\/location-inventory\/\d+$/.test(path)) {
    return "location-inventory-summary-v1";
  }
  if (pagePath === "/factory/sales/loading/new" && /^\/api\/factory\/customer-orders\/\d+$/.test(path)) {
    return "loading-order-state-v1";
  }
  if (
    pagePath === "/factory/waste-dispatch" &&
    (path === "/api/factory/waste-dispatch/bales" || path === "/api/factory/waste-dispatch/history")
  ) {
    return "waste-dispatch-page-v1";
  }
  return null;
}

function inputWithProfile(input: RequestInfo | URL, url: URL, profile: string | null): RequestInfo | URL {
  if (!profile) return input;
  const profiled = new URL(url.toString());
  // The shared request-storm cache keys by URL/company. Carry the profile in an
  // ignored query parameter as well as the header so two response shapes can
  // never share an in-flight/cache entry merely because their business URL is
  // otherwise identical.
  profiled.searchParams.set(PROFILE_QUERY, profile);
  if (input instanceof Request) return new Request(profiled.toString(), input);
  if (input instanceof URL) return profiled;
  return profiled.toString();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function decodeValue(value: unknown, dictionary: string[]): unknown {
  if (typeof value === "string") {
    if (value.startsWith("~~")) return value.slice(1);
    const match = value.match(DICT_TOKEN);
    if (match) {
      const index = Number.parseInt(match[1], 36);
      if (Number.isSafeInteger(index) && index >= 0 && index < dictionary.length) return dictionary[index];
    }
    return value;
  }

  if (Array.isArray(value)) return value.map((item) => decodeValue(item, dictionary));

  if (!isPlainRecord(value)) return value;

  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "~a") {
    const compact = value["~a"];
    if (
      Array.isArray(compact) &&
      compact.length === 2 &&
      Array.isArray(compact[0]) &&
      Array.isArray(compact[1]) &&
      compact[0].every((key) => typeof key === "string")
    ) {
      const rowKeys = compact[0] as string[];
      const rows = compact[1] as unknown[];
      return rows.map((rawRow) => {
        const cells = Array.isArray(rawRow) ? rawRow : [];
        const row: Record<string, unknown> = {};
        rowKeys.forEach((key, index) => {
          row[key] = decodeValue(cells[index], dictionary);
        });
        return row;
      });
    }
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeValue(item, dictionary)]));
}

function isEnvelope(value: unknown): value is CompactEnvelope {
  return (
    isPlainRecord(value) &&
    value.__erpWire === 1 &&
    Array.isArray(value.d) &&
    value.d.every((item) => typeof item === "string") &&
    Object.prototype.hasOwnProperty.call(value, "v")
  );
}

async function decodeCompactResponse(response: Response): Promise<Response> {
  if (response.headers.get(RESPONSE_HEADER) !== WIRE_VERSION) return response;

  const envelope = await response
    .clone()
    .json()
    .catch(() => null);
  if (!isEnvelope(envelope)) return response;

  const decoded = decodeValue(envelope.v, envelope.d);
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Transfer-Encoding");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-ERP-Compact-Decoded", WIRE_VERSION);

  return new Response(JSON.stringify(decoded), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function installOperationalPhase4BandwidthFetch(): void {
  const patchedWindow = window as PatchedWindow;
  if (patchedWindow.__operationalPhase4BandwidthFetchInstalled) return;
  patchedWindow.__operationalPhase4BandwidthFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveRequestUrl(input);
    if (
      !url ||
      url.origin !== window.location.origin ||
      requestMethod(input, init) !== "GET" ||
      !isTargetPath(url.pathname)
    ) {
      return originalFetch(input, init);
    }

    const headers = requestHeaders(input, init);
    headers.set(REQUEST_HEADER, WIRE_VERSION);
    const profile = responseProfileFor(url.pathname);
    if (profile) headers.set(PROFILE_HEADER, profile);
    const profiledInput = inputWithProfile(input, url, profile);
    const response = await originalFetch(profiledInput, { ...(init || {}), headers });
    return decodeCompactResponse(response);
  };
}

if (typeof window !== "undefined") installOperationalPhase4BandwidthFetch();

export const operationalPhase4BandwidthWireInternals = {
  decodeValue,
  isTargetPath,
  responseProfileFor,
};
