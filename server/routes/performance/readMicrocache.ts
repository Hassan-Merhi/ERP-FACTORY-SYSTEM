import { createHash } from "crypto";
import type { Request, RequestHandler } from "express";
import { checkPOSLocation, requireAuth } from "../../auth";
import { resolveActiveCompanyId } from "../helpers/resolveActiveCompanyId";
import { classifyRealtimeWrite, type RealtimeInvalidationTopic } from "../../../shared/realtimeInvalidation";
import { startReadMicrocacheCoordinator, type ReadMicrocacheInvalidation } from "./readMicrocacheCoordinator";

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
  ["/api/worker-groups/with-members", 300_000],
  ["/api/employee-groups", 300_000],
  ["/api/user/companies", 300_000],
  ["/api/my-erp-pages", 300_000],
  ["/api/pos/last-sold-prices", 30_000],
  ["/api/containers", 30_000],
  ["/api/containers/active", 30_000],
  ["/api/containers/otw-items", 30_000],
  ["/api/factory/categories", 300_000],
  ["/api/stock-transfers", 30_000],
]);

export const READ_MICROCACHE_PATHS = new Set(READ_MICROCACHE_TTL_MS.keys());

interface DynamicReadPolicy {
  path: RegExp;
  ttlMs: number;
}

const DYNAMIC_READ_MICROCACHE_POLICIES: readonly DynamicReadPolicy[] = [
  { path: /^\/api\/locations\/\d+\/inventory\/?$/, ttlMs: 30_000 },
  { path: /^\/api\/locations\/\d+\/inventory\/light\/?$/, ttlMs: 30_000 },
  { path: /^\/api\/factory\/customer-proformas\/\d+\/?$/, ttlMs: 60_000 },
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

const POS_LOCATION_READ_PATH = /^\/api\/locations\/(\d+)\/inventory(?:\/light)?\/?$/;
const PAGINATION_HEADER_PATTERN = /^x-(?:total|page|per-page|pagination|has|next|previous|prev|limit|offset)(?:-|$)/;

type ReplayableHeaders = Record<string, string | string[]>;

interface ReadMicrocacheScope {
  companyIds: number[];
  topics?: RealtimeInvalidationTopic[];
  locationIds?: number[];
}

interface ReadMicrocacheEntry {
  expiresAt: number;
  statusCode: number;
  body: string;
  contentType: string;
  etag: string;
  sizeBytes: number;
  headers: ReplayableHeaders;
  scope: ReadMicrocacheScope;
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
  publishInvalidation?: (invalidation: ReadMicrocacheInvalidation) => Promise<void>;
}

interface ReadMicrocacheController {
  middleware: RequestHandler;
  invalidate: (invalidation?: ReadMicrocacheInvalidation) => void;
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
  targetedInvalidations: number;
  blanketInvalidations: number;
  invalidatedEntries: number;
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
  targetedInvalidations: 0,
  blanketInvalidations: 0,
  invalidatedEntries: 0,
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

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniquePositiveIntegers(values: unknown[]): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const nested of value) {
        const id = positiveInteger(nested);
        if (id !== null) ids.add(id);
      }
      continue;
    }
    const id = positiveInteger(value);
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

function requestCompanyIds(req: Request): number[] {
  const activeCompanyId = resolveActiveCompanyId(req);
  return activeCompanyId ? [activeCompanyId] : [];
}

function readLocationIds(req: Request): number[] | undefined {
  const candidates: unknown[] = [];
  const locationPath = req.path.match(/^\/api\/locations\/(\d+)(?:\/|$)/);
  if (locationPath) candidates.push(locationPath[1]);

  for (const key of [
    "locationId",
    "location_id",
    "fromLocationId",
    "toLocationId",
    "sourceLocationId",
    "destinationLocationId",
  ]) {
    candidates.push(req.query?.[key]);
  }

  const ids = uniquePositiveIntegers(candidates);
  return ids.length > 0 ? ids : undefined;
}

function readTopicsForPath(path: string): RealtimeInvalidationTopic[] | undefined {
  if (/^\/api\/locations\/\d+\/inventory(?:\/light)?\/?$/.test(path)) return ["inventory"];
  if (/^\/api\/accounts\/ledger\/\d+\/transactions\/?$/.test(path)) return ["accounting"];
  if (/^\/api\/vouchers\/\d+\/?$/.test(path)) return ["accounting"];
  if (/^\/api\/factory\/customer-(?:proformas|orders)\//.test(path)) return ["factory"];
  if (/^\/api\/factory\/workers\/attendance-report\/?$/.test(path)) return ["factory", "payroll"];

  if (
    path === "/api/sales-report" ||
    path === "/api/dashboard/sales-report-all" ||
    path === "/api/pos/last-sold-prices"
  ) {
    return ["pos", "accounting"];
  }

  if (
    path === "/api/location-summary" ||
    path === "/api/stock-items" ||
    path === "/api/stock-items/light" ||
    path === "/api/stock-items/all-code-aliases" ||
    path === "/api/locations"
  ) {
    return ["inventory"];
  }

  if (
    path === "/api/reports/stock-movement" ||
    path === "/api/reports/opening-stock-summary" ||
    path === "/api/stock-transfers"
  ) {
    return ["inventory", "accounting"];
  }

  if (
    path === "/api/reports/containers" ||
    path === "/api/containers" ||
    path === "/api/containers/active" ||
    path === "/api/containers/otw-items"
  ) {
    return ["containers", "inventory", "accounting"];
  }

  if (
    path === "/api/daybook" ||
    path === "/api/accounts/all" ||
    path === "/api/accounts/voucher-sidebar" ||
    path === "/api/stats/monthly-data" ||
    path === "/api/ledger-accounts" ||
    path === "/api/ledger-accounts/parent-groups"
  ) {
    return ["accounting"];
  }

  if (
    path === "/api/factory/payrolls" ||
    path === "/api/factory/payrolls/preview" ||
    path === "/api/payroll/worker-payments-summary"
  ) {
    return ["factory", "payroll", "accounting"];
  }

  if (path === "/api/factory/daily-bale-scans" || path === "/api/factory/daily-bale-scans/produced") {
    return ["scans"];
  }

  if (
    path === "/api/factory/raw-stock" ||
    path === "/api/factory/raw-stock/available-containers" ||
    path === "/api/factory/mix-batches" ||
    path === "/api/factory/bale-ledger" ||
    path === "/api/factory/production-value-report" ||
    path === "/api/factory/bales/stock-entry-history"
  ) {
    return ["factory", "inventory"];
  }

  if (path === "/api/factory/containers") return ["factory", "containers"];

  if (path === "/api/factory/daybook" || path === "/api/factory/suppliers/with-balances") {
    return ["factory", "accounting"];
  }

  if (path.startsWith("/api/factory/")) return ["factory"];

  if (
    path === "/api/company-settings" ||
    path === "/api/user/preferences" ||
    path === "/api/customers" ||
    path === "/api/bank-accounts" ||
    path === "/api/fixed-assets" ||
    path === "/api/stock-categories" ||
    path === "/api/stock-grades" ||
    path === "/api/stock-groups" ||
    path === "/api/suppliers" ||
    path === "/api/worker-groups/with-members" ||
    path === "/api/employee-groups" ||
    path === "/api/user/companies" ||
    path === "/api/my-erp-pages" ||
    path === "/api/payroll/bonus-locations"
  ) {
    return ["reference"];
  }

  return undefined;
}

function buildReadScope(req: Request): ReadMicrocacheScope {
  const topics = readTopicsForPath(req.path);
  const locationIds = readLocationIds(req);
  return {
    companyIds: requestCompanyIds(req),
    ...(topics ? { topics } : {}),
    ...(locationIds ? { locationIds } : {}),
  };
}

function buildWriteInvalidation(req: Request): ReadMicrocacheInvalidation {
  const classified = classifyRealtimeWrite(req.originalUrl || req.url, req.body);

  // Unknown write families deliberately keep the legacy blanket fallback. A
  // route we have not classified may mutate cross-company/global state, so
  // narrowing it only by the current session company could leave stale data.
  if (!classified.topics?.length) return {};

  const companyIds = requestCompanyIds(req);
  return {
    ...(companyIds.length > 0 ? { companyIds } : {}),
    ...classified,
  };
}

function idsIntersect(left: readonly number[], right: readonly number[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function topicsIntersect(
  left: readonly RealtimeInvalidationTopic[],
  right: readonly RealtimeInvalidationTopic[]
): boolean {
  const rightSet = new Set<RealtimeInvalidationTopic>(right);
  return left.some((value) => rightSet.has(value));
}

function entryMatchesInvalidation(entry: ReadMicrocacheEntry, invalidation: ReadMicrocacheInvalidation): boolean {
  if (invalidation.companyIds?.length) {
    if (entry.scope.companyIds.length === 0) return true;
    if (!idsIntersect(entry.scope.companyIds, invalidation.companyIds)) return false;
  }

  if (invalidation.topics?.length) {
    if (!entry.scope.topics?.length) return true;
    if (!topicsIntersect(entry.scope.topics, invalidation.topics)) return false;
  }

  if (invalidation.locationIds?.length && entry.scope.locationIds?.length) {
    if (!idsIntersect(entry.scope.locationIds, invalidation.locationIds)) return false;
  }

  return true;
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
      if (isNonInvalidatingWrite(req) || !req.session?.userId) return next();

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
