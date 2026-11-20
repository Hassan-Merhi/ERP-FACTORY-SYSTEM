import { companyReadCacheIdentity } from "./companyCacheScope";

/**
 * Canonical mechanics for browser fetch interceptors.
 *
 * This module only normalizes native fetch inputs; endpoint selection, pagination,
 * company-scoped cache keys, credential forwarding, and the interception order
 * remain entirely the responsibility of each owning client.
 *
 * Do not eagerly capture window.fetch here: each interceptor must retain the
 * previousFetch reference captured when its own wrapper was installed.
 */
export function resolveFetchUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input, window.location.origin);
    if (input instanceof URL) return new URL(input.toString(), window.location.origin);
    if (input instanceof Request) return new URL(input.url, window.location.origin);
  } catch {
    return null;
  }
  return null;
}

/** Method in RequestInit takes precedence over the method of a Request input. */
export function fetchRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
}

/** Rewrites only the URL, retaining all options carried by a Request input. */
export function replaceFetchInputUrl(input: RequestInfo | URL, url: URL): RequestInfo | URL {
  if (input instanceof Request) return new Request(url.toString(), input);
  if (input instanceof URL) return url;
  return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

/**
 * Canonical key for the *same* endpoint and server-filtered query, independent
 * of cursor/page-size mechanics. Caller supplies the exact pagination keys to
 * omit and, where required, a company scope from the current session.
 *
 * Do not supply a company scope where the original interceptor omitted one,
 * or change the caller's parameter exclusions: both affect cache identity.
 */
export function fetchQueryCacheKey(url: URL, omittedParams: readonly string[], companyScope?: string): string {
  const params = new URLSearchParams(url.searchParams);
  for (const key of omittedParams) params.delete(key);
  params.sort();
  const key = `${url.pathname}?${params.toString()}`;
  return `${companyReadCacheIdentity()}|${companyScope === undefined ? key : `${companyScope}|${key}`}`;
}
