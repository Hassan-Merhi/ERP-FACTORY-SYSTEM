const MANUAL_REFRESH_WINDOW_MS = 500;
let manualRefreshUntil = 0;

function isApiGet(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET") return false;

  try {
    const url =
      typeof input === "string"
        ? new URL(input, window.location.origin)
        : input instanceof URL
          ? new URL(input.toString(), window.location.origin)
          : new URL(input.url, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
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

export function installForcedApiRefresh(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
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

  // requestStormGuard is installed before this module. Feeding its wrapper an
  // explicit bypass header makes it skip the browser snapshot/coalescing path;
  // the same header reaches readMicrocache and skips the server cache too.
  const guardedFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isManualRefreshWindowActive() || !isApiGet(input, init)) return guardedFetch(input, init);

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("x-bypass-request-storm-guard", "1");
    return guardedFetch(input, {
      ...(init ?? {}),
      headers,
      cache: "reload",
    });
  };
}

installForcedApiRefresh();
