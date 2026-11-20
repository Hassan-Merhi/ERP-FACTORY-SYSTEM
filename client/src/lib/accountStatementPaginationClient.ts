import { companyReadCacheIdentity } from "./companyCacheScope";
import {
  resolveFetchUrl as resolveUrl,
  replaceFetchInputUrl as replaceInputUrl,
  fetchRequestMethod as methodOf,
  fetchQueryCacheKey,
} from "./fetchRequestUtils";
const ACCOUNT_ROUTE_SUFFIX = "/accounts";
const ENDPOINT_PATTERN = /^\/api\/accounts\/(ledger|bank|fixed-asset|supplier|employee|customer)\/\d+\/transactions$/;
const LEGACY_LIMIT = 100;

interface StatementPage {
  transactions: unknown[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  periodDebitTotal?: number;
  periodCreditTotal?: number;
  closingNetBalance?: number;
}

export interface AccountStatementPaginationSnapshot {
  key: string;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  periodDebitTotal: number | null;
  periodCreditTotal: number | null;
  closingNetBalance: number | null;
}

let statementSnapshot: AccountStatementPaginationSnapshot | null = null;
const statementListeners = new Set<() => void>();

export function getAccountStatementPaginationSnapshot(): AccountStatementPaginationSnapshot | null {
  return statementSnapshot?.key.startsWith(`${companyReadCacheIdentity()}|`) ? statementSnapshot : null;
}

export function subscribeAccountStatementPagination(listener: () => void): () => void {
  statementListeners.add(listener);
  return () => statementListeners.delete(listener);
}

function updateStatementSnapshot(next: AccountStatementPaginationSnapshot | null): void {
  if (statementSnapshot === next) return;
  statementSnapshot = next;
  for (const listener of statementListeners) listener();
}

declare global {
  interface Window {
    __erpAccountStatementPaginationInstalled?: boolean;
  }
}

function onAccountsRoute(): boolean {
  return window.location.pathname === "/accounts" || window.location.pathname.endsWith(ACCOUNT_ROUTE_SUFFIX);
}

if (typeof window !== "undefined" && !window.__erpAccountStatementPaginationInstalled) {
  window.__erpAccountStatementPaginationInstalled = true;
  const previousFetch = window.fetch.bind(window);

  const baseKey = (url: URL): string =>
    fetchQueryCacheKey(url, ["continuous", "cursor", "pagination", "page", "limit", "pageSize", "offset"]);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (methodOf(input, init) !== "GET" || !onAccountsRoute()) return previousFetch(input, init);
    const url = resolveUrl(input);
    if (!url || !ENDPOINT_PATTERN.test(url.pathname)) return previousFetch(input, init);

    // Wave 3 account statements own their finite cursor chain through React Query.
    // Do not rewrite those requests and never show the old Previous/Next overlay.
    if (url.searchParams.get("continuous") === "1" || url.searchParams.has("cursor")) {
      if (statementSnapshot !== null) updateStatementSnapshot(null);
      return previousFetch(input, init);
    }

    // Keep an old/unmigrated caller bounded while it is still present in a cached
    // bundle. It receives the first legacy page, but the removed footer can no longer
    // encourage manual deep OFFSET paging.
    url.searchParams.set("pagination", "1");
    url.searchParams.set("page", "1");
    url.searchParams.set("limit", String(LEGACY_LIMIT));

    const response = await previousFetch(replaceInputUrl(input, url), init);
    if (!response.ok) return response;
    try {
      const payload = (await response.clone().json()) as StatementPage;
      if (!payload || !Array.isArray(payload.transactions) || payload.total === undefined) return response;
      updateStatementSnapshot({
        key: baseKey(url),
        total: Number(payload.total || 0),
        page: Number(payload.page || 1) || 1,
        limit: Number(payload.limit || LEGACY_LIMIT) || LEGACY_LIMIT,
        totalPages: Number(payload.totalPages || 0),
        periodDebitTotal: Number.isFinite(Number(payload.periodDebitTotal)) ? Number(payload.periodDebitTotal) : null,
        periodCreditTotal: Number.isFinite(Number(payload.periodCreditTotal))
          ? Number(payload.periodCreditTotal)
          : null,
        closingNetBalance: Number.isFinite(Number(payload.closingNetBalance))
          ? Number(payload.closingNetBalance)
          : null,
      });
    } catch {
      // Preserve the original response when a legacy payload cannot be inspected.
    }
    return response;
  };

  window.addEventListener("popstate", () => {
    if (!onAccountsRoute()) updateStatementSnapshot(null);
  });
}
