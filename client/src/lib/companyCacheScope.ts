import { invalidateBandwidthReadCaches } from "./bandwidthInvalidationPolicy";

/**
 * Browser-tab company read identity. This is a cache/response fence, NOT an
 * authorization mechanism; the authenticated server session remains the
 * source of truth. Its revision changes before a switch and again on commit,
 * so a response started under a previous session cannot enter a new cache.
 */
let companyId: number | null = null;
let revision = 0;
let transitioning = false;
let serverCompanyRevision: string | null = null;

export interface CompanyReadSnapshot {
  readonly companyId: number | null;
  readonly revision: number;
  readonly transitioning: boolean;
}

export interface CompanyMutationSnapshot extends CompanyReadSnapshot {
  readonly serverRevision: string;
}

const COMPANY_WRITE_EXEMPT_PATHS = [
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/csrf-token\/?$/,
  /^\/api\/(?:user-preferences|language-preference|user-presence|build-info|health)(?:\/|$)/,
];

export function isCompanyOwnedApiMutation(method: string, pathname: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
    pathname.startsWith("/api/") &&
    !COMPANY_WRITE_EXEMPT_PATHS.some((pattern) => pattern.test(pathname));
}

/** Only server-verified revisions may authorize a company-owned browser write. */
export function rememberVerifiedServerCompanyRevision(company: number, revision?: string | null): void {
  if (company !== companyId || transitioning) return;
  serverCompanyRevision =
    typeof revision === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(revision) ? revision : "legacy";
}

export function captureCompanyMutationSnapshot(method: string, pathname: string): CompanyMutationSnapshot | null {
  if (!isCompanyOwnedApiMutation(method, pathname) || companyId === null) return null;
  const snapshot = captureCompanyReadSnapshot();
  assertCompanyReadSnapshot(snapshot);
  if (!serverCompanyRevision) throw companyReadAbortError();
  return { ...snapshot, serverRevision: serverCompanyRevision };
}

export function assertCompanyMutationSnapshot(snapshot: CompanyMutationSnapshot | null): void {
  if (!snapshot) return;
  assertCompanyReadSnapshot(snapshot);
  if (snapshot.serverRevision !== serverCompanyRevision) throw companyReadAbortError();
}

export function addCompanyMutationHeaders(headers: Headers, snapshot: CompanyMutationSnapshot | null): void {
  if (!snapshot?.companyId) return;
  // Do not rewrite headers from an earlier queued operation; the server must
  // reject those old headers if the session has since changed.
  if (!headers.has("X-Expected-Company-Id")) headers.set("X-Expected-Company-Id", String(snapshot.companyId));
  if (!headers.has("X-Expected-Company-Revision")) headers.set("X-Expected-Company-Revision", snapshot.serverRevision);
}

const GLOBAL_READ_ENDPOINTS = [
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/user\/companies(?:\/|$)/,
  /^\/api\/csrf-token\/?$/,
  /^\/api\/build-info(?:\/|$)/,
  /^\/api\/health(?:\/|$)/,
  /^\/api\/boot\/?$/,
];

export function isCompanyOwnedApiRead(pathname: string): boolean {
  return pathname.startsWith("/api/") && !GLOBAL_READ_ENDPOINTS.some((pattern) => pattern.test(pathname));
}

export function captureCompanyReadSnapshot(): CompanyReadSnapshot {
  return { companyId, revision, transitioning };
}

/**
 * Internal cache identity; includes a generation so validators and inflight
 * deduplication never cross a company switch or a failed verification.
 */
export function companyReadCacheIdentity(): string {
  return `${companyId ?? "unselected"}:${revision}:${transitioning ? "pending" : "verified"}`;
}

export function companyReadAbortError(): DOMException {
  return new DOMException("Company session changed while loading data.", "AbortError");
}

/** Protect all company-owned GETs, including raw fetch and pagination reads. */
export function assertCompanyReadSnapshot(snapshot: CompanyReadSnapshot): void {
  if (
    snapshot.transitioning ||
    transitioning ||
    revision !== snapshot.revision ||
    (snapshot.companyId !== null && snapshot.companyId !== companyId)
  ) {
    throw companyReadAbortError();
  }
}

/** Called synchronously before any company change/verification starts. */
export function beginCompanyCacheTransition(): void {
  if (transitioning) return;
  transitioning = true;
  revision += 1;
  invalidateBandwidthReadCaches("all");
}

/** Called only when the authenticated session has selected this company. */
export function activateCompanyCacheScope(nextCompanyId: number): void {
  if (!Number.isSafeInteger(nextCompanyId) || nextCompanyId <= 0) return;
  const wasSelected = companyId !== null;
  const changed = companyId !== nextCompanyId;
  const wasTransitioning = transitioning;
  companyId = nextCompanyId;
  if (changed) serverCompanyRevision = null;
  transitioning = false;
  // Initial adoption of an already-active server session should not abort
  // its startup fetches. A different company or a verification must fence.
  if (wasTransitioning || (wasSelected && changed)) {
    revision += 1;
    invalidateBandwidthReadCaches("all");
  }
}

/** A refused switch or verified same-company resume keeps the old workspace. */
export function resumeCompanyCacheScope(): void {
  if (!transitioning) return;
  transitioning = false;
  revision += 1;
  invalidateBandwidthReadCaches("all");
}

/** Tests only: ensure separate test scenarios cannot inherit process state. */
export function _testOnly_resetCompanyCacheScope(): void {
  companyId = null;
  revision = 0;
  transitioning = false;
  serverCompanyRevision = null;
}
