import { isAbortError } from "./abortError";
import { factoryCatalogLanguageCacheVariant } from "./factoryCatalogCacheVariant";
import {
  BANDWIDTH_INVALIDATION_CHANNEL,
  getBandwidthInvalidationScope,
  registerBandwidthCacheInvalidator,
  shouldClearBandwidthEntry,
  type BandwidthCacheScope,
  type BandwidthInvalidationMessage,
  type BandwidthInvalidationScope,
} from "./bandwidthInvalidationPolicy";

type HotspotCacheRule = {
  pattern: RegExp;
  ttlMs: number;
  scope: BandwidthCacheScope;
  maxResponseBytes?: number;
};

type CachedHotspotResponse = {
  response: Response;
  expiresAt: number;
  lastUsedAt: number;
  scope: BandwidthCacheScope;
};

const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;
const MAX_CACHE_ENTRIES = 32;

// These routes are the highest recurring API consumers in production
// bandwidth snapshots. Live workflow data uses short snapshots. Reference
// data survives unrelated scans/vouchers and is cleared only by scope,
// settings, access or reference-data writes.
const HOTSPOT_RULES: HotspotCacheRule[] = [
  { pattern: /^\/api\/containers\/otw-items$/, ttlMs: 30_000, scope: "live", maxResponseBytes: 4_000_000 },
  { pattern: /^\/api\/inventory$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/containers$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/location-summary$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/locations$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/locations\/\d+\/inventory$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/location-inventory\/\d+$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/ledger-accounts$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/containers$/, ttlMs: 45_000, scope: "live" },
  { pattern: /^\/api\/git\/containers$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/shipping-container-rows$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/invoice-container-tracking$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/bale-products$/, ttlMs: 2 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/workers$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/workers\/attendance-report$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/monthly-salary-summary$/, ttlMs: 60_000, scope: "live" },
  { pattern: /^\/api\/factory\/production-value-report$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/bale-ledger$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/raw-stock\/available-containers$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/raw-stock$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/raw-stock\/history\/\d+$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/mix-batches$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/ground-scan-items$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/daily-bale-scans(?:\/produced)?$/, ttlMs: 15_000, scope: "live" },
  {
    pattern: /^\/api\/factory\/customer-orders\/\d+\/verification-summary$/,
    ttlMs: 30_000,
    scope: "live",
  },
  { pattern: /^\/api\/factory\/suppliers$/, ttlMs: 2 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/suppliers\/with-balances$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/suppliers\/\d+\/broker-statement$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/factory\/categories$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/accounts\/all$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/accounts\/voucher-sidebar$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/audit-log$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/vouchers\/\d+$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/employees$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/users$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/(?:rental\/)?cash-accounts$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/stock-items\/light$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/customer-price-lists\/\d+$/, ttlMs: 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/daybook$/, ttlMs: 15_000, scope: "live" },
  { pattern: /^\/api\/reports\/stock-movement$/, ttlMs: 30_000, scope: "live" },
  { pattern: /^\/api\/user\/companies$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/user-preferences$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/factory\/label-design-colors$/, ttlMs: 5 * 60_000, scope: "reference" },
  { pattern: /^\/api\/barcode\/[^/]+$/, ttlMs: 10_000, scope: "live" },
];

const responseCache = new Map<string, CachedHotspotResponse>();
const inFlightRequests = new Map<string, Promise<Response>>();
const inFlightLifetimes = new Map<string, SharedRequestLifetime>();
let liveWriteGeneration = 0;
let referenceWriteGeneration = 0;

function generationForScope(scope: BandwidthCacheScope): number {
  return scope === "reference" ? referenceWriteGeneration : liveWriteGeneration;
}

function bumpWriteGeneration(scope: BandwidthInvalidationScope): void {
  liveWriteGeneration += 1;
  if (scope === "all") referenceWriteGeneration += 1;
}

/**
 * Keeps a deduplicated request alive for every caller that is still waiting on
 * it. The network fetch runs on this controller instead of the first caller's
 * signal, so one caller cancelling does not abort a request shared by another
 * caller. The real request is aborted only after every waiter abandons it.
 */
class SharedRequestLifetime {
  readonly controller = new AbortController();
  private waiters = 0;
  private abandoned = 0;
  private disarmed = false;

  acquire(): void {
    this.waiters += 1;
  }

  get isAbandoned(): boolean {
    return this.controller.signal.aborted;
  }

  abandon(): void {
    this.abandoned += 1;
    if (this.disarmed || this.abandoned < this.waiters) return;
    this.disarmed = true;
    this.controller.abort();
  }

  disarm(): void {
    this.disarmed = true;
  }
}

function forwardRequestInit(init: RequestInit | undefined, signal: AbortSignal): RequestInit {
  return { ...(init ?? {}), signal };
}

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

function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null | undefined {
  return init?.signal || (input instanceof Request ? input.signal : undefined);
}

function findRule(pathname: string): HotspotCacheRule | undefined {
  return HOTSPOT_RULES.find(({ pattern }) => pattern.test(pathname));
}

function shouldBypass(input: RequestInfo | URL, init: RequestInit | undefined, headers: Headers): boolean {
  const cacheMode = init?.cache || (input instanceof Request ? input.cache : undefined);
  const cacheControl = headers.get("cache-control") || "";
  return (
    headers.has("range") ||
    headers.has("x-bypass-request-storm-guard") ||
    cacheMode === "no-store" ||
    cacheMode === "reload" ||
    cacheControl.includes("no-store") ||
    cacheControl.includes("no-cache")
  );
}

function buildCacheKey(url: URL, headers: Headers): string {
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
  return `${url.toString()}|${varyHeaders}|${factoryCatalogLanguageCacheVariant(url, headers)}`;
}

function clearCache(scope: BandwidthInvalidationScope = "all"): void {
  if (scope === "all") {
    responseCache.clear();
    return;
  }

  for (const [key, cached] of responseCache) {
    if (shouldClearBandwidthEntry(cached.scope, scope)) responseCache.delete(key);
  }
}

function trimCache(): void {
  if (responseCache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = [...responseCache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  while (responseCache.size > MAX_CACHE_ENTRIES && oldest.length > 0) {
    const entry = oldest.shift();
    if (entry) responseCache.delete(entry[0]);
  }
}

function getCachedResponse(key: string): Response | null {
  const cached = responseCache.get(key);
  if (!cached) return null;
  const now = Date.now();
  if (now > cached.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  cached.lastUsedAt = now;
  return cached.response.clone();
}

function cacheResponse(key: string, response: Response, rule: HotspotCacheRule, generationAtStart: number): void {
  if (!response.ok || generationAtStart !== generationForScope(rule.scope)) return;
  const rawLength = response.headers.get("content-length");
  const responseBytes = rawLength ? Number(rawLength) : 0;
  const maxResponseBytes = rule.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (Number.isFinite(responseBytes) && responseBytes > maxResponseBytes) return;

  const now = Date.now();
  responseCache.set(key, {
    response: response.clone(),
    expiresAt: now + rule.ttlMs,
    lastUsedAt: now,
    scope: rule.scope,
  });
  trimCache();
}

function waitUntilVisible(signal?: AbortSignal | null): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      signal?.removeEventListener("abort", onAbort);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function cloneSharedResponse(
  request: Promise<Response>,
  signal?: AbortSignal | null,
  lifetime?: SharedRequestLifetime
): Promise<Response> {
  if (!signal) return (await request).clone();

  if (signal.aborted) {
    lifetime?.abandon();
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const settle = (abandoned: boolean) => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (abandoned) lifetime?.abandon();
      return true;
    };
    function onAbort() {
      if (settle(true)) reject(new DOMException("The operation was aborted.", "AbortError"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (response) => {
        if (settle(false)) resolve(response.clone());
      },
      (error) => {
        if (settle(false)) reject(error);
      }
    );
  });
}

export function installBandwidthPhase1HotspotGuard(): void {
  if (
    typeof window === "undefined" ||
    (window as unknown as (Window & typeof globalThis) & { __bandwidthPhase1HotspotGuardInstalled: boolean })
      .__bandwidthPhase1HotspotGuardInstalled
  )
    return;
  (
    window as unknown as (Window & typeof globalThis) & { __bandwidthPhase1HotspotGuardInstalled: true }
  ).__bandwidthPhase1HotspotGuardInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const invalidationChannel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BANDWIDTH_INVALIDATION_CHANNEL) : null;

  invalidationChannel?.addEventListener("message", (event: MessageEvent<BandwidthInvalidationMessage>) => {
    if (event.data?.type !== "invalidate") return;
    bumpWriteGeneration(event.data.scope);
    clearCache(event.data.scope);
  });

  const invalidate = (scope: BandwidthInvalidationScope) => {
    bumpWriteGeneration(scope);
    clearCache(scope);
    invalidationChannel?.postMessage({ type: "invalidate", scope } satisfies BandwidthInvalidationMessage);
  };

  // Writes from other sessions reach this tab as a realtime message, never as a
  // local request. Let that path drop these snapshots synchronously, before the
  // refetch it triggers would otherwise be served from them.
  registerBandwidthCacheInvalidator((scope) => {
    bumpWriteGeneration(scope);
    clearCache(scope);
  });

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = requestMethod(input, init);
    const url = resolveUrl(input);
    if (!url || !url.pathname.startsWith("/api/")) return originalFetch(input, init);

    if (method !== "GET") {
      if (method === "HEAD" || method === "OPTIONS") return originalFetch(input, init);
      const invalidationScope = getBandwidthInvalidationScope(url.pathname);
      invalidate(invalidationScope);
      try {
        return await originalFetch(input, init);
      } finally {
        invalidate(invalidationScope);
      }
    }

    const rule = findRule(url.pathname);
    if (!rule) return originalFetch(input, init);

    const headers = requestHeaders(input, init);
    if (shouldBypass(input, init, headers)) return originalFetch(input, init);

    const key = buildCacheKey(url, headers);
    const cached = getCachedResponse(key);
    if (cached) return cached;

    const signal = requestSignal(input, init);
    await waitUntilVisible(signal);

    const runUnshared = () => originalFetch(input, init);
    const shareOrRetry = async (
      promise: Promise<Response>,
      lifetime: SharedRequestLifetime | undefined
    ): Promise<Response> => {
      try {
        return await cloneSharedResponse(promise, signal, lifetime);
      } catch (error) {
        if (signal?.aborted || !isAbortError(error)) throw error;
        return runUnshared();
      }
    };

    const existing = inFlightRequests.get(key);
    const existingLifetime = inFlightLifetimes.get(key);
    if (existing && !existingLifetime?.isAbandoned) {
      existingLifetime?.acquire();
      return shareOrRetry(existing, existingLifetime);
    }
    if (existing) return runUnshared();

    const generationAtStart = generationForScope(rule.scope);
    const lifetime = new SharedRequestLifetime();
    lifetime.acquire();
    const request = (async () => {
      await waitUntilVisible(lifetime.controller.signal);
      const response = await originalFetch(input, forwardRequestInit(init, lifetime.controller.signal));
      lifetime.disarm();
      cacheResponse(key, response, rule, generationAtStart);
      return response;
    })().finally(() => {
      lifetime.disarm();
      inFlightRequests.delete(key);
      inFlightLifetimes.delete(key);
    });

    inFlightRequests.set(key, request);
    inFlightLifetimes.set(key, lifetime);
    return shareOrRetry(request, lifetime);
  };
}

installBandwidthPhase1HotspotGuard();
