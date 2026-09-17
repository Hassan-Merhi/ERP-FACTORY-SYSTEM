import { queryClient } from "./queryClient";

const ENDPOINT = "/api/factory/daybook";
const ROUTES = new Set(["/factory/daybook", "/properties/daybook"]);
const DEFAULT_LIMIT = 100;
const MAX_ACTION_LIMIT = 250;
const AUTOLOAD_THRESHOLD_PX = 700;

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

interface DaybookPage {
  items: PaginatedDaybookEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

interface PaginationMeta {
  key: string;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
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
  let progressRoot: HTMLDivElement | null = null;

  function resolveUrl(input: RequestInfo | URL): URL | null {
    try {
      if (typeof input === "string") return new URL(input, window.location.origin);
      if (input instanceof URL) return new URL(input.toString());
      if (input instanceof Request) return new URL(input.url, window.location.origin);
    } catch {
      return null;
    }
    return null;
  }

  function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
    return String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  }

  function replaceInputUrl(input: RequestInfo | URL, url: URL): RequestInfo | URL {
    if (input instanceof Request) return new Request(url.toString(), input);
    if (input instanceof URL) return url;
    if (url.origin === window.location.origin) return `${url.pathname}${url.search}${url.hash}`;
    return url.toString();
  }

  function baseKey(url: URL): string {
    const params = new URLSearchParams(url.searchParams);
    for (const key of ["pagination", "page", "limit", "pageSize", "offset", "fullAction"]) params.delete(key);
    params.sort();
    return `${url.pathname}?${params.toString()}`;
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
      predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] === ENDPOINT,
      refetchType: "active",
    });
  }

  function clearProgressState(): void {
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

  function ensureProgress(): HTMLDivElement {
    if (progressRoot?.isConnected) return progressRoot;
    progressRoot = document.createElement("div");
    progressRoot.id = "erp-factory-daybook-progress";
    progressRoot.dataset.testid = "factory-daybook-progress";
    progressRoot.setAttribute("role", "status");
    progressRoot.setAttribute("aria-live", "polite");
    Object.assign(progressRoot.style, {
      position: "fixed",
      left: "50%",
      bottom: "18px",
      transform: "translateX(-50%)",
      zIndex: "1000",
      display: "none",
      alignItems: "center",
      padding: "7px 10px",
      border: "1px solid hsl(var(--border))",
      borderRadius: "10px",
      background: "hsl(var(--background))",
      color: "hsl(var(--foreground))",
      boxShadow: "0 8px 28px rgba(0, 0, 0, 0.14)",
      fontSize: "12px",
      fontWeight: "600",
      pointerEvents: "none",
      whiteSpace: "nowrap",
    });
    document.body.appendChild(progressRoot);
    return progressRoot;
  }

  function renderProgress(): void {
    const root = ensureProgress();
    // Held in a local and tested inline so the null check narrows: through a
    // separate `shouldHide` boolean TypeScript cannot see that activeMeta is
    // non-null past the early return.
    const meta = activeMeta;
    if (
      !meta ||
      !ROUTES.has(window.location.pathname) ||
      hasDeepLink() ||
      meta.totalPages <= 1 ||
      meta.loadedCount >= meta.total
    ) {
      root.style.display = "none";
      return;
    }

    root.style.display = "flex";
    root.textContent = loadingMore
      ? `Loading more… ${meta.loadedCount} of ${meta.total} transactions loaded`
      : `${meta.loadedCount} of ${meta.total} transactions loaded · scroll to load more`;
  }

  function requestNextPage(): void {
    if (!activeMeta || loadingMore) return;
    const nextPage = highestLoadedPage() + 1;
    if (nextPage <= 1 || nextPage > activeMeta.totalPages) return;
    pendingPage = nextPage;
    loadingMore = true;
    renderProgress();
    refetchDaybook();
  }

  function scrollHost(event: Event): HTMLElement | null {
    if (event.target instanceof HTMLElement) return event.target;
    const scrolling = document.scrollingElement;
    return scrolling instanceof HTMLElement ? scrolling : null;
  }

  function handleProgressiveScroll(event: Event): void {
    if (!activeMeta || loadingMore || activeMeta.loadedCount >= activeMeta.total) return;
    const host = scrollHost(event);
    if (!host) return;

    const isDocumentHost =
      host === document.scrollingElement || host === document.documentElement || host === document.body;
    if (!isDocumentHost && host.scrollHeight < 600) return;

    const remaining = host.scrollHeight - host.scrollTop - host.clientHeight;
    if (remaining <= AUTOLOAD_THRESHOLD_PX) requestNextPage();
  }

  function handleRouteState(): void {
    const onRoute = ROUTES.has(window.location.pathname);
    if (!onRoute && wasOnRoute) clearProgressState();
    wasOnRoute = onRoute;
    renderProgress();
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
      renderProgress();
      throw error;
    }

    if (!response.ok) {
      pendingPage = null;
      loadingMore = false;
      renderProgress();
      return response;
    }

    try {
      const payload = (await response.clone().json()) as DaybookPage;
      if (!payload || !Array.isArray(payload.items)) {
        pendingPage = null;
        loadingMore = false;
        return response;
      }

      const total = Number(payload.total || 0);
      const totalPages = Number(payload.totalPages || 0);
      const serverPage = Number(payload.page || requestedPage) || requestedPage;
      const limit = Number(payload.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT;

      if (totalPages > 0 && serverPage > totalPages) {
        pendingPage = totalPages;
        loadingMore = false;
        queueMicrotask(refetchDaybook);
        return response;
      }

      pageCache.set(serverPage, payload);
      const entries = mergedEntries();
      pendingPage = null;
      loadingMore = false;
      activeMeta = {
        key: match.key,
        page: highestLoadedPage() || serverPage,
        limit,
        total,
        totalPages,
        loadedCount: entries.length,
      };
      renderProgress();

      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(entries), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      pendingPage = null;
      loadingMore = false;
      renderProgress();
      return response;
    }
  };

  document.addEventListener("scroll", handleProgressiveScroll, true);
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
