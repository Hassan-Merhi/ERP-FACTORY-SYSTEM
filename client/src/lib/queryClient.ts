import { installPermissionRevalidationListener } from "./permissionRevalidation";
import {
  addCompanyMutationHeaders,
  assertCompanyMutationSnapshot,
  assertPreparedCompanyMutationStillCurrent,
  assertCompanyReadSnapshot,
  captureCompanyMutationSnapshot,
  captureCompanyReadSnapshot,
  isCompanyOwnedApiRead,
  type CompanyMutationSnapshot,
} from "./companyCacheScope";
import { getErrorDetails } from "@shared/errorUtils";
import { QueryClient } from "@tanstack/react-query";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";
import {
  ACCESS_API_ENDPOINTS,
  STABLE_REFERENCE_API_ENDPOINTS,
  STABLE_SETTINGS_API_ENDPOINTS,
  accessQueryPolicy,
  stableReferenceQueryPolicy,
  stableSettingsQueryPolicy,
} from "./queryPolicies";
import { applyReferenceMutationResponse } from "./referenceMutationCache";
import { getRealtimeClientId } from "./realtimeClientIdentity";
import { factoryPageOwnsAccountsAllRead, factoryPageOwnsSharedAccountingRead } from "./factoryClientAccess";
import { coldStartReadOnlyActive, coldStartReadOnlyResponse } from "./offline/coldStartState";
import {
  AUTH_PATHS,
  _CAPACITOR_API_BASE,
  emptyAccountsEnvelopeResponse,
  emptyJsonArrayResponse,
  ensureCsrfToken,
  expiredSessionResponse,
  factoryAccountingModuleAccess,
  isCsrfTokenMismatch,
  isFactoryAccountingRead,
  isFactoryAccountsAllRead,
  prepareApiRequest,
  resetCsrfToken,
} from "./queryClientGetAppDate";
import {
  _sessionExpiredHandled,
  assertCreateOnlyRequestAllowed,
  handlePossibleSessionExpiry,
  queryClient,
  throwIfResNotOk,
} from "./queryClientGetQueryFn";
export {
  _testOnly_setRedirectFn,
  getAppDate,
  resetCsrfToken,
  setAppTimezone,
  setFactoryAccountingModuleAccess,
} from "./queryClientGetAppDate";
export {
  _testOnly_resetSessionExpired,
  getQueryFn,
  handlePossibleSessionExpiry,
  queryClient,
  verifySessionExpired,
} from "./queryClientGetQueryFn";
export { apiRequest } from "./queryClientApiRequest";

/** Session writes a read-only cold-start viewer may still make (sign in / out). */
const COLD_START_ALLOWED_WRITES = new Set(["/api/auth/login", "/api/auth/logout", "/api/csrf-token"]);

function shouldBlockExpiredSessionRequest(pathname: string | null): boolean {
  return _sessionExpiredHandled && !!pathname?.startsWith("/api/") && !AUTH_PATHS.has(pathname);
}

let referenceMutationQueryClient: QueryClient | null = null;
export function _testOnly_isSessionTrafficBlocked() {
  return _sessionExpiredHandled;
}

/* ── Global fetch interceptor ────────────────────────────────────────────── */
// Wraps window.fetch so that ALL state-changing requests to /api/* (including
// raw fetch() calls in legacy pages, hooks, sync engines, dialogs, etc.) get
// the X-CSRF-Token header automatically. This is the bridge between the new
// CSRF middleware and the ~350 raw fetch sites scattered across the codebase
// — without this, those sites would all need to be migrated to apiRequest()
// before CSRF_ENFORCE=1 could be flipped on. With this, the migration becomes
// invisible. The interceptor:
//   • Only acts on /api/* URLs (relative or same-origin absolute)
//   • Skips /api/csrf-token to avoid recursion
//   • Skips GET/HEAD/OPTIONS
//   • Never overrides an existing X-CSRF-Token header
//   • Falls through cleanly if the token cannot be fetched
//   • Auto-retries once on CSRF_TOKEN_MISMATCH (stale cached token after
//     server restart / session regeneration on Render)
if (
  typeof window !== "undefined" &&
  !(window as unknown as (Window & typeof globalThis) & { __csrfFetchPatched: number }).__csrfFetchPatched
) {
  (window as unknown as (Window & typeof globalThis) & { __csrfFetchPatched: true }).__csrfFetchPatched = true;
  const originalFetch = window.fetch.bind(window);

  async function fetchWithCsrf(
    input: RequestInfo | URL,
    init?: RequestInit,
    isRetry = false,
    originalWriteScope?: CompanyMutationSnapshot | null
  ): Promise<Response> {
    // Capacitor: prefix relative /api/* paths with the remote server base URL.
    // No-op when VITE_API_BASE_URL is unset (all web builds — zero behavior change).
    if (_CAPACITOR_API_BASE && typeof input === "string" && input.startsWith("/")) {
      input = `${_CAPACITOR_API_BASE}${input}`;
    }

    // Resolve pathname BEFORE the try block so it is accessible in both the
    // state-changing path (inside try) and the GET fallback path (after try).
    let pathname: string | null = null;
    try {
      if (typeof input === "string") {
        pathname = input.startsWith("/") ? input.split("?")[0] : new URL(input, window.location.origin).pathname;
      } else if (input instanceof URL) {
        pathname = input.pathname;
      } else if (input instanceof Request) {
        pathname = new URL(input.url, window.location.origin).pathname;
      }
    } catch {
      /* opaque URL — skip */
    }

    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    // Capture at the original user action, before any asynchronous CSRF work.
    // A retry must carry the same scope, not silently adopt the next company.
    const writeScope =
      originalWriteScope === undefined
        ? captureCompanyMutationSnapshot(method, pathname ?? "")
        : originalWriteScope;
    assertCompanyMutationSnapshot(writeScope);
    // The authenticated server session, not the URL, owns company-specific
    // responses. Reject GETs started before or during a company transition.
    // Session/auth/health probes remain available to complete the switch.
    const readScope =
      method === "GET" && pathname && isCompanyOwnedApiRead(pathname) ? captureCompanyReadSnapshot() : null;
    if (readScope) assertCompanyReadSnapshot(readScope);

    // Once /api/auth/me has confirmed expiry, stop protected traffic at the
    // browser boundary. This catches React Query, raw fetch(), polling hooks,
    // presence updates, and screen-feed heartbeats without weakening backend
    // authorization or treating ordinary business 401s as logout.
    if (shouldBlockExpiredSessionRequest(pathname)) {
      return expiredSessionResponse();
    }

    // Plan batch 5 (decision 10): a laptop that reaches neither the cloud nor
    // the factory server is a read-only viewer. Every write is refused here,
    // before it can be sent or queued anywhere. Signing in again is allowed.
    if (
      OFFLINE_MODE_ENABLED &&
      coldStartReadOnlyActive() &&
      !["GET", "HEAD", "OPTIONS"].includes(method) &&
      !!pathname &&
      pathname.startsWith("/api/") &&
      !COLD_START_ALLOWED_WRITES.has(pathname)
    ) {
      return coldStartReadOnlyResponse();
    }

    // Factory pages reuse a small set of shared ERP accounting/inventory APIs.
    // Mark every API request made while the browser is on a Factory route,
    // including raw fetch() calls, so the server can enforce the Factory page/tab
    // that owns the shared endpoint instead of trusting React visibility.
    let effectiveInit = init;
    if (writeScope) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      addCompanyMutationHeaders(headers, writeScope);
      effectiveInit = { ...init, headers, credentials: init?.credentials ?? "include" };
    }
    // The browser HTTP cache is also URL-keyed and must not reuse an API
    // representation from an earlier authenticated company session.
    if (readScope) effectiveInit = { ...effectiveInit, cache: "no-store" };
    const isFactoryUiRequest =
      !!pathname &&
      pathname.startsWith("/api/") &&
      pathname !== "/api/csrf-token" &&
      window.location.pathname.startsWith("/factory/");
    if (
      isFactoryUiRequest &&
      isFactoryAccountingRead(pathname, method) &&
      (factoryAccountingModuleAccess === false || !factoryPageOwnsSharedAccountingRead(window.location.pathname))
    ) {
      return emptyJsonArrayResponse();
    }
    if (
      isFactoryUiRequest &&
      isFactoryAccountsAllRead(pathname, method) &&
      (factoryAccountingModuleAccess === false || !factoryPageOwnsAccountsAllRead(window.location.pathname))
    ) {
      return emptyAccountsEnvelopeResponse();
    }

    if (isFactoryUiRequest) {
      const factoryHeaders = new Headers(effectiveInit?.headers || (input instanceof Request ? input.headers : undefined));
      factoryHeaders.set("X-App-Mode", "factory");
      factoryHeaders.set("X-Factory-Page", window.location.pathname);
      effectiveInit = { ...effectiveInit, headers: factoryHeaders };
      if (effectiveInit.credentials === undefined) effectiveInit.credentials = "include";
    }

    // Tag same-origin API work with this loaded tab's realtime identity. The
    // server uses it only for mutation types whose local cache is already
    // updated, so it can avoid immediately echoing the same work back over WS.
    if (pathname?.startsWith("/api/") && pathname !== "/api/csrf-token") {
      const realtimeHeaders = new Headers(
        effectiveInit?.headers || (input instanceof Request ? input.headers : undefined)
      );
      realtimeHeaders.set("X-Realtime-Client-Id", getRealtimeClientId());
      effectiveInit = { ...effectiveInit, headers: realtimeHeaders };
      if (effectiveInit.credentials === undefined) effectiveInit.credentials = "include";
    }

    const applyReferenceMutation = async (response: Response) => {
      if (!referenceMutationQueryClient || !pathname) return;
      if (writeScope) {
        try {
          assertCompanyMutationSnapshot(writeScope);
        } catch {
          // The server may already have committed an original-company write.
          // Do not update the *new* company's cache, but preserve its real
          // response so the operator does not mistakenly submit it twice.
          return;
        }
      }
      try {
        await applyReferenceMutationResponse({
          client: referenceMutationQueryClient,
          method,
          pathname,
          response,
        });
      } catch (error) {
        // Cache invalidation must not turn a successful server write into a
        // client failure or trigger a duplicate POST.
        console.warn("[Company] Failed to refresh mutation cache.", error);
      }
    };

    let attemptedMutationWrite = false;
    try {
      const isStateChanging = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
      const isApi = !!pathname && pathname.startsWith("/api/") && pathname !== "/api/csrf-token";

      if (isStateChanging && isApi) {
        const existingHeaders = new Headers(
          effectiveInit?.headers || (input instanceof Request ? input.headers : undefined)
        );
        if (!existingHeaders.has("x-csrf-token")) {
          const token = await ensureCsrfToken();
          if (token) {
            existingHeaders.set("X-CSRF-Token", token);
            const newInit: RequestInit = { ...effectiveInit, headers: existingHeaders };
            if (newInit.credentials === undefined) newInit.credentials = "include";
            assertCompanyMutationSnapshot(writeScope);
            attemptedMutationWrite = true;
            const res = await originalFetch(input, newInit);
            await applyReferenceMutation(res);

            // If the server rejected our token (stale after restart/session regen),
            // clear the cache, fetch a fresh token, and retry exactly once.
            if (!isRetry && res.status === 403) {
              try {
                const clone = res.clone();
                const body = await clone.json();
                if (body?.code === "CSRF_TOKEN_MISMATCH") {
                  resetCsrfToken();
                  return fetchWithCsrf(input, init, true, writeScope);
                }
              } catch {
                /* not JSON — not a CSRF error */
              }
            }
            // Verify session before redirecting — a business 401 must not log users out.
            await handlePossibleSessionExpiry(res, pathname, originalFetch);
            return res;
          }
        }
      }
    } catch (error) {
      // A network exception after sending a voucher/payment has an unknown
      // commit outcome. Never resend it through the fallback path.
      if (attemptedMutationWrite) throw error;
    }
    // GET requests may fall back to a verified per-user/company snapshot only
    // after a real transport failure or the known offline service worker 503.
    // Never replace 401/403/ordinary server failures with cached business data.
    // The try/catch above intentionally tolerates CSRF interceptor failures.
    // A company scope change must never fall through to an unscoped retry.
    assertCompanyMutationSnapshot(writeScope);
    const exactReadUrl = method === "GET" && typeof input === "string" && input.startsWith("/api/") ? input : null;
    const fromOfflineRead = async (): Promise<Response | null> => {
      if (!OFFLINE_MODE_ENABLED || !exactReadUrl || effectiveInit?.signal?.aborted) return null;
      const { readColdStartIdentityResponse, readPreparedOfflineResponse } = await import("./offline/offlineReadCache");
      // A read-only cold start (plan batch 5) also answers the identity reads from its sealed ticket.
      const cached =
        readColdStartIdentityResponse(method, exactReadUrl) ??
        (await readPreparedOfflineResponse(method, exactReadUrl));
      if (readScope) assertCompanyReadSnapshot(readScope);
      return cached;
    };
    let fallbackRes: Response;
    try {
      fallbackRes = await originalFetch(input, effectiveInit);
      if (readScope) assertCompanyReadSnapshot(readScope);
    } catch (error) {
      const networkFailure =
        error instanceof TypeError || (error instanceof DOMException && error.name === "NetworkError");
      if (networkFailure) {
        const cached = await fromOfflineRead();
        if (cached) return cached;
      }
      throw error;
    }
    if (OFFLINE_MODE_ENABLED && exactReadUrl && fallbackRes.status === 503) {
      const { isServiceWorkerOfflineResponse } = await import("./offline/offlineReadCache");
      if (await isServiceWorkerOfflineResponse(fallbackRes)) {
        const cached = await fromOfflineRead();
        if (cached) return cached;
      }
    }
    await applyReferenceMutation(fallbackRes);
    await handlePossibleSessionExpiry(fallbackRes, pathname, originalFetch);
    if (readScope) assertCompanyReadSnapshot(readScope);
    return fallbackRes;
  }

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => fetchWithCsrf(input, init);
}

/**
 * Credential-bearing writes — manager discount approvals, password changes — use this
 * variant. It deliberately has no offline-queue fallback: the secret in `data` is never
 * written to localStorage, and an offline device fails fast with the network error the
 * operator must retry while connected.
 */
export async function apiRequestPrivileged(
  method: string,
  url: string,
  data?: unknown | undefined,
  timeoutMs = 60000,
  _isRetry = false
): Promise<Response> {
  assertCreateOnlyRequestAllowed(method, url);
  const actionScope = captureCompanyMutationSnapshot(method, new URL(url, "http://localhost").pathname);
  const prepared = await prepareApiRequest(method, url, data, timeoutMs);

  try {
    assertCompanyMutationSnapshot(actionScope);
    const res = await fetch(prepared.url, prepared.init);

    clearTimeout(prepared.timeoutId);

    // Retry once with a fresh token, as apiRequest does. Without the guard a server
    // that keeps rejecting the token turned one approval into an endless request loop.
    if (!_isRetry && (await isCsrfTokenMismatch(res))) {
      assertPreparedCompanyMutationStillCurrent(prepared.init.headers);
      assertCompanyMutationSnapshot(actionScope);
      resetCsrfToken();
      return apiRequestPrivileged(method, url, data, timeoutMs, true);
    }

    await throwIfResNotOk(res);
    return res;
  } catch (error) {
    clearTimeout(prepared.timeoutId);
    if (getErrorDetails(error).name === "AbortError" && prepared.didTimeout()) {
      throw new Error(`Request timeout after ${Math.round(timeoutMs / 1000)} seconds for ${method} ${url}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Returns a TanStack Query predicate that matches any query whose first key
 * starts with the given prefix string.  Use this when the query key is a
 * URL-with-params (e.g. "/api/factory/customer-orders?status=LOADING") because
 * a bare prefix key like ["/api/factory/customer-orders"] does NOT match such
 * keys in TanStack Query v5.
 *
 * Usage:
 *   queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
 */
export function keyStartsWith(prefix: string) {
  return (query: { queryKey: readonly unknown[] }) =>
    typeof query.queryKey[0] === "string" && (query.queryKey[0] as string).startsWith(prefix);
}

/**
 * Invalidate the container offload and inventory views. Editing a container's
 * duty / transport / office charge voucher re-prices the offloaded bales on the
 * server, so the offload detail and inventory cost per bale must refetch.
 */
export function invalidateContainerLandedCostQueries() {
  queryClient.invalidateQueries({ predicate: keyStartsWith("/api/offloads") });
  queryClient.invalidateQueries({ predicate: keyStartsWith("/api/containers") });
  queryClient.invalidateQueries({ predicate: keyStartsWith("/api/inventory") });
  queryClient.invalidateQueries({ predicate: keyStartsWith("/api/location-inventory") });
}

export function invalidateCustomerBalances(customerId?: number | string) {
  // Customers list (factory + ERP)
  queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customers") });
  queryClient.invalidateQueries({ predicate: keyStartsWith("/api/customers") });
  // Accounts list / ledger balance / pre-period
  queryClient.invalidateQueries({ predicate: keyStartsWith("/api/accounts") });
  // Voucher list (caller may also invalidate detail key directly)
  queryClient.invalidateQueries({ predicate: keyStartsWith("/api/vouchers") });
  if (customerId !== undefined && customerId !== null) {
    queryClient.invalidateQueries({
      queryKey: ["/api/factory/customers", customerId, "statement"],
    });
  }
}

referenceMutationQueryClient = queryClient;
installPermissionRevalidationListener(queryClient);

export const STABLE_REFERENCE_QUERY_PREFIXES = STABLE_REFERENCE_API_ENDPOINTS;
export const STABLE_SETTINGS_QUERY_PREFIXES = STABLE_SETTINGS_API_ENDPOINTS;
export const ACCESS_QUERY_PREFIXES = ACCESS_API_ENDPOINTS;

for (const prefix of STABLE_REFERENCE_QUERY_PREFIXES) {
  queryClient.setQueryDefaults([prefix], stableReferenceQueryPolicy);
}
for (const prefix of STABLE_SETTINGS_QUERY_PREFIXES) {
  queryClient.setQueryDefaults([prefix], stableSettingsQueryPolicy);
}
for (const prefix of ACCESS_QUERY_PREFIXES) {
  queryClient.setQueryDefaults([prefix], accessQueryPolicy);
}
