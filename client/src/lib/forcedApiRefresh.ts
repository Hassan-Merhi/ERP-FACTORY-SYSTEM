import "./liveQueryRuntimePolicy";

const MANUAL_REFRESH_WINDOW_MS = 500;
let manualRefreshUntil = 0;

function isRequestInput(input: RequestInfo | URL): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input, window.location.origin);
    if (input instanceof URL) return new URL(input.toString(), window.location.origin);
    if (isRequestInput(input)) return new URL(input.url, window.location.origin);
    return null;
  } catch {
    return null;
  }
}

function isApiGet(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method || (isRequestInput(input) ? input.method : "GET")).toUpperCase();
  if (method !== "GET") return false;
  return requestUrl(input)?.pathname.startsWith("/api/") === true;
}

export function isManualRefreshControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest<HTMLElement>("button, [role='button']");
  if (!control) return false;
  if (control.dataset.forceApiRefresh === "true") return true;
  const testId = control.dataset.testid || "";
  return testId === "button-refresh" || testId.startsWith("button-refresh-");
}

export function markManualRefresh(now = Date.now()): void {
  manualRefreshUntil = Math.max(manualRefreshUntil, now + MANUAL_REFRESH_WINDOW_MS);
}

export function isManualRefreshWindowActive(now = Date.now()): boolean {
  return now <= manualRefreshUntil;
}

export function forcedRefreshRequestInput(input: RequestInfo | URL): RequestInfo | URL {
  const url = requestUrl(input);
  if (!url) return input;
  url.searchParams.set("__refresh", "1");

  if (isRequestInput(input)) return new Request(url.toString(), input);
  if (input instanceof URL) return url;
  return url.toString();
}

export function forcedRefreshRequestInit(input: RequestInfo | URL, init?: RequestInit): RequestInit {
  return {
    ...(init ?? {}),
    headers: init?.headers || (isRequestInput(input) ? input.headers : undefined),
    cache: "reload",
  };
}

export function installForcedApiRefresh(): void {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof window.fetch !== "function") return;
  const state = window as unknown as Window & typeof globalThis & { __forcedApiRefreshInstalled?: boolean };
  if (state.__forcedApiRefreshInstalled) return;
  state.__forcedApiRefreshInstalled = true;

  document.addEventListener(
    "click",
    (event) => {
      if (isManualRefreshControl(event.target)) markManualRefresh();
    },
    true
  );

  // requestStormGuard is installed before this module. `cache: reload` makes its
  // browser-side guard bypass local reuse; `__refresh=1` is the server's existing
  // cache-bypass marker and avoids a custom-header CORS preflight on Capacitor.
  const guardedFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isManualRefreshWindowActive() || !isApiGet(input, init)) return guardedFetch(input, init);
    return guardedFetch(forcedRefreshRequestInput(input), forcedRefreshRequestInit(input, init));
  };
}

installForcedApiRefresh();
