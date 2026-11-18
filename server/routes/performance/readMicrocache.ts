import type { Request, RequestHandler } from "express";
import { checkPOSLocation, requireAuth } from "../../auth";
import { isRealtimeTelemetryWrite } from "../../../shared/realtimeInvalidation";
import { startReadMicrocacheCoordinator, type ReadMicrocacheInvalidation } from "./readMicrocacheCoordinator";
import {
  EMPTY_STATS,
  PAGINATION_HEADER_PATTERN,
  POS_LOCATION_READ_PATH,
  getReadTtlMs,
  isCacheableRead,
  isNonInvalidatingWrite,
  isReadOnlyPost,
  type PendingRead,
  type ReadMicrocacheController,
  type ReadMicrocacheEntry,
  type ReadMicrocacheOptions,
  type ReadMicrocacheStats,
  type ReplayableHeaders,
} from "./readMicrocacheReadLocationIds";
import {
  buildReadMicrocacheKey,
  buildReadScope,
  buildWriteInvalidation,
  entryMatchesInvalidation,
  etagMatches,
  makeEtag,
} from "./buildReadMicrocacheKey";
export { READ_MICROCACHE_PATHS, READ_MICROCACHE_TTL_MS } from "./readMicrocacheReadLocationIds";
export type { ReadMicrocacheStats } from "./readMicrocacheReadLocationIds";
export { buildReadMicrocacheKey } from "./buildReadMicrocacheKey";

let activeStatsReader: () => ReadMicrocacheStats = () => ({ ...EMPTY_STATS });

export function getReadMicrocacheStats(): ReadMicrocacheStats {
  return activeStatsReader();
}

function isReplayableHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "access-control-expose-headers" || PAGINATION_HEADER_PATTERN.test(normalized);
}

function captureReplayableHeaders(res: import("express").Response): ReplayableHeaders {
  const rawHeaders = res.getHeaders?.();
  if (!rawHeaders || typeof rawHeaders !== "object") return {};

  const headers: ReplayableHeaders = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (!isReplayableHeader(name) || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return headers;
}

function replayHeaders(res: import("express").Response, headers: ReplayableHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader?.(name, value);
  }
}

function setCacheHeaders(res: import("express").Response, entry: ReadMicrocacheEntry, state: string): void {
  res.setHeader?.("Cache-Control", "private, no-cache, must-revalidate");
  res.setHeader?.("ETag", entry.etag);
  res.setHeader?.("Vary", "Cookie, Accept-Encoding, X-Client-Date, X-Factory-Catalog-Language");
  res.setHeader?.("X-ERP-Read-Cache", state);
}

function createReadMicrocacheController(options: ReadMicrocacheOptions = {}): ReadMicrocacheController {
  const overrideTtlMs = options.ttlMs;
  const maxEntries = options.maxEntries ?? 128;
  const maxBodyBytes = options.maxBodyBytes ?? 5_000_000;
  const maxCacheBytes = options.maxCacheBytes ?? 64_000_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, ReadMicrocacheEntry>();
  const inFlight = new Map<string, PendingRead>();
  let cachedBytes = 0;
  let writeGeneration = 0;
  const counters = { ...EMPTY_STATS };

  activeStatsReader = () => {
    pruneExpired(now());
    return {
      entries: cache.size,
      bytes: cachedBytes,
      hits: counters.hits,
      misses: counters.misses,
      coalesced: counters.coalesced,
      revalidated: counters.revalidated,
      stores: counters.stores,
      evictions: counters.evictions,
      invalidations: counters.invalidations,
      targetedInvalidations: counters.targetedInvalidations,
      blanketInvalidations: counters.blanketInvalidations,
      invalidatedEntries: counters.invalidatedEntries,
    };
  };

  function deleteEntry(key: string): void {
    const entry = cache.get(key);
    if (!entry) return;
    cachedBytes -= entry.sizeBytes;
    cache.delete(key);
  }

  function invalidateCache(invalidation?: ReadMicrocacheInvalidation): void {
    writeGeneration += 1;
    counters.invalidations += 1;

    const hasScope = Boolean(
      invalidation?.companyIds?.length || invalidation?.topics?.length || invalidation?.locationIds?.length
    );
    let removed = 0;

    if (!hasScope) {
      removed = cache.size;
      cache.clear();
      cachedBytes = 0;
      counters.blanketInvalidations += 1;
    } else {
      counters.targetedInvalidations += 1;
      for (const [key, entry] of cache) {
        if (!entryMatchesInvalidation(entry, invalidation!)) continue;
        deleteEntry(key);
        removed += 1;
      }
    }

    counters.invalidatedEntries += removed;

    // Any write may race a read that began before the mutation committed. Drop
    // all in-flight fill candidates even when stored entries can be invalidated
    // more narrowly; this keeps stale responses from being inserted afterward.
    for (const pending of inFlight.values()) pending.resolve(null);
    inFlight.clear();
  }

  function clearForWrite(): void {
    invalidateCache();
  }

  function pruneExpired(currentTime: number): void {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= currentTime) deleteEntry(key);
    }
  }

  function trimCache(): void {
    while (cache.size > maxEntries || cachedBytes > maxCacheBytes) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      deleteEntry(oldestKey);
      counters.evictions += 1;
    }
  }

  function publishInvalidation(invalidation: ReadMicrocacheInvalidation): void {
    invalidateCache(invalidation);
    void options.publishInvalidation?.(invalidation);
  }

  function sendEntry(
    req: Request,
    res: import("express").Response,
    entry: ReadMicrocacheEntry,
    state: "HIT" | "COALESCED"
  ): void {
    replayHeaders(res, entry.headers);
    setCacheHeaders(res, entry, state);
    if (etagMatches(req.headers["if-none-match"], entry.etag)) {
      counters.revalidated += 1;
      res.setHeader?.("X-ERP-Read-Cache", "REVALIDATED");
      res.status(304).end();
      return;
    }

    if (state === "HIT") counters.hits += 1;
    else counters.coalesced += 1;
    res.status(entry.statusCode).type(entry.contentType).send(entry.body);
  }

  const middleware: RequestHandler = (req, res, next) => {
    const method = req.method.toUpperCase();

    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && !isReadOnlyPost(req)) {
      if (
        isNonInvalidatingWrite(req) ||
        isRealtimeTelemetryWrite(method, req.originalUrl || req.url) ||
        !req.session?.userId
      ) {
        return next();
      }

      const invalidation = buildWriteInvalidation(req);
      let finalized = false;
      res.once?.("finish", () => {
        if (finalized) return;
        finalized = true;
        if (res.statusCode >= 200 && res.statusCode < 300) publishInvalidation(invalidation);
      });
      res.once?.("close", () => {
        if (finalized) return;
        finalized = true;
        publishInvalidation(invalidation);
      });
      return next();
    }

    if (!isCacheableRead(req)) return next();
    if (options.cacheEnabled && !options.cacheEnabled()) return next();

    if (req.headers["x-bypass-request-storm-guard"] !== undefined || req.query?.__refresh === "1") {
      return next();
    }

    const currentTime = now();
    const key = buildReadMicrocacheKey(req);
    const cached = cache.get(key);

    if (cached && cached.expiresAt > currentTime) {
      cache.delete(key);
      cache.set(key, cached);
      sendEntry(req, res, cached, "HIT");
      return;
    }
    if (cached) deleteEntry(key);

    const pending = inFlight.get(key);
    if (pending && pending.generation === writeGeneration) {
      void pending.promise.then(
        (entry) => {
          if (entry && entry.expiresAt > now() && pending.generation === writeGeneration) {
            sendEntry(req, res, entry, "COALESCED");
            return;
          }
          next();
        },
        () => next()
      );
      return;
    }

    counters.misses += 1;
    const generationAtStart = writeGeneration;
    let resolvePending!: (entry: ReadMicrocacheEntry | null) => void;
    const pendingPromise = new Promise<ReadMicrocacheEntry | null>((resolve) => {
      resolvePending = resolve;
    });
    const currentPending: PendingRead = {
      generation: generationAtStart,
      promise: pendingPromise,
      resolve: resolvePending,
    };
    inFlight.set(key, currentPending);

    let settled = false;
    const settle = (entry: ReadMicrocacheEntry | null) => {
      if (settled) return;
      settled = true;
      if (inFlight.get(key) === currentPending) inFlight.delete(key);
      resolvePending(entry);
    };

    res.setHeader?.("X-ERP-Read-Cache", "MISS");
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      let entry: ReadMicrocacheEntry | null = null;
      if (res.statusCode >= 200 && res.statusCode < 300 && generationAtStart === writeGeneration) {
        try {
          const serialized = JSON.stringify(body);
          if (serialized !== undefined) {
            const sizeBytes = Buffer.byteLength(serialized, "utf8");
            if (sizeBytes <= maxBodyBytes) {
              const ttlMs = overrideTtlMs ?? getReadTtlMs(req) ?? 1_000;
              entry = {
                expiresAt: now() + ttlMs,
                statusCode: res.statusCode,
                body: serialized,
                contentType: "application/json",
                etag: makeEtag(serialized),
                sizeBytes,
                headers: captureReplayableHeaders(res),
                scope: buildReadScope(req),
              };
              pruneExpired(now());
              const previous = cache.get(key);
              if (previous) cachedBytes -= previous.sizeBytes;
              cache.set(key, entry);
              cachedBytes += sizeBytes;
              counters.stores += 1;
              trimCache();
              setCacheHeaders(res, entry, "MISS");
            }
          }
        } catch {
          // Non-serializable responses continue normally and are not cached.
        }
      }

      settle(entry);
      if (entry && etagMatches(req.headers["if-none-match"], entry.etag)) {
        counters.revalidated += 1;
        res.setHeader?.("X-ERP-Read-Cache", "REVALIDATED");
        res.status(304).end();
        return res;
      }
      return originalJson(body);
    }) as typeof res.json;

    const settleWithoutEntry = () => settle(null);
    res.once?.("finish", settleWithoutEntry);
    res.once?.("close", settleWithoutEntry);

    return next();
  };

  return {
    middleware,
    invalidate: (invalidation) => {
      if (invalidation) invalidateCache(invalidation);
      else clearForWrite();
    },
  };
}

export function createReadMicrocacheMiddleware(options: ReadMicrocacheOptions = {}): RequestHandler {
  return createReadMicrocacheController(options).middleware;
}

export function registerPerformanceReadMicrocache(app: { use: (handler: RequestHandler) => unknown }): void {
  // Integration suites write fixtures directly through Drizzle/pg, bypassing the
  // HTTP write boundary that invalidates this production cache. Keep those suites
  // deterministic while dedicated readMicrocache unit tests exercise the cache itself.
  if (process.env.NODE_ENV === "test") return;

  let invalidateLocalCache: (invalidation?: ReadMicrocacheInvalidation) => void = () => undefined;
  const coordinator = startReadMicrocacheCoordinator((invalidation) => invalidateLocalCache(invalidation));
  const controller = createReadMicrocacheController({
    cacheEnabled: coordinator.isReady,
    publishInvalidation: coordinator.publishInvalidation,
  });
  invalidateLocalCache = controller.invalidate;

  app.use((req, res, next) => {
    if (!isCacheableRead(req)) return controller.middleware(req, res, next);

    void requireAuth(req, res, () => {
      const locationMatch = POS_LOCATION_READ_PATH.exec(req.path);
      if (!locationMatch) {
        controller.middleware(req, res, next);
        return;
      }

      const originalParams = req.params;
      req.params = { ...originalParams, locationId: locationMatch[1] };
      void checkPOSLocation(req, res, () => {
        req.params = originalParams;
        controller.middleware(req, res, next);
      });
    });
  });
}
