import { queryClient } from "./queryClient";

const BYPASS_HEADER = "x-phase4-bandwidth-bypass";
const DAILY_PAGE_SIZE = 250;
const DAILY_RECONCILE_MS = 10 * 60_000;
const PROFORMA_CACHE_MS = 5 * 60_000;

const DAILY_LIST_PATHS = new Set(["/api/factory/daily-bale-scans", "/api/factory/daily-bale-scans/produced"]);

const PROFORMA_LIST_PATH = "/api/factory/customer-proformas";
const PROFORMA_DETAIL_PATH = /^\/api\/factory\/customer-proformas\/(\d+)$/;
const PROFORMA_WRITE_PATH = /^\/api\/factory\/customer-proforma(?:s|-lines)(?:\/|$)/;

/**
 * The payloads this interceptor handles come off the wire untyped. Each shape
 * below names only the fields the interception logic actually reads; the index
 * signature carries the rest of the server's response through untouched, so
 * re-serialising a row never drops a field this file does not know about.
 */
type DailyScanRow = {
  id?: number | string;
  scan_date?: string;
  [field: string]: unknown;
};

type ProformaSummaryRow = {
  id?: number | string;
  isActive?: boolean;
  [field: string]: unknown;
};

type ProformaDetail = {
  lines?: unknown;
  [field: string]: unknown;
};

/** Marker for the one-time fetch patch, kept off the global `Window` type. */
type PatchedWindow = Window & { __phase4BandwidthFetchInstalled?: boolean };

type DailyCacheEntry = {
  rows: DailyScanRow[];
  reconciledAt: number;
};

type TimedResponse = {
  response: Response;
  expiresAt: number;
};

const dailyCache = new Map<string, DailyCacheEntry>();
const proformaSummaryCache = new Map<string, TimedResponse>();
const proformaDetailCache = new Map<number, TimedResponse>();

function resolveUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input, window.location.origin);
    if (input instanceof URL) return new URL(input.toString(), window.location.origin);
    if (input instanceof Request) return new URL(input.url, window.location.origin);
  } catch {
    return null;
  }
  return null;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
}

function withBypassHeaders(input: RequestInfo | URL, init?: RequestInit): RequestInit {
  const headers = requestHeaders(input, init);
  headers.set(BYPASS_HEADER, "1");
  return { ...(init || {}), headers };
}

function jsonResponseFrom(source: Response, payload: unknown): Response {
  const headers = new Headers(source.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Response(JSON.stringify(payload), {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
}

function dailyKey(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  for (const name of ["page", "pageSize", "limit", "offset", "afterId"]) params.delete(name);
  params.sort();
  return `${url.pathname}?${params.toString()}`;
}

function mergeRows(current: DailyScanRow[], incoming: DailyScanRow[]): DailyScanRow[] {
  const byId = new Map<number, DailyScanRow>();
  for (const row of current) byId.set(Number(row.id), row);
  for (const row of incoming) byId.set(Number(row.id), row);
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

async function fetchAllPages(
  originalFetch: typeof window.fetch,
  sourceUrl: URL,
  init: RequestInit | undefined,
  afterId?: number
): Promise<{ rows: DailyScanRow[]; response: Response }> {
  const rows: DailyScanRow[] = [];
  let page = 1;
  let totalPages: number;
  let lastResponse: Response;

  do {
    const url = new URL(sourceUrl.toString());
    url.searchParams.delete("limit");
    url.searchParams.delete("offset");
    url.searchParams.set("pageSize", String(DAILY_PAGE_SIZE));
    url.searchParams.set("page", String(page));
    if (afterId && afterId > 0) url.searchParams.set("afterId", String(afterId));
    else url.searchParams.delete("afterId");

    const response = await originalFetch(url.toString(), withBypassHeaders(url, init));
    lastResponse = response;
    if (!response.ok) return { rows: [], response };

    const pageRows = await response
      .clone()
      .json()
      .catch(() => []);
    if (Array.isArray(pageRows)) rows.push(...pageRows);
    totalPages = Math.max(1, Number(response.headers.get("X-Total-Pages") || 1));
    page += 1;
  } while (page <= totalPages);

  return { rows, response: lastResponse! };
}

async function handleDailyList(
  originalFetch: typeof window.fetch,
  url: URL,
  init: RequestInit | undefined
): Promise<Response> {
  const key = dailyKey(url);
  const cached = dailyCache.get(key);
  const needsReconcile = !cached || Date.now() - cached.reconciledAt >= DAILY_RECONCILE_MS;

  if (needsReconcile) {
    const full = await fetchAllPages(originalFetch, url, init);
    if (!full.response.ok) return full.response;
    const rows = mergeRows([], full.rows);
    dailyCache.set(key, { rows, reconciledAt: Date.now() });
    return jsonResponseFrom(full.response, rows);
  }

  const maxId = cached.rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0);
  const delta = await fetchAllPages(originalFetch, url, init, maxId || undefined);
  if (!delta.response.ok) return delta.response;
  const rows = mergeRows(cached.rows, delta.rows);
  dailyCache.set(key, { rows, reconciledAt: cached.reconciledAt });
  return jsonResponseFrom(delta.response, rows);
}

function clearProformaCaches(): void {
  proformaSummaryCache.clear();
  proformaDetailCache.clear();
}

async function getProformaDetail(
  originalFetch: typeof window.fetch,
  id: number,
  init?: RequestInit
): Promise<ProformaDetail | null> {
  const cached = proformaDetailCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.response
      .clone()
      .json()
      .catch(() => null);
  }

  const url = new URL(`/api/factory/customer-proformas/${id}`, window.location.origin);
  const response = await originalFetch(url.toString(), withBypassHeaders(url, { ...init, credentials: "include" }));
  if (!response.ok) return null;
  proformaDetailCache.set(id, { response: response.clone(), expiresAt: Date.now() + PROFORMA_CACHE_MS });
  return response
    .clone()
    .json()
    .catch(() => null);
}

async function handleProformaSummary(
  originalFetch: typeof window.fetch,
  url: URL,
  init: RequestInit | undefined
): Promise<Response> {
  const key = url.toString();
  const cached = proformaSummaryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.response.clone();

  const raw = await originalFetch(url.toString(), withBypassHeaders(url, init));
  if (!raw.ok) return raw;
  proformaSummaryCache.set(key, { response: raw.clone(), expiresAt: Date.now() + PROFORMA_CACHE_MS });
  return raw;
}

function updateDailyCacheFromWrite(pathname: string, method: string, response: Response): void {
  if (!response.ok) return;

  if (method === "DELETE") {
    const match = pathname.match(/^\/api\/factory\/daily-bale-scans\/(\d+)$/);
    if (!match) return;
    const id = Number(match[1]);
    for (const [key, entry] of dailyCache) {
      if (!key.startsWith("/api/factory/daily-bale-scans?")) continue;
      dailyCache.set(key, { ...entry, rows: entry.rows.filter((row) => Number(row.id) !== id) });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/factory/daily-bale-scans") {
    void response
      .clone()
      .json()
      .then((row: DailyScanRow | null) => {
        if (!row?.scan_date || !row?.id) return;
        for (const [key, entry] of dailyCache) {
          if (!key.startsWith("/api/factory/daily-bale-scans?")) continue;
          if (!key.includes(`date=${encodeURIComponent(String(row.scan_date))}`)) continue;
          dailyCache.set(key, { ...entry, rows: mergeRows(entry.rows, [row]) });
        }
      })
      .catch(() => undefined);
  }
}

export function installPhase4BandwidthFetch(): void {
  const patchedWindow = window as PatchedWindow;
  if (patchedWindow.__phase4BandwidthFetchInstalled) return;
  patchedWindow.__phase4BandwidthFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveUrl(input);
    if (!url || !url.pathname.startsWith("/api/")) return originalFetch(input, init);

    const headers = requestHeaders(input, init);
    if (headers.has(BYPASS_HEADER)) return originalFetch(input, init);

    const method = requestMethod(input, init);

    if (method !== "GET") {
      const response = await originalFetch(input, init);
      if (PROFORMA_WRITE_PATH.test(url.pathname)) clearProformaCaches();
      updateDailyCacheFromWrite(url.pathname, method, response);
      return response;
    }

    if (DAILY_LIST_PATHS.has(url.pathname) && url.searchParams.has("date")) {
      return handleDailyList(originalFetch, url, init);
    }

    if (url.pathname === PROFORMA_LIST_PATH && url.searchParams.get("profile") === "summary") {
      return handleProformaSummary(originalFetch, url, init);
    }

    const detailMatch = url.pathname.match(PROFORMA_DETAIL_PATH);
    if (detailMatch) {
      const response = await originalFetch(input, init);
      if (response.ok) {
        const id = Number(detailMatch[1]);
        proformaDetailCache.set(id, { response: response.clone(), expiresAt: Date.now() + PROFORMA_CACHE_MS });
      }
      return response;
    }

    return originalFetch(input, init);
  };
}

if (typeof window !== "undefined") installPhase4BandwidthFetch();
