import { isAbortError } from "./abortError";
import {
  assertCompanyReadSnapshot,
  captureCompanyReadSnapshot,
  companyReadCacheIdentity,
  isCompanyOwnedApiRead,
} from "./companyCacheScope";
import {
  BANDWIDTH_INVALIDATION_CHANNEL,
  getBandwidthInvalidationScope,
  registerBandwidthCacheInvalidator,
  shouldClearBandwidthEntry,
  type BandwidthInvalidationMessage,
  type BandwidthInvalidationScope,
} from "./bandwidthInvalidationPolicy";
import { resolveFetchUrl as resolveRequestUrl, fetchRequestMethod as requestMethod } from "./fetchRequestUtils";
import {
  API_GET_TIMEOUT_MS,
  CONDITIONAL_REVALIDATION_MS,
  HIDDEN_TAB_STALE_MS,
  MAX_CACHEABLE_RESPONSE_BYTES,
  acquireGetSlot,
  buildRequestKey,
  bumpWriteGeneration,
  cacheRuleFor,
  generationForScope,
  requestHeaders,
  requestSignal,
  responseCache,
  shouldBypass,
  shouldDeferUntilVisible,
  trimCache,
  type CacheRule,
  type CachedApiResponse,
} from "./requestStormGuardAcquireGetSlot";
const inFlightGets = new Map<string, Promise<Response>>();
const inFlightLifetimes = new Map<string, SharedRequestLifetime>();

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
  if (!key.startsWith(`${companyReadCacheIdentity()}|`)) return;
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

    const readSnapshot = isCompanyOwnedApiRead(url.pathname) ? captureCompanyReadSnapshot() : null;
    if (readSnapshot) assertCompanyReadSnapshot(readSnapshot);
    const headers = requestHeaders(input, init);
    if (shouldBypass(url.pathname, headers, input, init)) return originalFetch(input, init);

    const key = buildRequestKey(url, headers);
    const cached = getCachedResponse(key);
    if (cached) return cached;

    const signal = requestSignal(input, init);

    // An internal abort belongs to whoever cancelled, never to this caller. If a
    // shared request dies for any reason other than this caller's own signal,
    // issue a fresh request rather than reporting a failure nobody asked for.
    const runUnshared = () => {
      if (readSnapshot) assertCompanyReadSnapshot(readSnapshot);
      return originalFetch(input, init);
    };
    const shareOrRetry = async (
      promise: Promise<Response>,
      lifetime: SharedRequestLifetime | undefined
    ): Promise<Response> => {
      try {
        const response = await waitForSharedResponse(promise, signal, lifetime);
        if (readSnapshot) assertCompanyReadSnapshot(readSnapshot);
        return response;
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
      if (readSnapshot) assertCompanyReadSnapshot(readSnapshot);
      const release = await acquireGetSlot(lifetime.controller.signal);
      let requestTimeout: number | undefined;
      try {
        if (readSnapshot) assertCompanyReadSnapshot(readSnapshot);
        // Race the request itself: some browser/proxy fetch wrappers do not
        // settle immediately on abort. The queue slot must still be released.
        const response = await Promise.race([
          originalFetch(input, forwardRequestInit(input, init, lifetime.controller.signal, revalidationEntry?.etag)),
          new Promise<never>((_resolve, reject) => {
            requestTimeout = window.setTimeout(() => {
              lifetime.controller.abort();
              reject(new Error(`Request timed out: ${url.pathname}`));
            }, API_GET_TIMEOUT_MS);
          }),
        ]);
        if (readSnapshot) assertCompanyReadSnapshot(readSnapshot);
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
        if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
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
