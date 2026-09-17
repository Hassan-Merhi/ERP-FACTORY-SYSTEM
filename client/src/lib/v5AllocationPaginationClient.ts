import { queryClient } from "./queryClient";

const ENDPOINT = "/api/factory/v5/stock-allocation";
const ROUTE = "/factory/stock-allocation-v5";
const DEFAULT_LIMIT = 50;
const MAX_ACTION_LIMIT = 250;
const AUTOLOAD_THRESHOLD_PX = 600;

export interface V5AllocationRow {
  articleCode: string;
  productName: string;
  stockAvailable: number;
  totalLoaded: number;
  expectedToLoad: number;
  freeToPromise: number;
  totalKg: number;
  proformaDetails: Array<{
    proformaId: number;
    proformaName: string;
    customerId: number;
    customerName: string;
    lineQty: number;
    containerCount: number;
    totalExpected: number;
    containers: Array<{
      orderId: number;
      containerName: string;
      status: string;
      expectedQty: number;
      loadedQty: number;
      remainingQty: number;
    }>;
  }>;
  isGarbageOrWipers?: boolean;
}

export interface V5AllocationData {
  rows: V5AllocationRow[];
  totals: {
    stockAvailable: number;
    totalLoaded: number;
    expectedToLoad: number;
    freeToPromise: number;
    totalKg: number;
    shortageCount: number;
  };
  productNames: Record<string, string>;
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
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
    __erpV5AllocationPaginationInstalled?: boolean;
  }
}

function buildActionUrl(baseParams: URLSearchParams, page: number): string {
  const params = new URLSearchParams(baseParams);
  params.set("fullAction", "1");
  params.set("pagination", "1");
  params.set("page", String(page));
  params.set("limit", String(MAX_ACTION_LIMIT));
  return `${ENDPOINT}?${params.toString()}`;
}

/**
 * Fetches every server page for explicit full-data actions such as export and
 * proforma drawers. Normal table browsing must never call this helper.
 */
export async function fetchAllV5AllocationData(baseParams = new URLSearchParams()): Promise<V5AllocationData> {
  const firstResponse = await fetch(buildActionUrl(baseParams, 1), { credentials: "include" });
  if (!firstResponse.ok) {
    const body = await firstResponse.json().catch(() => ({}));
    throw new Error(body?.message || "Failed to load complete stock allocation data");
  }

  const first = (await firstResponse.json()) as V5AllocationData;
  const rows = Array.isArray(first.rows) ? [...first.rows] : [];
  const productNames = { ...(first.productNames || {}) };
  const totalPages = Math.max(1, Number(first.totalPages || 1));

  for (let page = 2; page <= totalPages; page += 1) {
    const response = await fetch(buildActionUrl(baseParams, page), { credentials: "include" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.message || `Failed to load stock allocation page ${page}`);
    }
    const data = (await response.json()) as V5AllocationData;
    if (Array.isArray(data.rows)) rows.push(...data.rows);
    Object.assign(productNames, data.productNames || {});
  }

  return {
    ...first,
    rows,
    productNames,
    total: rows.length,
    page: 1,
    limit: rows.length,
    totalPages: rows.length > 0 ? 1 : 0,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

if (typeof window !== "undefined" && !window.__erpV5AllocationPaginationInstalled) {
  window.__erpV5AllocationPaginationInstalled = true;

  const previousFetch = window.fetch.bind(window);
  const pageCache = new Map<number, V5AllocationData>();
  let activeMeta: PaginationMeta | null = null;
  let activeBaseKey = "";
  let pendingPage: number | null = null;
  let loadingMore = false;
  let negativeOnlyMode = false;
  let wasOnRoute = window.location.pathname === ROUTE;
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

  function hasFocusedDeepLink(): boolean {
    const params = new URLSearchParams(window.location.search);
    return params.has("proformaId") || params.get("openEdit") === "true";
  }

  function shouldPaginate(input: RequestInfo | URL, init?: RequestInit): { url: URL; key: string } | null {
    if (methodOf(input, init) !== "GET" || window.location.pathname !== ROUTE) return null;
    const url = resolveUrl(input);
    if (!url || url.pathname !== ENDPOINT || url.searchParams.get("fullAction") === "1") return null;

    // Rare workflows that require the complete model deliberately keep the
    // legacy response: focused deep links and the global Negative Only mode.
    if (negativeOnlyMode || hasFocusedDeepLink()) return null;
    return { url, key: baseKey(url) };
  }

  function refetchAllocation(): void {
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

  function mergeCachedPages(latest: V5AllocationData): V5AllocationData {
    const rows: V5AllocationRow[] = [];
    const seenCodes = new Set<string>();
    const productNames: Record<string, string> = {};

    for (const [, data] of Array.from(pageCache.entries()).sort(([a], [b]) => a - b)) {
      Object.assign(productNames, data.productNames || {});
      for (const row of data.rows || []) {
        if (seenCodes.has(row.articleCode)) continue;
        seenCodes.add(row.articleCode);
        rows.push(row);
      }
    }

    const highest = highestLoadedPage();
    const totalPages = Math.max(0, Number(latest.totalPages || 0));
    return {
      ...latest,
      rows,
      productNames,
      page: highest || 1,
      limit: DEFAULT_LIMIT,
      hasPreviousPage: false,
      hasNextPage: totalPages > 0 && highest < totalPages,
    };
  }

  function ensureProgress(): HTMLDivElement {
    if (progressRoot?.isConnected) return progressRoot;
    progressRoot = document.createElement("div");
    progressRoot.id = "erp-v5-allocation-progress";
    progressRoot.dataset.testid = "v5-allocation-progress";
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
    const shouldHide =
      !activeMeta ||
      window.location.pathname !== ROUTE ||
      negativeOnlyMode ||
      hasFocusedDeepLink() ||
      activeMeta.totalPages <= 1 ||
      activeMeta.loadedCount >= activeMeta.total;

    if (shouldHide) {
      root.style.display = "none";
      return;
    }

    root.style.display = "flex";
    root.textContent = loadingMore
      ? `Loading more… ${activeMeta.loadedCount} of ${activeMeta.total} products loaded`
      : `${activeMeta.loadedCount} of ${activeMeta.total} products loaded · scroll to load more`;
  }

  function requestNextPage(): void {
    if (!activeMeta || loadingMore) return;
    const nextPage = highestLoadedPage() + 1;
    if (nextPage <= 1 || nextPage > activeMeta.totalPages) return;
    pendingPage = nextPage;
    loadingMore = true;
    renderProgress();
    refetchAllocation();
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

    const isDocumentHost = host === document.scrollingElement || host === document.documentElement || host === document.body;
    if (!isDocumentHost && host.scrollHeight < 600) return;

    const remaining = host.scrollHeight - host.scrollTop - host.clientHeight;
    if (remaining <= AUTOLOAD_THRESHOLD_PX) requestNextPage();
  }

  function handleRouteState(): void {
    const onRoute = window.location.pathname === ROUTE;
    if (!onRoute && wasOnRoute) {
      negativeOnlyMode = false;
      clearProgressState();
    }
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
      const payload = (await response.clone().json()) as V5AllocationData;
      if (!payload || !Array.isArray(payload.rows) || payload.total === undefined) {
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
        queueMicrotask(refetchAllocation);
        return response;
      }

      pageCache.set(serverPage, payload);
      const merged = mergeCachedPages(payload);
      pendingPage = null;
      loadingMore = false;
      activeMeta = {
        key: match.key,
        page: highestLoadedPage() || serverPage,
        limit,
        total,
        totalPages,
        loadedCount: merged.rows.length,
      };
      renderProgress();

      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(merged), {
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

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-testid]") : null;
    if (target?.getAttribute("data-testid") !== "button-v5-toggle-negative-only") return;
    negativeOnlyMode = !negativeOnlyMode;
    clearProgressState();
    renderProgress();
    queueMicrotask(refetchAllocation);
  });

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
