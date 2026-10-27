import {
  resolveFetchUrl as resolveUrl,
  fetchRequestMethod as methodOf,
  replaceFetchInputUrl as replaceInputUrl,
  fetchQueryCacheKey,
} from "./fetchRequestUtils";
import { queryClient } from "./queryClient";
import {
  hasLoadedEveryRow,
  isPageOutOfRange,
  readActiveCompanyScope,
  readPageMetadata,
  type PaginationEnvelope,
} from "./progressivePagination";

const ENDPOINT = "/api/factory/daybook";
const ROUTES = new Set(["/factory/daybook", "/properties/daybook"]);
const DEFAULT_LIMIT = 100;
const MAX_ACTION_LIMIT = 250;

export interface PaginatedDaybookEntry {
  id: number;
  companyId: number;
  txDate: string;
  txType: string;
  referenceId: number | null;
  referenceTable: string | null;
  description: string;
  metaJson: string | null;
  currencyCode: string;
  amountCurrency: string;
  fxRateToUsd: string;
  amountUsd: string;
  optional?: boolean;
  createdAt: string;
  createdBy: number | null;
  voucherNumber?: string;
  effectiveDate?: string | null;
}

/**
 * The envelope as it actually arrives. Every field is optional because the
 * endpoint also answers unpaginated callers and older deployments omit the
 * counts; declaring them required made the interceptor read metadata that is
 * not guaranteed to be there.
 */
interface DaybookPage extends PaginationEnvelope {
  items?: PaginatedDaybookEntry[] | null;
  hasNextPage?: boolean | null;
  hasPreviousPage?: boolean | null;
}

interface PaginationMeta {
  key: string;
  page: number;
  limit: number;
  /** Null when the server did not report a row count for this filter. */
  total: number | null;
  /** Null when the server did not report a page count for this filter. */
  totalPages: number | null;
  loadedCount: number;
}

declare global {
  interface Window {
    __erpDaybookPaginationInstalled?: boolean;
  }
}

function actionUrl(baseParams: URLSearchParams, page: number): string {
  const params = new URLSearchParams(baseParams);
  params.set("fullAction", "1");
  params.set("pagination", "1");
  params.set("page", String(page));
  params.set("limit", String(MAX_ACTION_LIMIT));
  return `${ENDPOINT}?${params.toString()}`;
}

/** Loads the complete server-filtered daybook only for explicit export actions. */
export async function fetchAllDaybookEntries(baseParams: URLSearchParams): Promise<PaginatedDaybookEntry[]> {
  const firstResponse = await fetch(actionUrl(baseParams, 1), { credentials: "include" });
  if (!firstResponse.ok) {
    const body = await firstResponse.json().catch(() => ({}));
    throw new Error(body?.message || "Failed to load complete daybook data");
  }

  const first = (await firstResponse.json()) as DaybookPage;
  const entries = Array.isArray(first.items) ? [...first.items] : [];
  const totalPages = Math.max(1, Number(first.totalPages || 1));

  for (let page = 2; page <= totalPages; page += 1) {
    const response = await fetch(actionUrl(baseParams, page), { credentials: "include" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.message || `Failed to load daybook page ${page}`);
    }
    const data = (await response.json()) as DaybookPage;
    if (Array.isArray(data.items)) entries.push(...data.items);
  }

  return entries;
}

if (typeof window !== "undefined" && !window.__erpDaybookPaginationInstalled) {
  window.__erpDaybookPaginationInstalled = true;

  const previousFetch = window.fetch.bind(window);
  const pageCache = new Map<number, DaybookPage>();
  let activeMeta: PaginationMeta | null = null;
  let activeBaseKey = "";
  let pendingPage: number | null = null;
  let loadingMore = false;
  let wasOnRoute = ROUTES.has(window.location.pathname);
  let autoLoadTimer: ReturnType<typeof setTimeout> | null = null;

  function baseKey(url: URL): string {
    // The server identifies the company through a cookie, not the URL.
    // Keep the active company in the key to avoid cross-company cache reuse.
    return fetchQueryCacheKey(
      url,
      ["pagination", "page", "limit", "pageSize", "offset", "fullAction"],
      readActiveCompanyScope()
    );
  }

  function hasDeepLink(): boolean {
    const params = new URLSearchParams(window.location.search);
    return params.has("entryId") || params.has("voucherId");
  }

  function shouldPaginate(input: RequestInfo | URL, init?: RequestInit): { url: URL; key: string } | null {
    if (methodOf(input, init) !== "GET" || !ROUTES.has(window.location.pathname)) return null;
    const url = resolveUrl(input);
    if (!url || url.pathname !== ENDPOINT || url.searchParams.get("fullAction") === "1") return null;
    if (hasDeepLink()) return null;
    return { url, key: baseKey(url) };
  }

  function refetchDaybook(): void {
    queryClient.invalidateQueries({
      // The filter-options query shares this endpoint but must not be refetched
      // for every Daybook page: only the transaction list needs new rows.
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[0] === ENDPOINT &&
        query.queryKey[1] !== "filter-options",
      refetchType: "active",
    });
  }

  function clearProgressState(): void {
    if (autoLoadTimer !== null) clearTimeout(autoLoadTimer);
    autoLoadTimer = null;
    activeMeta = null;
    activeBaseKey = "";
    pendingPage = null;
    loadingMore = false;
    pageCache.clear();
  }

  function highestLoadedPage(): number {
    let highest = 0;
    for (const page of pageCache.keys()) highest = Math.max(highest, page);
    return highest;
  }

  function mergedEntries(): PaginatedDaybookEntry[] {
    const entries: PaginatedDaybookEntry[] = [];
    const seenIds = new Set<number>();
    for (const [, data] of Array.from(pageCache.entries()).sort(([a], [b]) => a - b)) {
      for (const entry of data.items || []) {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        entries.push(entry);
      }
    }
    return entries;
  }

  /** Replaces the envelope body with the merged rows the daybook consumes. */
  function entriesResponse(response: Response, entries: PaginatedDaybookEntry[]): Response {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(entries), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * Continue loading in the background as soon as React Query has consumed the
   * previous response. The visible Daybook stays usable after the first page,
   * with no scrolling or manual "Load more" action required.
   */
  function scheduleNextPage(expectedKey: string): void {
    const meta = activeMeta;
    if (
      !meta ||
      meta.totalPages === null ||
      highestLoadedPage() >= meta.totalPages ||
      hasLoadedEveryRow(meta.total, meta.loadedCount)
    ) {
      return;
    }

    if (autoLoadTimer !== null) clearTimeout(autoLoadTimer);
    autoLoadTimer = setTimeout(() => {
      autoLoadTimer = null;
      // Don't append results from a previous company, filter, deep link or route.
      if (activeBaseKey !== expectedKey || !ROUTES.has(window.location.pathname) || hasDeepLink()) return;
      requestNextPage();
    }, 0);
  }

  function requestNextPage(): void {
    const meta = activeMeta;
    if (!meta || loadingMore) return;
    // Without a reported page count there is no known next page to ask for.
    if (meta.totalPages === null) return;
    const nextPage = highestLoadedPage() + 1;
    if (nextPage <= 1 || nextPage > meta.totalPages) return;
    pendingPage = nextPage;
    loadingMore = true;
    refetchDaybook();
  }

  function handleRouteState(): void {
    const onRoute = ROUTES.has(window.location.pathname);
    if (!onRoute && wasOnRoute) clearProgressState();
    wasOnRoute = onRoute;
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const match = shouldPaginate(input, init);
    if (!match) return previousFetch(input, init);

    if (match.key !== activeBaseKey) {
      clearProgressState();
      activeBaseKey = match.key;
    }

    const requestedPage = pendingPage ?? 1;
    if (requestedPage === 1) pageCache.clear();

    match.url.searchParams.set("pagination", "1");
    match.url.searchParams.set("page", String(requestedPage));
    match.url.searchParams.set("limit", String(DEFAULT_LIMIT));

    let response: Response;
    try {
      response = await previousFetch(replaceInputUrl(input, match.url), init);
    } catch (error) {
      pendingPage = null;
      loadingMore = false;
      throw error;
    }

    if (!response.ok) {
      pendingPage = null;
      loadingMore = false;
      return response;
    }

    try {
      const payload = (await response.clone().json()) as DaybookPage;
      if (!payload || !Array.isArray(payload.items)) {
        pendingPage = null;
        loadingMore = false;
        return response;
      }

      const pageMeta = readPageMetadata(payload, requestedPage, DEFAULT_LIMIT);

      if (isPageOutOfRange(pageMeta)) {
        // The requested page no longer exists — the filter narrowed or rows
        // were removed under us. Clamp to the last real page and refetch, but
        // still answer with the merged row array: callers of this endpoint
        // consume an array, and handing back the raw envelope here would make
        // the daybook read `entries.length` off a plain object.
        pendingPage = pageMeta.totalPages;
        loadingMore = false;
        queueMicrotask(refetchDaybook);
        return entriesResponse(response, mergedEntries());
      }

      pageCache.set(pageMeta.page, payload);
      const entries = mergedEntries();
      pendingPage = null;
      loadingMore = false;
      activeMeta = {
        key: match.key,
        page: highestLoadedPage() || pageMeta.page,
        limit: pageMeta.limit,
        total: pageMeta.total,
        totalPages: pageMeta.totalPages,
        loadedCount: entries.length,
      };
      scheduleNextPage(match.key);

      return entriesResponse(response, entries);
    } catch {
      pendingPage = null;
      loadingMore = false;
      return response;
    }
  };

  window.addEventListener("popstate", handleRouteState);
  const originalPushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    originalPushState(...args);
    queueMicrotask(handleRouteState);
  };
  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    originalReplaceState(...args);
    queueMicrotask(handleRouteState);
  };

  setInterval(handleRouteState, 1000);
}
