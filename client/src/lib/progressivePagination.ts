/**
 * Shared vocabulary for the progressive list clients that intercept `fetch`
 * (factory daybook, V5 stock allocation).
 *
 * Two facts about those interceptors motivate this module:
 *
 * 1. The paginated envelope is optional. The same endpoint answers with a
 *    legacy unpaginated body, and a paginated body may omit `total`/
 *    `totalPages` entirely. Coercing a missing field to `0` makes "the server
 *    did not say" indistinguishable from "the server said none", so the
 *    metadata below keeps the absent case as `null` and every caller decides
 *    explicitly what to do with it.
 * 2. The request URL carries no company. The active company lives in the
 *    session cookie, so two companies produce byte-identical daybook URLs.
 *    A cache keyed only on the URL therefore merges rows across a company
 *    switch, which breaks tenant isolation. Cache keys include the scope
 *    below so a switch always starts a fresh page cache.
 */

/** Where `CompanyProvider` records the active company for this browser. */
export const ACTIVE_COMPANY_SCOPE_STORAGE_KEY = "selectedCompanyId";

/** Scope used before a company has been selected, or when storage is unreadable. */
export const NO_ACTIVE_COMPANY_SCOPE = "no-company";

/**
 * The active company as a cache-key fragment. Storage access throws in
 * privacy modes, so an unreadable store degrades to the shared "no company"
 * scope rather than failing the request.
 */
export function readActiveCompanyScope(): string {
  try {
    if (typeof localStorage === "undefined") return NO_ACTIVE_COMPANY_SCOPE;
    const raw = localStorage.getItem(ACTIVE_COMPANY_SCOPE_STORAGE_KEY);
    if (raw === null) return NO_ACTIVE_COMPANY_SCOPE;
    const trimmed = raw.trim();
    return trimmed === "" ? NO_ACTIVE_COMPANY_SCOPE : trimmed;
  } catch {
    return NO_ACTIVE_COMPANY_SCOPE;
  }
}

/** The pagination fields a server envelope may or may not carry. */
export interface PaginationEnvelope {
  total?: number | null;
  page?: number | null;
  limit?: number | null;
  totalPages?: number | null;
}

/**
 * Pagination metadata as it actually arrives.
 *
 * `total` and `totalPages` stay `null` when the envelope omitted them or sent
 * something unusable: the list then behaves as a single page instead of
 * pretending the server reported an empty result.
 */
export interface ProgressivePageMetadata {
  total: number | null;
  totalPages: number | null;
  /** Always resolved: the requested page is the fallback the server agreed to. */
  page: number;
  /** Always resolved: the client's own page size is the fallback. */
  limit: number;
}

function readCount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function readPositive(value: number | null | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

export function readPageMetadata(
  envelope: PaginationEnvelope,
  requestedPage: number,
  defaultLimit: number
): ProgressivePageMetadata {
  return {
    total: readCount(envelope.total),
    totalPages: readCount(envelope.totalPages),
    page: readPositive(envelope.page, requestedPage),
    limit: readPositive(envelope.limit, defaultLimit),
  };
}

/** True when the server reported a page that no longer exists. */
export function isPageOutOfRange(metadata: ProgressivePageMetadata): boolean {
  return metadata.totalPages !== null && metadata.totalPages > 0 && metadata.page > metadata.totalPages;
}

/** True when more pages are known to exist beyond what has been loaded. */
export function hasUnloadedPages(
  metadata: Pick<ProgressivePageMetadata, "totalPages">,
  highestLoadedPage: number
): boolean {
  return metadata.totalPages !== null && highestLoadedPage < metadata.totalPages;
}

/** True when the loaded row count is known to have reached the reported total. */
export function hasLoadedEveryRow(total: number | null, loadedCount: number): boolean {
  return total !== null && loadedCount >= total;
}
