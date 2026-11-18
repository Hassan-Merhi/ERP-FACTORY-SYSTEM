// Extracted from ./readMicrocache.ts to keep that module under the source-size cap.
import type { Request, RequestHandler } from "express";
import { resolveActiveCompanyId } from "../helpers/resolveActiveCompanyId";
import type { RealtimeInvalidationTopic } from "../../../shared/realtimeInvalidation";
import type { ReadMicrocacheInvalidation } from "./readMicrocacheCoordinator";

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

export const POS_LOCATION_READ_PATH = /^\/api\/locations\/(\d+)\/inventory(?:\/light)?\/?$/;

export const PAGINATION_HEADER_PATTERN =
  /^x-(?:total|page|per-page|pagination|has|next|previous|prev|limit|offset)(?:-|$)/;

export type ReplayableHeaders = Record<string, string | string[]>;

export interface ReadMicrocacheScope {
  companyIds: number[];
  topics?: RealtimeInvalidationTopic[];
  locationIds?: number[];
}

export interface ReadMicrocacheEntry {
  expiresAt: number;
  statusCode: number;
  body: string;
  contentType: string;
  etag: string;
  sizeBytes: number;
  headers: ReplayableHeaders;
  scope: ReadMicrocacheScope;
}

export interface PendingRead {
  generation: number;
  promise: Promise<ReadMicrocacheEntry | null>;
  resolve: (entry: ReadMicrocacheEntry | null) => void;
}

export interface ReadMicrocacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBodyBytes?: number;
  maxCacheBytes?: number;
  now?: () => number;
  cacheEnabled?: () => boolean;
  publishInvalidation?: (invalidation: ReadMicrocacheInvalidation) => Promise<void>;
}

export interface ReadMicrocacheController {
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

export const EMPTY_STATS: ReadMicrocacheStats = {
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

export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;

  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`)
    .join(",")}}`;
}

export function getReadTtlMs(req: Request): number | undefined {
  const exactTtl = READ_MICROCACHE_TTL_MS.get(req.path);
  if (exactTtl !== undefined) return exactTtl;
  return DYNAMIC_READ_MICROCACHE_POLICIES.find((policy) => policy.path.test(req.path))?.ttlMs;
}

export function isReadOnlyPost(req: Request): boolean {
  return req.method.toUpperCase() === "POST" && req.path === "/api/factory/payrolls/preview";
}

export function isCacheableRead(req: Request): boolean {
  const method = req.method.toUpperCase();
  return (method === "GET" || isReadOnlyPost(req)) && getReadTtlMs(req) !== undefined;
}

export function isNonInvalidatingWrite(req: Request): boolean {
  return NON_INVALIDATING_WRITE_PATHS.some((pattern) => pattern.test(req.path));
}

function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return value.join("=");
    }
  }
  return null;
}

export function factoryCatalogLanguageKey(req: Request): "none" | "en" | "ar" | "fr" {
  if (!req.path.startsWith("/api/factory/")) return "none";
  const raw =
    req.query?.lang ??
    req.headers["x-factory-catalog-language"] ??
    readCookie(req.headers.cookie, "factory_catalog_language");
  return raw === "ar" || raw === "fr" ? raw : "en";
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

export function requestCompanyIds(req: Request): number[] {
  const activeCompanyId = resolveActiveCompanyId(req);
  return activeCompanyId ? [activeCompanyId] : [];
}

export function readLocationIds(req: Request): number[] | undefined {
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
