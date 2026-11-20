// Extracted from ./requestStormGuard.ts to keep that module under the source-size cap.
import { factoryCatalogLanguageCacheVariant } from "./factoryCatalogCacheVariant";
import { companyReadCacheIdentity } from "./companyCacheScope";
import type { BandwidthCacheScope, BandwidthInvalidationScope } from "./bandwidthInvalidationPolicy";

export type CacheRule = {
  pattern: RegExp;
  ttlMs: number;
  scope: BandwidthCacheScope;
};

export type CachedApiResponse = {
  response: Response;
  expiresAt: number;
  staleUntil: number;
  revalidateUntil: number;
  lastUsedAt: number;
  etag: string | null;
  scope: BandwidthCacheScope;
};

type QueueEntry = {
  resolve: (release: () => void) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal | null;
  onAbort?: () => void;
};

const MAX_CONCURRENT_API_GETS = 6;

// Bound occupied slots so one hung backend request cannot starve every page.
export const API_GET_TIMEOUT_MS = 45_000;

const MAX_CACHE_ENTRIES = 32;

export const MAX_CACHEABLE_RESPONSE_BYTES = 1_500_000;

export const HIDDEN_TAB_STALE_MS = 10 * 60_000;

export const CONDITIONAL_REVALIDATION_MS = 2 * 60 * 60_000;

export const responseCache = new Map<string, CachedApiResponse>();

const getQueue: QueueEntry[] = [];

let activeGets = 0;

let liveWriteGeneration = 0;

let referenceWriteGeneration = 0;

export function generationForScope(scope: BandwidthCacheScope): number {
  return scope === "reference" ? referenceWriteGeneration : liveWriteGeneration;
}

export function bumpWriteGeneration(scope: BandwidthInvalidationScope): void {
  liveWriteGeneration += 1;
  if (scope === "all") referenceWriteGeneration += 1;
}

const BYPASS_PATHS = [
  /\/export(?:\/|$)/i,
  /\/download(?:\/|$)/i,
  /\/attachment(?:\/|$)/i,
  /\/documents?(?:\/|$)/i,
  /\/pdf(?:\/|$)/i,
  /\/xlsx(?:\/|$)/i,
  /\/health(?:\/|$)/i,
  /^\/api\/boot$/i,
  /^\/api\/csrf-token$/i,
];

const CACHE_RULES: readonly CacheRule[] = [
  { pattern: /^\/api\/factory\/customer-orders\/\d+$/, ttlMs: 45_000, scope: "live" },
  { pattern: /^\/api\/factory\/customer-orders\/\d+\/bale-removals$/, ttlMs: 5 * 60_000, scope: "live" },
  { pattern: /^\/api\/factory\/bale-stock-count$/, ttlMs: 60_000, scope: "live" },
  { pattern: /^\/api\/factory\/customer-orders$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/customer-proformas$/, ttlMs: 2 * 60_000, scope: "live" },
  { pattern: /^\/api\/factory\/customers$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/suppliers$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/bale-products$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/categories$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/workers$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/employees$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/cash-accounts$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/worker-categories$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/my-access$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/settings$/, ttlMs: 15 * 60_000, scope: "reference" },
  { pattern: /^\/api\/company-settings$/, ttlMs: 15 * 60_000, scope: "reference" },
  { pattern: /^\/api\/user\/preferences$/, ttlMs: 15 * 60_000, scope: "reference" },
  { pattern: /^\/api\/my-erp-pages$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/user\/companies$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/ledger-accounts(?:\/parent-groups)?$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/locations$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/suppliers$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/customers$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/employees$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/bank-accounts$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/fixed-assets$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/stock-groups$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/stock-categories$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/stock-grades$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/stock-items\/(?:light|all-code-aliases)$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/worker-groups\/with-members$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/employee-groups$/, ttlMs: 30 * 60_000, scope: "reference" },
  { pattern: /^\/api\/companies\/\d+$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/chat\/unread-count$/, ttlMs: 15_000, scope: "live" },
  { pattern: /^\/api\/chatbot\/status$/, ttlMs: 2 * 60_000, scope: "reference" },
];

const HEAVY_HIDDEN_TAB_PATHS = [
  /^\/api\/factory\/raw-stock$/,
  /^\/api\/factory\/net-position$/,
  /^\/api\/factory\/bale-ledger$/,
  /^\/api\/factory\/customer-proformas$/,
  /^\/api\/factory\/customer-orders(?:\/|$)/,
  /^\/api\/factory\/bale-stock-count$/,
];

export function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null | undefined {
  return init?.signal || (input instanceof Request ? input.signal : undefined);
}

export function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
}

export function cacheRuleFor(pathname: string): CacheRule | undefined {
  return CACHE_RULES.find(({ pattern }) => pattern.test(pathname));
}

export function shouldBypass(
  pathname: string,
  headers: Headers,
  input: RequestInfo | URL,
  init?: RequestInit
): boolean {
  const cacheMode = init?.cache || (input instanceof Request ? input.cache : undefined);
  const cacheControl = headers.get("cache-control") || "";
  return (
    headers.has("range") ||
    headers.has("x-bypass-request-storm-guard") ||
    cacheMode === "no-store" ||
    cacheMode === "reload" ||
    cacheControl.includes("no-store") ||
    BYPASS_PATHS.some((pattern) => pattern.test(pathname))
  );
}

export function shouldDeferUntilVisible(pathname: string, ttlMs: number): boolean {
  return ttlMs > 0 || HEAVY_HIDDEN_TAB_PATHS.some((pattern) => pattern.test(pathname));
}

export function buildRequestKey(url: URL, headers: Headers): string {
  const varyHeaders = [
    "accept",
    "x-client-date",
    "x-company-id",
    "x-factory-company-id",
    "x-selected-company-id",
    "x-erp-company-id",
  ]
    .map((name) => `${name}=${headers.get(name) || ""}`)
    .join("|");
  return `${companyReadCacheIdentity()}|${url.toString()}|${varyHeaders}|${factoryCatalogLanguageCacheVariant(url, headers)}`;
}

export function trimCache(): void {
  if (responseCache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = [...responseCache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  while (responseCache.size > MAX_CACHE_ENTRIES && oldest.length > 0) {
    const entry = oldest.shift();
    if (entry) responseCache.delete(entry[0]);
  }
}

function drainQueue(): void {
  while (activeGets < MAX_CONCURRENT_API_GETS && getQueue.length > 0) {
    const entry = getQueue.shift();
    if (!entry) return;

    if (entry.signal?.aborted) {
      entry.reject(new DOMException("The operation was aborted.", "AbortError"));
      continue;
    }

    if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
    activeGets += 1;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      activeGets = Math.max(0, activeGets - 1);
      drainQueue();
    });
  }
}

export function acquireGetSlot(signal?: AbortSignal | null): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }

  if (activeGets < MAX_CONCURRENT_API_GETS) {
    activeGets += 1;
    let released = false;
    return Promise.resolve(() => {
      if (released) return;
      released = true;
      activeGets = Math.max(0, activeGets - 1);
      drainQueue();
    });
  }

  return new Promise<() => void>((resolve, reject) => {
    const entry: QueueEntry = { resolve, reject, signal };
    if (signal) {
      entry.onAbort = () => {
        const index = getQueue.indexOf(entry);
        if (index >= 0) getQueue.splice(index, 1);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    getQueue.push(entry);
  });
}
