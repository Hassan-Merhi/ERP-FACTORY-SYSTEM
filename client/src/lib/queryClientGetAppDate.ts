// Extracted from ./queryClient.ts to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { MutationCache } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import {
  addCompanyMutationHeaders,
  assertCompanyMutationSnapshot,
  captureCompanyMutationSnapshot,
} from "./companyCacheScope";

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

export async function ensureCsrfToken(): Promise<string | null> {
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
export const _CAPACITOR_API_BASE: string = (import.meta.env?.VITE_API_BASE_URL as string) || "";

/** @internal – injected by unit tests to observe redirects without a browser */
export let _redirectFn: ((href: string) => void) | null = null;

// Routes that must never trigger session verification to avoid recursion or
// interfering with the login flow itself.
export const AUTH_PATHS = new Set(["/api/auth/me", "/api/auth/login", "/api/auth/logout", "/api/csrf-token"]);

export function expiredSessionResponse(): Response {
  return new Response(JSON.stringify({ message: "Session expired", code: "SESSION_EXPIRED" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export let factoryAccountingModuleAccess: boolean | null = null;

export function setFactoryAccountingModuleAccess(allowed: boolean | null): void {
  factoryAccountingModuleAccess = allowed;
}

export function isFactoryAccountingRead(pathname: string | null, method: string): boolean {
  if (method !== "GET" || !pathname) return false;
  return pathname === "/api/ledger-accounts" || pathname === "/api/bank-accounts";
}

export function isFactoryAccountsAllRead(pathname: string | null, method: string): boolean {
  return method === "GET" && pathname === "/api/accounts/all";
}

export function emptyJsonArrayResponse(): Response {
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function emptyAccountsEnvelopeResponse(): Response {
  return new Response(JSON.stringify({ accounts: [], asOfDate: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** @internal – inject a redirect observer for unit tests (no browser required) */
export function _testOnly_setRedirectFn(fn: ((href: string) => void) | null) {
  _redirectFn = fn;
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

export function isNetworkError(error: unknown): boolean {
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

interface PreparedApiRequest {
  /** Capacitor: resolved absolute URL when VITE_API_BASE_URL is set; unchanged on web. */
  url: string;
  init: RequestInit;
  timeoutId: ReturnType<typeof setTimeout>;
  didTimeout: () => boolean;
}

/** Shared request preparation for both the queueable and the privileged fetch paths. */
export async function prepareApiRequest(
  method: string,
  url: string,
  data: unknown,
  timeoutMs: number
): Promise<PreparedApiRequest> {
  // The expected company belongs to the original action, before awaiting
  // CSRF or anything else that could allow another tab to change the session.
  const upMethod = method.toUpperCase();
  const isStateChanging = upMethod !== "GET" && upMethod !== "HEAD" && upMethod !== "OPTIONS";
  const pathname = new URL(url, "http://localhost").pathname;
  const companyScope = captureCompanyMutationSnapshot(upMethod, pathname);
  const controller = new AbortController();
  let intentionalAbort = false;
  const timeoutId = setTimeout(() => {
    intentionalAbort = true;
    controller.abort();
  }, timeoutMs);

  try {
    const body = data ? JSON.stringify(data) : undefined;
    const csrfToken = isStateChanging ? await ensureCsrfToken() : null;
    // A token refresh may take time. A late callback must never silently post
    // the old company's voucher while the next company is being selected.
    assertCompanyMutationSnapshot(companyScope);
    if (controller.signal.aborted) throw new DOMException("Request timed out.", "AbortError");
    const headers = new Headers({
      ...(data ? { "Content-Type": "application/json" } : {}),
      "X-Client-Date": getAppDate(),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    });
    addCompanyMutationHeaders(headers, companyScope);

    const _apiUrl = _CAPACITOR_API_BASE && url.startsWith("/") ? `${_CAPACITOR_API_BASE}${url}` : url;
    const init: RequestInit = {
      method,
      headers,
      body,
      credentials: "include",
      signal: controller.signal,
      // Logout must survive an immediate tab/browser close after the click.
      keepalive: upMethod === "POST" && url === "/api/auth/logout",
    };
    return { url: _apiUrl, init, timeoutId, didTimeout: () => intentionalAbort };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * True when the server rejected a stale CSRF token (after a server restart / session
 * regeneration on Render). The caller clears the cached token and retries exactly once.
 */
export async function isCsrfTokenMismatch(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const errBody = await res.clone().json();
    return errBody?.code === "CSRF_TOKEN_MISMATCH";
  } catch {
    return false;
  }
}

export type UnauthorizedBehavior = "returnNull" | "throw";

// Global mutation error handler — catches OfflineQueued for every mutation
// so individual pages don't need to duplicate the offline toast logic.
// Pages that need extra offline behaviour (BaleStockEntry, Vouchers) still
// run their own onError AFTER this; they should skip another toast by checking
// error._handledGlobally.
export const globalMutationCache = new MutationCache({
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
