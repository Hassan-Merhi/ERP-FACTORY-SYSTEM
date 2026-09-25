import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { QueryClient, QueryFunction, MutationCache, QueryCache } from "@tanstack/react-query";
import { isSafeToQueue, enqueueRequest, getDescriptionForRequest } from "./offlineQueue";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";
import { toast } from "@/hooks/use-toast";
import {
  ACCESS_API_ENDPOINTS,
  STABLE_REFERENCE_API_ENDPOINTS,
  STABLE_SETTINGS_API_ENDPOINTS,
  accessQueryPolicy,
  stableReferenceQueryPolicy,
  stableSettingsQueryPolicy,
  staleTimeForQueryKey,
} from "./queryPolicies";
import { applyReferenceMutationResponse } from "./referenceMutationCache";
import { isAbortError } from "./abortError";
import { getRealtimeClientId } from "./realtimeClientIdentity";
import { resolveFactoryPageKey } from "@shared/factoryAccessRegistry";

/* ── Timezone-aware date utility ───────────────────────────────────────────── */
// Stores the configured timezone for the current company.
// Defaults to the browser's local timezone so behaviour is unchanged until a
// company timezone is explicitly saved.
let _appTimezone: string | null = null;

/** Call this whenever company settings are loaded to configure the app timezone. */
export function setAppTimezone(tz: string | null | undefined) {
  _appTimezone = tz || null;
}

/* ── CSRF token plumbing ─────────────────────────────────────────────────── */
// Synchronizer-token CSRF protection. The token is fetched from the server
// once per session and attached to every state-changing request as
// X-CSRF-Token. Enforcement is on by default; set CSRF_ENFORCE=0 to
// switch to warn-only mode (logs mismatches but does not block requests).
let _csrfToken: string | null = null;
let _csrfFetchPromise: Promise<string | null> | null = null;

async function fetchCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch("/api/csrf-token", { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.csrfToken === "string" ? data.csrfToken : null;
  } catch {
    return null;
  }
}

async function ensureCsrfToken(): Promise<string | null> {
  if (_csrfToken) return _csrfToken;
  if (!_csrfFetchPromise) {
    _csrfFetchPromise = fetchCsrfToken().then((tok) => {
      _csrfToken = tok;
      _csrfFetchPromise = null;
      return tok;
    });
  }
  return _csrfFetchPromise;
}

/** Reset the cached CSRF token (call on logout or auth state change). */
export function resetCsrfToken() {
  _csrfToken = null;
  _csrfFetchPromise = null;
}

/* ── Capacitor API base URL ──────────────────────────────────────────────── */
// Set VITE_API_BASE_URL at Capacitor build time, e.g. "https://your-server.com".
// Empty string in all web builds — every code path below falls back unchanged.
const _CAPACITOR_API_BASE: string = (import.meta.env?.VITE_API_BASE_URL as string) || "";

/* ── Session-expiry redirect ─────────────────────────────────────────────── */
// Single-fire: only after /api/auth/me confirms the session is truly gone do
// we redirect to /login. This prevents false logouts caused by business
// endpoints that legitimately return 401 (permission-based, POS-gated, etc.)
// while the user's session is still perfectly valid.
let _sessionExpiredHandled = false;
/** @internal – injected by unit tests to observe redirects without a browser */
let _redirectFn: ((href: string) => void) | null = null;

function scheduleSessionExpiredRedirect() {
  if (_sessionExpiredHandled) return;
  // Test hook: avoids needing a browser environment.
  if (_redirectFn) {
    _sessionExpiredHandled = true;
    _redirectFn("/login");
    return;
  }
  if (typeof window === "undefined") return;
  // Don't redirect when already on the login page — avoids loops from
  // wrong-password 401s and initial unauthenticated loads.
  const path = window.location.pathname;
  if (path === "/login" || path.startsWith("/login/")) return;

  // Mark the expiry handled before navigation so later in-flight 401 responses
  // do not start another /api/auth/me verification request.
  _sessionExpiredHandled = true;
  resetCsrfToken();
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

// Routes that must never trigger session verification to avoid recursion or
// interfering with the login flow itself.
const AUTH_PATHS = new Set(["/api/auth/me", "/api/auth/login", "/api/auth/logout", "/api/csrf-token"]);

let referenceMutationQueryClient: QueryClient | null = null;
let factoryAccountingModuleAccess: boolean | null = null;

export function setFactoryAccountingModuleAccess(allowed: boolean | null): void {
  factoryAccountingModuleAccess = allowed;
}

const FACTORY_SHARED_ACCOUNTING_READ_OWNERS = new Set([
  "factory/accounts",
  "factory/vouchers",
  "factory/payroll-hub",
  "factory/import",
  "factory/settings",
  "factory/invoicing",
]);

function isFactoryAccountingRead(pathname: string | null, method: string): boolean {
  if (method !== "GET" || !pathname) return false;
  return pathname === "/api/ledger-accounts" || pathname === "/api/bank-accounts";
}

function factoryPageOwnsSharedAccountingRead(pathname: string | null): boolean {
  if (!pathname || typeof window === "undefined") return true;
  const currentPageKey = resolveFactoryPageKey(window.location.pathname);
  return currentPageKey !== null && FACTORY_SHARED_ACCOUNTING_READ_OWNERS.has(currentPageKey);
}

function emptyJsonArrayResponse(): Response {
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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
/** @internal – inject a redirect observer for unit tests (no browser required) */
export function _testOnly_setRedirectFn(fn: ((href: string) => void) | null) {
  _redirectFn = fn;
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

  async function fetchWithCsrf(input: RequestInfo | URL, init?: RequestInit, isRetry = false): Promise<Response> {
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

    // Factory pages reuse a small set of shared ERP accounting/inventory APIs.
    // Mark every API request made while the browser is on a Factory route,
    // including raw fetch() calls, so the server can enforce the Factory page/tab
    // that owns the shared endpoint instead of trusting React visibility.
    let effectiveInit = init;
    const isFactoryUiRequest =
      !!pathname &&
      pathname.startsWith("/api/") &&
      pathname !== "/api/csrf-token" &&
      window.location.pathname.startsWith("/factory/");
    if (
      isFactoryUiRequest &&
      isFactoryAccountingRead(pathname, method) &&
      (factoryAccountingModuleAccess === false || !factoryPageOwnsSharedAccountingRead(pathname))
    ) {
      return emptyJsonArrayResponse();
    }

    if (isFactoryUiRequest) {
      const factoryHeaders = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      factoryHeaders.set("X-App-Mode", "factory");
      factoryHeaders.set("X-Factory-Page", window.location.pathname);
      effectiveInit = { ...init, headers: factoryHeaders };
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
      await applyReferenceMutationResponse({
        client: referenceMutationQueryClient,
        method,
        pathname,
        response,
      });
    };

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
                  return fetchWithCsrf(input, init, true);
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
    } catch {
      // Never block a legitimate request because of interceptor errors
    }
    // GET (and other non-state-changing) requests fall through here.
    // Capture the response so we can detect session expiry on polling queries.
    const fallbackRes = await originalFetch(input, effectiveInit);
    await applyReferenceMutation(fallbackRes);
    // Verify session before redirecting — a business 401 must not log users out.
    await handlePossibleSessionExpiry(fallbackRes, pathname, originalFetch);
    return fallbackRes;
  }

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => fetchWithCsrf(input, init);
}

/**
 * Returns today's date string (YYYY-MM-DD) in the configured company timezone.
 * Falls back to the browser's local timezone if no company timezone is set.
 */
export function getAppDate(): string {
  const tz = _appTimezone;
  if (tz) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch {
      // Invalid timezone string — fall through to browser local
    }
  }
  return new Date().toLocaleDateString("en-CA");
}

async function throwIfResNotOk(res: Response) {
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
      } = new Error(errorData.message || res.statusText);
    error.status = res.status;
    error.code = errorData.code;
    error.requiresConfirmation = errorData.requiresConfirmation;
    error.employeeBalance = errorData.employeeBalance;
    error.ledgerBalance = errorData.ledgerBalance;
    error.notInProforma = errorData.notInProforma;
    error.overloaded = errorData.overloaded;
    throw error;
  }
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && error.name === "NetworkError") return true;
  const msg = getErrorDetails(error).optionalMessage ?? "";
  return (
    msg.includes("Load failed") ||
    msg.includes("Failed to fetch") ||
    msg.includes("Network request failed") ||
    msg.includes("NetworkError") ||
    msg.includes("network error")
  );
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  _isRetry = false,
  timeoutMs = 300000
): Promise<Response> {
  const controller = new AbortController();
  let intentionalAbort = false;
  const timeoutId = setTimeout(() => {
    intentionalAbort = true;
    controller.abort();
  }, timeoutMs);

  try {
    let body: string | undefined;
    if (data) {
      body = JSON.stringify(data);
    }

    // Attach CSRF token for state-changing methods.
    const upMethod = method.toUpperCase();
    const isStateChanging = upMethod !== "GET" && upMethod !== "HEAD" && upMethod !== "OPTIONS";
    const csrfToken = isStateChanging ? await ensureCsrfToken() : null;

    // Capacitor: resolve to absolute URL when VITE_API_BASE_URL is set; no-op on web.
    const _apiUrl = _CAPACITOR_API_BASE && url.startsWith("/") ? `${_CAPACITOR_API_BASE}${url}` : url;
    const res = await fetch(_apiUrl, {
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        "X-Client-Date": getAppDate(),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      body,
      credentials: "include",
      signal: controller.signal,
      // Logout must survive an immediate tab/browser close after the click.
      // keepalive asks the browser to finish this tiny request during unload.
      keepalive: upMethod === "POST" && url === "/api/auth/logout",
    });

    clearTimeout(timeoutId);

    // If the server rejected our CSRF token (stale after server restart /
    // session regeneration on Render), clear the cache and retry exactly once.
    if (!_isRetry && res.status === 403) {
      try {
        const clone = res.clone();
        const errBody = await clone.json();
        if (errBody?.code === "CSRF_TOKEN_MISMATCH") {
          resetCsrfToken();
          return apiRequest(method, url, data, true);
        }
      } catch {
        /* not JSON — fall through to normal error handling */
      }
    }

    await throwIfResNotOk(res);
    return res;
  } catch (error) {
    clearTimeout(timeoutId);
    if (getErrorDetails(error).name === "AbortError" && intentionalAbort) {
      throw new Error(`Request timeout after ${Math.round(timeoutMs / 1000)} seconds for ${method} ${url}`, {
        cause: error,
      });
    }
    const networkFail = getErrorDetails(error).name === "AbortError" ? true : isNetworkError(error);
    if (OFFLINE_MODE_ENABLED && networkFail && isSafeToQueue(method, url)) {
      const description = getDescriptionForRequest(url);
      const body = data ? JSON.stringify(data) : "";
      enqueueRequest(url, method, body, description, getAppDate());
      const offlineError = Object.assign(new Error(`Saved offline — will sync when connected`), { description });
      offlineError.name = "OfflineQueued";
      throw offlineError;
    }
    throw error;
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
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
      return await res.json();
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
    // Swallow — schedule a transparent recovery refetch if the component is still mounted
    const observerCount = query.getObserversCount();
    setTimeout(() => {
      if (observerCount > 0 && query.state.status === "error") {
        query.fetch();
      }
    }, 50);
  },
});

// Global mutation error handler — catches OfflineQueued for every mutation
// so individual pages don't need to duplicate the offline toast logic.
// Pages that need extra offline behaviour (BaleStockEntry, Vouchers) still
// run their own onError AFTER this; they should skip another toast by checking
// error._handledGlobally.
const globalMutationCache = new MutationCache({
  onError: (error: ClientErrorLike) => {
    if (error?.name === "OfflineQueued") {
      error._handledGlobally = true;
      const label = error.description ? `${error.description} saved` : "Action saved";
      toast({
        title: "Saved offline",
        description: `${label} — will sync automatically when connected`,
      });
    }
  },
});

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
 * Invalidate every query that depends on a customer's balance.
 *
 * Use this in any `useMutation.onSuccess` that creates / edits / deletes a
 * voucher, voucher entry, customer order, charge, finalize/un-finalize, or
 * any factory customer write.  It guarantees the Customers list, Accounts
 * page, ledger card, ledger transactions list, pre-period block, and the
 * customer statement all refresh together — eliminating the "balance updates
 * here but not there" UX.
 *
 * Pass the `customerId` only when known; without it we still invalidate
 * the broad list keys.
 */
// ─── Stock-item invalidation helpers ─────────────────────────────────────────
/**
 * Invalidate lightweight stock-item selector caches after a mutation that adds,
 * removes, or renames a stock item.  Only invalidates active queries so the
 * 649 KB full-list endpoint is never triggered.
 */
export function invalidateStockItemLight(companyId?: number | string): void {
  // Exact-key invalidation: only the lightweight endpoint, optionally scoped.
  queryClient.invalidateQueries({
    queryKey: ["/api/stock-items/light", companyId],
    refetchType: "active",
  });
  // Also cover callers that stored companyId as undefined (still the same session).
  if (companyId !== undefined) {
    queryClient.invalidateQueries({
      queryKey: ["/api/stock-items/light", undefined],
      refetchType: "active",
    });
  }
}

/**
 * Invalidate paginated management-page stock-item queries.
 * Pass `refetchType: "active"` (default) to only refresh currently-mounted
 * management pages.
 */
export function invalidateStockItemPageQueries(): void {
  // Matches ["/api/stock-items", { page, ... }] keys used by the management page.
  // Does NOT match ["/api/stock-items/light", ...] because the first element differs.
  queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      return (
        typeof key[0] === "string" &&
        key[0] === "/api/stock-items" &&
        key.length > 1 &&
        typeof key[1] === "object" &&
        key[1] !== null
      );
    },
    refetchType: "active",
  });
}

/**
 * Convenience: invalidate both light dropdowns and paginated management pages.
 * Use after any stock-item mutation (create / edit / delete / import / bulk op).
 */
export function invalidateStockItems(companyId?: number | string): void {
  invalidateStockItemLight(companyId);
  invalidateStockItemPageQueries();
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

referenceMutationQueryClient = queryClient;

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
