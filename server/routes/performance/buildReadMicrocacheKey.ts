// Extracted from ./readMicrocache.ts to keep that module under the source-size cap.
import { createHash } from "crypto";
import type { Request } from "express";
import { classifyRealtimeWrite, type RealtimeInvalidationTopic } from "../../../shared/realtimeInvalidation";
import type { ReadMicrocacheInvalidation } from "./readMicrocacheCoordinator";
import { isFxRateDependentPath } from "../../../shared/fxRateQueryInvalidation";
import {
  factoryCatalogLanguageKey,
  isReadOnlyPost,
  readLocationIds,
  requestCompanyIds,
  stableSerialize,
  type ReadMicrocacheEntry,
  type ReadMicrocacheScope,
} from "./readMicrocacheReadLocationIds";

function readTopicsForPath(path: string): RealtimeInvalidationTopic[] | undefined {
  if (/^\/api\/locations\/\d+\/inventory(?:\/light)?\/?$/.test(path)) return ["inventory"];
  if (/^\/api\/accounts\/ledger\/\d+\/transactions\/?$/.test(path)) return ["accounting"];
  if (/^\/api\/vouchers\/\d+\/?$/.test(path)) return ["accounting"];
  if (/^\/api\/factory\/customer-(?:proformas|orders)\//.test(path)) return ["factory"];
  if (/^\/api\/factory\/workers\/attendance-report\/?$/.test(path)) return ["factory", "payroll"];

  if (path === "/api/sales-report" || path === "/api/dashboard/sales-report-all") {
    return ["pos", "accounting", "inventory", "reference"];
  }

  if (path === "/api/pos/last-sold-prices") {
    return ["pos", "accounting"];
  }

  if (path === "/api/location-summary") {
    return ["inventory"];
  }

  if (
    path === "/api/stock-items" ||
    path === "/api/stock-items/light" ||
    path === "/api/stock-items/all-code-aliases" ||
    path === "/api/locations"
  ) {
    return ["reference"];
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

  if (path === "/api/accounts/all") {
    return ["accounting", "reference"];
  }

  if (path === "/api/daybook" || path === "/api/accounts/voucher-sidebar" || path === "/api/stats/monthly-data") {
    return ["accounting"];
  }

  if (path === "/api/ledger-accounts" || path === "/api/ledger-accounts/parent-groups") {
    return ["reference"];
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

  if (
    path === "/api/factory/bale-products" ||
    path === "/api/factory/categories" ||
    path === "/api/factory/settings" ||
    path === "/api/factory/my-access" ||
    path === "/api/factory/suppliers" ||
    path === "/api/factory/worker-categories"
  ) {
    return ["reference"];
  }

  // The customer list includes live ledger and unposted balances, not just identity data.
  // A proforma transfer, order update, or voucher must evict this cached projection.
  if (path === "/api/factory/customers") return ["factory", "accounting", "reference"];

  if (path === "/api/factory/cash-accounts") return ["reference", "accounting"];

  if (path === "/api/factory/workers" || path === "/api/factory/employees") {
    return ["reference", "payroll", "accounting"];
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

export function buildReadScope(req: Request): ReadMicrocacheScope {
  const baseTopics = readTopicsForPath(req.path);
  // Some balances live in the long-lived reference microcache. A company FX
  // revision must evict their USD read models, while keeping unrelated stock
  // and supplier caches warm. Shared with the frontend FX query predicate.
  const topics: RealtimeInvalidationTopic[] | undefined = isFxRateDependentPath(req.path)
    ? [...new Set<RealtimeInvalidationTopic>([...(baseTopics ?? []), "fx"])]
    : baseTopics;
  const locationIds = readLocationIds(req);
  const companyIds = req.path === "/api/dashboard/sales-report-all" ? [] : requestCompanyIds(req);
  return {
    companyIds,
    ...(topics ? { topics } : {}),
    ...(locationIds ? { locationIds } : {}),
  };
}

export function buildWriteInvalidation(req: Request): ReadMicrocacheInvalidation {
  const classified = classifyRealtimeWrite(req.originalUrl || req.url, req.body);

  // Unknown write families deliberately keep the legacy blanket fallback. A
  // route we have not classified may mutate cross-company/global state, so
  // narrowing it only by the current session company could leave stale data.
  if (!classified.topics?.length) return {};

  const companyIds = requestCompanyIds(req);
  // A proforma transfer is published to browsers with the "reference" topic so
  // their customer lists refresh, but here the cached customer list is already
  // a "factory" entry: evicting every reference cache (stock items, groups...)
  // for it would only cost warm unrelated reads.
  const path = (req.originalUrl || req.url).split("?")[0];
  const topics = PROFORMA_TRANSFER_PATH.test(path)
    ? classified.topics.filter((topic) => topic !== "reference")
    : classified.topics;
  return {
    ...(companyIds.length > 0 ? { companyIds } : {}),
    ...classified,
    topics,
  };
}

const PROFORMA_TRANSFER_PATH = /^\/api\/factory\/customer-proformas\/\d+\/transfer\/?$/;

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

export function entryMatchesInvalidation(
  entry: ReadMicrocacheEntry,
  invalidation: ReadMicrocacheInvalidation
): boolean {
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
    factoryCatalogLanguageKey(req),
    bodyKey,
    session?.userId ?? "anonymous",
    session?.currentCompanyId ?? "none",
    session?.factoryCompanyId ?? "none",
    session?.currentRole ?? "none",
    session?.currentLocationId ?? "none",
    session?.currentPOSStation ?? "none",
  ].join("|");
}

export function makeEtag(body: string): string {
  const digest = createHash("sha1").update(body).digest("base64url").slice(0, 24);
  return `W/"${Buffer.byteLength(body, "utf8").toString(16)}-${digest}"`;
}

export function etagMatches(value: unknown, etag: string): boolean {
  if (typeof value !== "string") return false;
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag);
}
