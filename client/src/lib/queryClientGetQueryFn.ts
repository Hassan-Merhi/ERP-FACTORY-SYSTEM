// Extracted from ./queryClient.ts to keep that module under the source-size cap.
import { CreateOnlyActionNotAvailableError, isCreateOnlyClientWriteBlocked } from "./createOnlyRequestGuard";
import { isPermissionDenial, requestPermissionRevalidation } from "./permissionRevalidation";
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { QueryCache, QueryClient, QueryFunction } from "@tanstack/react-query";
import { staleTimeForQueryKey } from "./queryPolicies";
import { isAbortError } from "./abortError";
import { assertCompanyReadSnapshot, captureCompanyReadSnapshot, isCompanyOwnedApiRead } from "./companyCacheScope";
import {
  AUTH_PATHS,
  _CAPACITOR_API_BASE,
  _redirectFn,
  getAppDate,
  globalMutationCache,
  resetCsrfToken,
  type UnauthorizedBehavior,
} from "./queryClientGetAppDate";

/* ── Session-expiry redirect ─────────────────────────────────────────────── */
// Single-fire: only after /api/auth/me confirms the session is truly gone do
// we redirect to /login. This prevents false logouts caused by business
// endpoints that legitimately return 401 (permission-based, POS-gated, etc.)
// while the user's session is still perfectly valid.
export let _sessionExpiredHandled = false;

function scheduleSessionExpiredRedirect() {
  if (_sessionExpiredHandled) return;
  if (typeof window !== "undefined") {
    // Don't redirect when already on the login page — avoids loops from
    // wrong-password 401s and initial unauthenticated loads.
    const path = window.location.pathname;
    if (path === "/login" || path.startsWith("/login/")) return;
  }

  // Flip the gate before doing any async cleanup. From this point onward the
  // global fetch interceptor rejects protected API work locally, so mounted
  // pollers/heartbeats cannot keep generating 401 traffic while navigation
  // to the login page is still settling.
  _sessionExpiredHandled = true;
  void import("./offline/offlineReadCache").then(({ revokeOfflineReadScope }) => revokeOfflineReadScope());
  resetCsrfToken();
  void queryClient.cancelQueries();

  // Test hook: avoids needing a browser environment.
  if (_redirectFn) {
    _redirectFn("/login");
    return;
  }
  if (typeof window === "undefined") return;
  window.location.replace("/login");
}

// ── Session verification (prevents false logout on business 401s) ──────────
// A shared promise ensures multiple simultaneous 401 responses only trigger
// ONE /api/auth/me check. Uses originalFetch directly to bypass the patched
// window.fetch and avoid an infinite interception loop.
let _sessionVerificationPromise: Promise<boolean> | null = null;

export async function verifySessionExpired(originalFetch: typeof window.fetch): Promise<boolean> {
  if (_sessionVerificationPromise) return _sessionVerificationPromise;
  _sessionVerificationPromise = (async () => {
    try {
      const res = await originalFetch("/api/auth/me", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      // Only treat a confirmed 401 as session expiry.
      // 5xx / network errors / 502 proxy restarts → do NOT log the user out.
      return res.status === 401;
    } catch {
      // Network failure or timeout — never log the user out speculatively.
      return false;
    } finally {
      _sessionVerificationPromise = null;
    }
  })();
  return _sessionVerificationPromise;
}

export async function handlePossibleSessionExpiry(
  response: Response,
  pathname: string | null,
  originalFetch: typeof window.fetch
): Promise<void> {
  if (response.status !== 401) return;
  if (!pathname?.startsWith("/api/")) return;
  if (AUTH_PATHS.has(pathname)) return;
  if (_sessionExpiredHandled) return;
  const expired = await verifySessionExpired(originalFetch);
  if (expired) scheduleSessionExpiredRedirect();
}

/** @internal – reset state between tests only */
export function _testOnly_resetSessionExpired() {
  _sessionExpiredHandled = false;
  _sessionVerificationPromise = null;
}

export async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = await res.text();
    let errorData;
    try {
      errorData = JSON.parse(text);
    } catch {
      // If the body is an HTML page (e.g. a Render/proxy 502 error page) don't
      // dump raw markup into the toast — show a clean status-code message instead.
      const isHtml = text.trimStart().startsWith("<");
      const fallback = isHtml
        ? `Server error (${res.status}${res.statusText ? ` – ${res.statusText}` : ""}). Please try again.`
        : text || res.statusText;
      errorData = { message: fallback };
    }

    // Preserve structured API error fields without mass-assigning response data.
    const error: Error &
      ClientErrorLike & {
        status?: number;
        requiresConfirmation?: unknown;
        employeeBalance?: unknown;
        ledgerBalance?: unknown;
        notInProforma?: unknown;
        overloaded?: unknown;
        previous?: unknown;
      } = new Error(errorData.message || res.statusText);
    error.status = res.status;
    error.code = errorData.code;
    // A role or permission refusal means this tab's access data may be stale;
    // refresh it here and in the other open tabs.
    if (isPermissionDenial(res.status, errorData.code, errorData.message)) {
      requestPermissionRevalidation(queryClient);
    }
    error.requiresConfirmation = errorData.requiresConfirmation;
    error.employeeBalance = errorData.employeeBalance;
    error.ledgerBalance = errorData.ledgerBalance;
    error.notInProforma = errorData.notInProforma;
    error.overloaded = errorData.overloaded;
    // Keep structured prior-confirmation data for pressing duplicate feedback.
    error.previous = errorData.previous;
    throw error;
  }
}

/** Active company role from the cached session, for the Create Only request guard. */
function cachedActiveRole(): string | null {
  const me = queryClient.getQueryData<{ role?: string | null; currentRole?: string | null }>(["/api/auth/me"]);
  return me?.currentRole ?? me?.role ?? null;
}

export function assertCreateOnlyRequestAllowed(method: string, url: string): void {
  if (isCreateOnlyClientWriteBlocked(cachedActiveRole(), method, url)) {
    throw new CreateOnlyActionNotAvailableError();
  }
}

export const getQueryFn: <T>(options: { on401: UnauthorizedBehavior }) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey, signal: querySignal }) => {
    // The queryKey is expected to be a single URL string as the first element
    const url = queryKey[0] as string;
    // Callers that genuinely need hidden system accounts request
    // ?includeHidden=true explicitly. Do not globally upgrade every Factory
    // ledger request: restricted Factory pages may legitimately have no Accounts
    // access, and the global rewrite caused avoidable 403s.
    const requestUrl = url;
    const readScope = isCompanyOwnedApiRead(requestUrl.split("?")[0]) ? captureCompanyReadSnapshot() : null;
    if (readScope) assertCompanyReadSnapshot(readScope);

    // Apply a 5-minute hard timeout so queries never hang indefinitely.
    // We race the caller's own signal (query cancellation) against our timeout.
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 300000);

    // Forward query-level cancellation (e.g. component unmount) into our controller
    querySignal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      // Capacitor: resolve to absolute URL when VITE_API_BASE_URL is set; no-op on web.
      const _apiUrl =
        _CAPACITOR_API_BASE && requestUrl.startsWith("/") ? `${_CAPACITOR_API_BASE}${requestUrl}` : requestUrl;
      const res = await fetch(_apiUrl, {
        credentials: "include",
        signal: controller.signal,
        headers: { "X-Client-Date": getAppDate() },
      });

      clearTimeout(timeoutId);

      if (unauthorizedBehavior === "returnNull" && res.status === 401) {
        return null;
      }

      await throwIfResNotOk(res);
      const body: T = await res.json();
      // A body can finish parsing after its request has been cancelled or the
      // selected company changed. Never commit that body to a Query cache.
      if (readScope) assertCompanyReadSnapshot(readScope);
      return body;
    } catch (error) {
      clearTimeout(timeoutId);
      if (timedOut && getErrorDetails(error).name === "AbortError") {
        throw new Error(`Request timed out after 30 seconds: GET ${requestUrl}`, { cause: error });
      }
      throw error;
    }
  };

// ── Global query error handler ────────────────────────────────────────────
// TQ v5 is supposed to suppress AbortErrors when signal.aborted === true, but
// a race condition in our custom AbortController forwarding (controller wrapping
// querySignal) means the AbortError can reach query.state.error and permanently
// show error UI on every page.
//
// Fix: intercept AbortErrors in QueryCache.onError. If the query still has
// active observers (component is mounted), reset it back to pending and schedule
// a fresh fetch so the component recovers silently. If there are no observers
// (component unmounted), just remove the error so it doesn't flash on remount.
const globalQueryCache = new QueryCache({
  onError: (error: ClientErrorLike, query) => {
    // NOTE: 401 handling is intentionally NOT here. The global fetch interceptor
    // is the single source of session-expiry detection; it verifies /api/auth/me
    // before redirecting. Handling 401 here too would bypass that check and cause
    // false logouts on business endpoints that return 401 for non-session reasons.
    if (error?.name !== "AbortError") return;
    // A confirmed expired session intentionally cancels active queries. Do not
    // convert those cancellations back into refetches while the login redirect
    // is in progress.
    if (_sessionExpiredHandled) return;
    // Swallow — schedule a transparent recovery refetch if the component is still mounted
    const observerCount = query.getObserversCount();
    setTimeout(() => {
      if (observerCount > 0 && query.state.status === "error") {
        query.fetch();
      }
    }, 50);
  },
});

export const queryClient = new QueryClient({
  queryCache: globalQueryCache,
  mutationCache: globalMutationCache,
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      staleTime: (query) => staleTimeForQueryKey(query.queryKey),
      gcTime: 30 * 60 * 1000,
      // Failures are not retried — a 4xx/5xx is real and the page should say so.
      // An abort is different: the request was cancelled, by a page the user has
      // already left or by a request guard reclaiming a shared fetch, and
      // rendering it as a failure asks the user to act on something that never
      // failed. Retry those once so the query resolves instead of settling into
      // an error state nobody can clear without a page reload.
      retry: (failureCount, error) => isAbortError(error) && failureCount < 1,
      retryDelay: 250,
    },
    mutations: {
      retry: false,
    },
  },
});
