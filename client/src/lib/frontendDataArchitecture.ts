import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { QUERY_GC_TIMES, QUERY_STALE_TIMES } from "./queryPolicies";

export type QueryParamValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryParamValue | readonly QueryParamValue[]>;
export type CompanyIdentity = number | string | null | undefined;

/** Sort and deduplicate set-like filters so selection order cannot create duplicate cache entries. */
export function canonicalSetValues<T extends QueryParamValue>(values: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    unique.set(`${typeof value}:${String(value)}`, value);
  }
  return [...unique.values()].sort((left, right) =>
    String(left).localeCompare(String(right), undefined, { numeric: true })
  );
}

/** Build a stable URL so equivalent filters share one React Query cache entry. */
export function canonicalApiUrl(pathname: string, params?: QueryParams): string {
  if (!params) return pathname;
  const search = new URLSearchParams();

  for (const key of Object.keys(params).sort()) {
    const raw = params[key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      search.append(key, String(value));
    }
  }

  const suffix = search.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

function normalizeCompanyIdentity(companyId: CompanyIdentity): number | string {
  return companyId ?? "no-company";
}

/** Keep the actual request URL first; company identity prevents cross-company reuse. */
export function companyDataKey(
  requestUrl: string,
  companyId: CompanyIdentity,
  ...identity: readonly unknown[]
): readonly unknown[] {
  return [requestUrl, normalizeCompanyIdentity(companyId), ...identity] as const;
}

/** Canonical identity for paginated company data. */
export function paginatedCompanyDataKey(
  requestUrl: string,
  companyId: CompanyIdentity,
  page: number,
  pageSize: number,
  ...identity: readonly unknown[]
): readonly unknown[] {
  return companyDataKey(requestUrl, companyId, "page", page, pageSize, ...identity);
}

export function queryRequestUrl(queryKey: QueryKey): string | null {
  return typeof queryKey[0] === "string" ? queryKey[0] : null;
}

export function queryPathname(queryKey: QueryKey): string | null {
  const requestUrl = queryRequestUrl(queryKey);
  if (!requestUrl) return null;
  return requestUrl.split("?", 1)[0];
}

export function queryCompanyIdentity(queryKey: QueryKey): unknown {
  return queryKey.length > 1 ? queryKey[1] : undefined;
}

/** Exact family matching: /api/accounts matches itself and descendants, not /api/accounts-old. */
export function queryMatchesApiFamily(queryKey: QueryKey, family: string): boolean {
  const pathname = queryPathname(queryKey);
  if (!pathname) return false;
  const normalized = family.endsWith("/") ? family.slice(0, -1) : family;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

/** Exact endpoint-family matching constrained to one company cache identity. */
export function queryMatchesCompanyApiFamily(
  queryKey: QueryKey,
  family: string,
  companyId: CompanyIdentity
): boolean {
  return (
    queryMatchesApiFamily(queryKey, family) &&
    queryCompanyIdentity(queryKey) === normalizeCompanyIdentity(companyId)
  );
}

export function invalidateApiFamily(
  client: QueryClient,
  family: string,
  options: { refetchType?: "active" | "inactive" | "all" | "none" } = {}
): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => queryMatchesApiFamily(query.queryKey, family),
    refetchType: options.refetchType ?? "active",
  });
}

export function invalidateCompanyApiFamily(
  client: QueryClient,
  family: string,
  companyId: CompanyIdentity,
  options: { refetchType?: "active" | "inactive" | "all" | "none" } = {}
): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => queryMatchesCompanyApiFamily(query.queryKey, family, companyId),
    refetchType: options.refetchType ?? "active",
  });
}

export function removeApiFamily(client: QueryClient, family: string): void {
  client.removeQueries({
    predicate: (query) => queryMatchesApiFamily(query.queryKey, family),
  });
}

export function removeCompanyApiFamily(client: QueryClient, family: string, companyId: CompanyIdentity): void {
  client.removeQueries({
    predicate: (query) => queryMatchesCompanyApiFamily(query.queryKey, family, companyId),
  });
}

export interface PaginatedPayload<T> {
  data?: T[];
  items?: T[];
  rows?: T[];
  results?: T[];
  total?: number;
  page?: number;
  pageSize?: number;
  limit?: number;
  totalPages?: number;
  hasMore?: boolean;
}

/** Normalize legacy array and paginated endpoint shapes without changing APIs. */
export function unwrapList<T>(payload: T[] | PaginatedPayload<T> | null | undefined): T[] {
  if (Array.isArray(payload)) return payload;
  if (!payload) return [];
  for (const candidate of [payload.data, payload.items, payload.rows, payload.results]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export interface NormalizedPage<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

/** Normalize page metadata while remaining compatible with legacy array responses. */
export function unwrapPage<T>(
  payload: T[] | PaginatedPayload<T> | null | undefined,
  fallback: { page?: number; pageSize?: number } = {}
): NormalizedPage<T> {
  const data = unwrapList(payload);
  const page = !Array.isArray(payload) && payload?.page ? payload.page : fallback.page ?? 1;
  const pageSize =
    (!Array.isArray(payload) && (payload?.pageSize ?? payload?.limit)) ||
    fallback.pageSize ||
    Math.max(data.length, 1);
  const total = !Array.isArray(payload) && typeof payload?.total === "number" ? payload.total : data.length;
  const totalPages =
    !Array.isArray(payload) && typeof payload?.totalPages === "number"
      ? payload.totalPages
      : total === 0
        ? 0
        : Math.ceil(total / pageSize);
  const hasMore =
    !Array.isArray(payload) && typeof payload?.hasMore === "boolean"
      ? payload.hasMore
      : page < totalPages;
  return { data, total, page, pageSize, totalPages, hasMore };
}

export const frontendQueryPolicies = {
  reference: {
    staleTime: QUERY_STALE_TIMES.referenceData,
    gcTime: QUERY_GC_TIMES.referenceData,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  },
  operational: {
    staleTime: 30 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  },
  live: {
    staleTime: QUERY_STALE_TIMES.live,
    gcTime: QUERY_GC_TIMES.live,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
    refetchOnReconnect: true,
  },
} as const;
