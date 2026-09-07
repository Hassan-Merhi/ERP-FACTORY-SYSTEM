import { createHash } from "crypto";
import type { Request, RequestHandler } from "express";
import { checkPOSLocation, requireAuth } from "../../auth";
import { startReadMicrocacheCoordinator } from "./readMicrocacheCoordinator";

export const READ_MICROCACHE_TTL_MS = new Map<string, number>([
  ["/api/sales-report", 120_000],
  ["/api/location-summary", 60_000],
  ["/api/reports/stock-movement", 60_000],
  ["/api/reports/containers", 60_000],
  ["/api/reports/opening-stock-summary", 60_000],
  ["/api/factory/daybook", 10_000],
  ["/api/daybook", 15_000],
  ["/api/accounts/all", 30_000],
  ["/api/accounts/voucher-sidebar", 30_000],
  ["/api/stats/monthly-data", 30_000],
  ["/api/dashboard/sales-report-all", 30_000],
  ["/api/factory/payrolls", 120_000],
  ["/api/factory/payrolls/preview", 120_000],
  ["/api/payroll/worker-payments-summary", 60_000],
  ["/api/factory/customer-proformas", 60_000],
  ["/api/factory/suppliers/with-balances", 15_000],
  ["/api/factory/raw-stock", 10_000],
  ["/api/factory/raw-stock/available-containers", 30_000],
  ["/api/factory/mix-batches", 10_000],
  ["/api/factory/bale-ledger", 10_000],
  ["/api/factory/production-value-report", 10_000],
  ["/api/factory/containers", 30_000],
  ["/api/factory/bale-products", 300_000],
  ["/api/factory/workers", 300_000],
  ["/api/factory/employees", 300_000],
  ["/api/factory/cash-accounts", 300_000],
  ["/api/factory/settings", 300_000],
  ["/api/factory/my-access", 300_000],
  ["/api/factory/customers", 300_000],
  ["/api/factory/suppliers", 300_000],
  ["/api/factory/worker-categories", 300_000],
  ["/api/factory/daily-bale-scans", 30_000],
  ["/api/factory/daily-bale-scans/produced", 30_000],
  ["/api/factory/attendance", 30_000],
  ["/api/factory/bales/stock-entry-history", 30_000],
  ["/api/ledger-accounts", 300_000],
  ["/api/ledger-accounts/parent-groups", 300_000],
  ["/api/company-settings", 300_000],
  ["/api/user/preferences", 300_000],
  ["/api/customers", 300_000],
  ["/api/bank-accounts", 300_000],
  ["/api/fixed-assets", 300_000],
  ["/api/stock-categories", 300_000],
  ["/api/stock-grades", 300_000],
  ["/api/stock-items", 300_000],
  ["/api/stock-items/light", 300_000],
  ["/api/stock-items/all-code-aliases", 300_000],
  ["/api/locations", 300_000],
  ["/api/payroll/bonus-locations", 300_000],
  ["/api/stock-groups", 300_000],
  ["/api/suppliers", 300_000],
  ["/api/employees", 300_000],
  ["/api/worker-groups/with-members", 300_000],
  ["/api/employee-groups", 300_000],
  ["/api/user/companies", 300_000],
  ["/api/my-erp-pages", 300_000],
  ["/api/pos/last-sold-prices", 30_000],
  ["/api/containers/active", 30_000],
  ["/api/stock-transfers", 30_000],
]);

export const READ_MICROCACHE_PATHS = new Set(READ_MICROCACHE_TTL_MS.keys());

interface DynamicReadPolicy {
  path: RegExp;
  ttlMs: number;
}

const DYNAMIC_READ_MICROCACHE_POLICIES: readonly DynamicReadPolicy[] = [
  { path: /^\/api\/locations\/\d+\/inventory\/?$/, ttlMs: 30_000 },
  { path: /^\/api\/accounts\/ledger\/\d+\/transactions\/?$/, ttlMs: 30_000 },
  { path: /^\/api\/factory\/customer-orders\/\d+\/?$/, ttlMs: 60_000 },
  { path: /^\/api\/factory\/customer-orders\/\d+\/verification-summary\/?$/, ttlMs: 60_000 },
  { path: /^\/api\/factory\/workers\/attendance-report\/?$/, ttlMs: 30_000 },
  { path: /^\/api\/vouchers\/\d+\/?$/, ttlMs: 30_000 },
];

const NON_INVALIDATING_WRITE_PATHS: readonly RegExp[] = [
  /^\/api\/user-presence(?:\/|$)/,
  /^\/api\/pos\/drafts(?:\/|$)/,
  /^\/api\/notifications(?:\/|$)/,
  /^\/api\/chat(?:\/|$)/,
  /^\/api\/client-observability(?:\/|$)/,
  /^\/api\/auth\/activity(?:\/|$)/,
];

const POS_LOCATION_READ_PATH = /^\/api\/locations\/(\d+)\/inventory\/?$/;
const PAGINATION_HEADER_PATTERN = /^x-(?:total|page|per-page|pagination|has|next|previous|prev|limit|offset)(?:-|$)/;

type ReplayableHeaders = Record<string, string | string[]>;

interface ReadMicrocacheEntry {
  expiresAt: number;
  statusCode: number;
  body: string;
  contentType: string;
  etag: string;
  sizeBytes: number;
  headers: ReplayableHeaders;
}

interface PendingRead {
  generation: number;
  promise: Promise<ReadMicrocacheEntry | null>;
  resolve: (entry: ReadMicrocacheEntry | null) => void;
}

interface ReadMicrocacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBodyBytes?: number;
  maxCacheBytes?: number;
  now?: () => number;
  cacheEnabled?: () => boolean;
  publishInvalidation?: () => Promise<void>;
}

interface ReadMicrocacheController {
  middleware: RequestHandler;
  invalidate: () => void;
}

export interface ReadMicrocacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  coalesced: number;
  revalidated: number;
  stores: number;
  evictions: number;
  invalidations: number;
}

const EMPTY_STATS: ReadMicrocacheStats = {
  entries: 0,
  bytes: 0,
  hits: 0,
  misses: 0,
  coalesced: 0,
  revalidated: 0,
  stores: 0,
  evictions: 0,
  invalidations: 0,
};

let activeStatsReader: () => ReadMicrocacheStats = () => ({ ...EMPTY_STATS });

export function getReadMicrocacheStats(): ReadMicrocacheStats {
  return activeStatsReader();
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;

  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`)
    .join(",")}}`;
}

function getReadTtlMs(req: Request): number | undefined {
  const exactTtl = READ_MICROCACHE_TTL_MS.get(req.path);
  if (exactTtl !== undefined) return exactTtl;
  return DYNAMIC_READ_MICROCACHE_POLICIES.find((policy) => policy.path.test(req.path))?.ttlMs;
}

function isReadOnlyPost(req: Request): boolean {
  return req.method.toUpperCase() === "POST" && req.path === "/api/factory/payrolls/preview";
}

function isCacheableRead(req: Request): boolean {
  const method = req.method.toUpperCase();
  return (method === "GET" || isReadOnlyPost(req)) && getReadTtlMs(req) !== undefined;
}

function isNonInvalidatingWrite(req: Request): boolean {
  return NON_INVALIDATING_WRITE_PATHS.some((pattern) => pattern.test(req.path));
}

export function buildReadMicrocacheKey(req: Request): string {
  const session = req.session;
  const bodyKey = isReadOnlyPost(req) ? stableSerialize(req.body ?? null) : "";
  return [
    req.method,
    req.originalUrl,
    req.headers["x-client-date"] ?? "none",
    bodyKey,
    session?.userId ?? "anonymous",
    session?.currentCompanyId ?? "none",
    session?.factoryCompanyId ?? "none",
    session?.currentRole ?? "none",
    session?.currentLocationId ?? "none",
    session?.currentPOSStation ?? "none",
  ].join("|");
}

function makeEtag(body: string): string {
  const digest = createHash("sha1").update(body).digest("base64url").slice(0, 24);
  return `W/"${Buffer.byteLength(body, "utf8").toString(16)}-${digest}"`;
}

function etagMatches(value: unknown, etag: string): boolean {
  if (typeof value !== "string") return false;
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag);
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
  res.setHeader?.("Vary", "Cookie, Accept-Encoding, X-Client-Date");
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
    };
  };

  function deleteEntry(key: string): void {
    const entry = cache.get(key);
    if (!entry) return;
    cachedBytes -= entry.sizeBytes;
    cache.delete(key);
  }

  function clearForWrite(): void {
    writeGeneration += 1;
    cache.clear();
    cachedBytes = 0;
    counters.invalidations += 1;
    for (const pending of inFlight.values()) pending.resolve(null);
    inFlight.clear();
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

  function publishInvalidation(): void {
    clearForWrite();
    void options.publishInvalidation?.();
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
      if (isNonInvalidatingWrite(req) || !req.session?.userId) return next();

      let finalized = false;
      res.once?.("finish", () => {
        if (finalized) return;
        finalized = true;
        if (res.statusCode >= 200 && res.statusCode < 300) publishInvalidation();
      });
      res.once?.("close", () => {
        if (finalized) return;
        finalized = true;
        publishInvalidation();
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

  return { middleware, invalidate: clearForWrite };
}

export function createReadMicrocacheMiddleware(options: ReadMicrocacheOptions = {}): RequestHandler {
  return createReadMicrocacheController(options).middleware;
}

export function registerPerformanceReadMicrocache(app: { use: (handler: RequestHandler) => unknown }): void {
  // Integration suites write fixtures directly through Drizzle/pg, bypassing the
  // HTTP write boundary that invalidates this production cache. Keep those suites
  // deterministic while dedicated readMicrocache unit tests exercise the cache itself.
  if (process.env.NODE_ENV === "test") return;

  let invalidateLocalCache: () => void = () => undefined;
  const coordinator = startReadMicrocacheCoordinator(() => invalidateLocalCache());
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
