import { isAbortError } from "./abortError";
import {
  BANDWIDTH_INVALIDATION_CHANNEL,
  getBandwidthInvalidationScope,
  registerBandwidthCacheInvalidator,
  shouldClearBandwidthEntry,
  type BandwidthCacheScope,
  type BandwidthInvalidationMessage,
  type BandwidthInvalidationScope,
} from "./bandwidthInvalidationPolicy";

type CacheRule = {
  pattern: RegExp;
  ttlMs: number;
  scope: BandwidthCacheScope;
};

type CachedApiResponse = {
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
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHEABLE_RESPONSE_BYTES = 1_500_000;
const HIDDEN_TAB_STALE_MS = 10 * 60_000;
const CONDITIONAL_REVALIDATION_MS = 2 * 60 * 60_000;

const responseCache = new Map<string, CachedApiResponse>();
const inFlightGets = new Map<string, Promise<Response>>();
const inFlightLifetimes = new Map<string, SharedRequestLifetime>();
const getQueue: QueueEntry[] = [];
let activeGets = 0;
let liveWriteGeneration = 0;
let referenceWriteGeneration = 0;

function generationForScope(scope: BandwidthCacheScope): number {
  return scope === "reference" ? referenceWriteGeneration : liveWriteGeneration;
}

function bumpWriteGeneration(scope: BandwidthInvalidationScope): void {
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

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null | undefined {
  return init?.signal || (input instanceof Request ? input.signal : undefined);
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
}

function resolveRequestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input, window.location.origin);
    if (input instanceof URL) return new URL(input.toString(), window.location.origin);
    if (input instanceof Request) return new URL(input.url, window.location.origin);
  } catch {
    return null;
  }
  return null;
}

function cacheRuleFor(pathname: string): CacheRule | undefined {
  return CACHE_RULES.find(({ pattern }) => pattern.test(pathname));
}

function shouldBypass(pathname: string, headers: Headers, input: RequestInfo | URL, init?: RequestInit): boolean {
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

function shouldDeferUntilVisible(pathname: string, ttlMs: number): boolean {
  return ttlMs > 0 || HEAVY_HIDDEN_TAB_PATHS.some((pattern) => pattern.test(pathname));
}

function buildRequestKey(url: URL, headers: Headers): string {
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
  return `${url.toString()}|${varyHeaders}`;
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
  const mayUseStale = typeof document !== "undefined" && document.visibilityState === "hidden";
  const validUntil = mayUseStale ? cached.staleUntil : cached.expiresAt;

  if (now > validUntil) {
    if (now > cached.revalidateUntil) responseCache.delete(key);
    return null;
  }

  cached.lastUsedAt = now;
  return cached.response.clone();
}

function getRevalidationEntry(key: string): CachedApiResponse | null {
  const cached = responseCache.get(key);
  if (!cached) return null;
  const now = Date.now();
  if (!cached.etag || now > cached.revalidateUntil) {
    if (now > cached.revalidateUntil) responseCache.delete(key);
    return null;
  }
  cached.lastUsedAt = now;
  return cached;
}

function refreshRevalidatedEntry(cached: CachedApiResponse, rule: CacheRule): Response {
  const now = Date.now();
  cached.expiresAt = now + rule.ttlMs;
  cached.staleUntil = now + Math.max(rule.ttlMs, HIDDEN_TAB_STALE_MS);
  cached.revalidateUntil = now + Math.max(rule.ttlMs, CONDITIONAL_REVALIDATION_MS);
  cached.lastUsedAt = now;
  return cached.response.clone();
}

function cacheResponse(key: string, response: Response, rule: CacheRule, generationAtStart: number): void {
  if (rule.ttlMs <= 0 || !response.ok || generationAtStart !== generationForScope(rule.scope)) return;

  const rawLength = response.headers.get("content-length");
  const responseBytes = rawLength ? Number(rawLength) : 0;
  if (Number.isFinite(responseBytes) && responseBytes > MAX_CACHEABLE_RESPONSE_BYTES) return;

  const now = Date.now();
  responseCache.set(key, {
    response: response.clone(),
    expiresAt: now + rule.ttlMs,
    staleUntil: now + Math.max(rule.ttlMs, HIDDEN_TAB_STALE_MS),
    revalidateUntil: now + Math.max(rule.ttlMs, CONDITIONAL_REVALIDATION_MS),
    lastUsedAt: now,
    etag: response.headers.get("etag"),
    scope: rule.scope,
  });
  trimCache();
}

function clearReadCache(scope: BandwidthInvalidationScope = "all"): void {
  const now = Date.now();
  for (const [key, cached] of responseCache) {
    if (scope !== "all" && !shouldClearBandwidthEntry(cached.scope, scope)) continue;
    if (!cached.etag || now > cached.revalidateUntil) {
      responseCache.delete(key);
      continue;
    }
    // Keep the representation only as a validator. The next read must contact
    // the authenticated server and can reuse the body solely after a 304.
    cached.expiresAt = 0;
    cached.staleUntil = 0;
    cached.lastUsedAt = now;
  }
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

function acquireGetSlot(signal?: AbortSignal | null): Promise<() => void> {
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

/**
 * Tracks how many callers still want a shared in-flight GET. The underlying
 * fetch runs on a controller of our own rather than on the first caller's
 * signal: otherwise a caller that cancels (a React Query key change, a company
 * switch, an unmount) aborts the network request that later, still-live callers
 * are waiting on, and they receive an AbortError for a request they never
 * cancelled. The real request is aborted only when every caller has abandoned
 * it, and never once a response exists — aborting after the headers arrive
 * tears down the body stream the caller is about to read.

 */
class SharedRequestLifetime {
  readonly controller = new AbortController();
  private waiters = 0;
  private abandoned = 0;
  private disarmed = false;

  acquire(): void {
    this.waiters += 1;
  }

  /** True once the shared request has been abandoned; it can no longer be joined. */
  get isAbandoned(): boolean {
    return this.controller.signal.aborted;
  }

  /** A caller cancelled. Only a fully abandoned request is aborted. */
  abandon(): void {
    this.abandoned += 1;
    if (this.disarmed || this.abandoned < this.waiters) return;
    this.disarmed = true;
    this.controller.abort();
  }

  /** The request produced a response (or failed on its own); never abort it now. */
  disarm(): void {
    this.disarmed = true;
  }
}

function forwardRequestInit(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
  etag?: string | null
): RequestInit {
  const headers = requestHeaders(input, init);
  if (etag && !headers.has("if-none-match")) headers.set("If-None-Match", etag);
  return { ...(init ?? {}), headers, signal };
}

async function waitForSharedResponse(
  promise: Promise<Response>,
  signal?: AbortSignal | null,
  lifetime?: SharedRequestLifetime
): Promise<Response> {
  if (!signal) return (await promise).clone();

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

    promise.then(
      (response) => {
        if (settle(false)) resolve(response.clone());
      },
      (error) => {
        if (settle(false)) reject(error);
      }
    );
  });
}

export function installRequestStormGuard(): void {
  if (
    typeof window === "undefined" ||
    (window as unknown as (Window & typeof globalThis) & { __requestStormGuardInstalled: boolean })
      .__requestStormGuardInstalled
  )
    return;
  (
    window as unknown as (Window & typeof globalThis) & { __requestStormGuardInstalled: true }
  ).__requestStormGuardInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const invalidationChannel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BANDWIDTH_INVALIDATION_CHANNEL) : null;

  invalidationChannel?.addEventListener("message", (event: MessageEvent<BandwidthInvalidationMessage>) => {
    if (event.data?.type !== "invalidate") return;
    bumpWriteGeneration(event.data.scope);
    clearReadCache(event.data.scope);
  });

  const invalidate = (scope: BandwidthInvalidationScope) => {
    bumpWriteGeneration(scope);
    clearReadCache(scope);
    invalidationChannel?.postMessage({ type: "invalidate", scope } satisfies BandwidthInvalidationMessage);
  };

  // Writes from other sessions reach this tab as a realtime message, never as a
  // local request. Let that path drop these snapshots synchronously, before the
  // refetch it triggers would otherwise be served from them.
  registerBandwidthCacheInvalidator((scope) => {
    bumpWriteGeneration(scope);
    clearReadCache(scope);
  });

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = requestMethod(input, init);
    const url = resolveRequestUrl(input);

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

    const headers = requestHeaders(input, init);
    if (shouldBypass(url.pathname, headers, input, init)) return originalFetch(input, init);

    const key = buildRequestKey(url, headers);
    const cached = getCachedResponse(key);
    if (cached) return cached;

    const signal = requestSignal(input, init);

    // An internal abort belongs to whoever cancelled, never to this caller. If a
    // shared request dies for any reason other than this caller's own signal,
    // issue a fresh request rather than reporting a failure nobody asked for.
    const runUnshared = () => originalFetch(input, init);
    const shareOrRetry = async (
      promise: Promise<Response>,
      lifetime: SharedRequestLifetime | undefined
    ): Promise<Response> => {
      try {
        return await waitForSharedResponse(promise, signal, lifetime);
      } catch (error) {
        if (signal?.aborted || !isAbortError(error)) throw error;
        return runUnshared();
      }
    };

    const existing = inFlightGets.get(key);
    const existingLifetime = inFlightLifetimes.get(key);
    // A request that has already been abandoned is doomed: its controller is
    // aborted and only the rejection is still in flight. Joining it would hand
    // this caller that abort, so start over instead.
    if (existing && !existingLifetime?.isAbandoned) {
      existingLifetime?.acquire();
      return shareOrRetry(existing, existingLifetime);
    }
    if (existing) return runUnshared();

    const rule = cacheRuleFor(url.pathname);
    const ttlMs = rule?.ttlMs ?? 0;
    const revalidationEntry = rule ? getRevalidationEntry(key) : null;
    const lifetime = new SharedRequestLifetime();
    lifetime.acquire();
    const generationAtStart = rule ? generationForScope(rule.scope) : 0;
    const requestPromise = (async () => {
      if (shouldDeferUntilVisible(url.pathname, ttlMs)) await waitUntilVisible(lifetime.controller.signal);
      const release = await acquireGetSlot(lifetime.controller.signal);
      try {
        const response = await originalFetch(
          input,
          forwardRequestInit(input, init, lifetime.controller.signal, revalidationEntry?.etag)
        );
        // The response exists; its body is still unread. Any later abort would
        // tear that stream down under the caller, so disarm before handing over.
        lifetime.disarm();
        if (response.status === 304 && rule && revalidationEntry) {
          const cached = refreshRevalidatedEntry(revalidationEntry, rule);
          if (generationAtStart !== generationForScope(rule.scope)) {
            revalidationEntry.expiresAt = 0;
            revalidationEntry.staleUntil = 0;
          }
          return cached;
        }
        if (rule) cacheResponse(key, response, rule, generationAtStart);

        return response;
      } finally {
        release();
      }
    })().finally(() => {
      lifetime.disarm();
      inFlightGets.delete(key);
      inFlightLifetimes.delete(key);
    });

    inFlightGets.set(key, requestPromise);
    inFlightLifetimes.set(key, lifetime);
    return shareOrRetry(requestPromise, lifetime);
  };
}

installRequestStormGuard();
