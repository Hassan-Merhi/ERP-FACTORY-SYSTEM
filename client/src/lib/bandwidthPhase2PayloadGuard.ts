import type { QueryClient } from "@tanstack/react-query";
import { queryClient } from "./queryClient";

const resolvedQueryClient: QueryClient = queryClient;

function resolveUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input, window.location.origin);
    if (input instanceof URL) return new URL(input.toString(), window.location.origin);
    if (input instanceof Request) return new URL(input.url, window.location.origin);
  } catch {
    return null;
  }
  return null;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function isInventoryOtwUrl(url: URL): boolean {
  return url.pathname === "/inventory" && url.searchParams.get("tab") === "on-the-way";
}

function isInventoryOtwTab(): boolean {
  return isInventoryOtwUrl(new URL(window.location.href));
}

function isProfiledQuery(query: { queryKey: readonly unknown[] }): boolean {
  const first = query.queryKey[0];
  if (typeof first !== "string") return false;
  const pathname = first.split("?")[0];
  return (
    pathname === "/api/containers" ||
    pathname === "/api/containers/otw-items" ||
    pathname === "/api/inventory" ||
    /^\/api\/containers\/\d+$/.test(pathname)
  );
}

function clearProfiledQueries(): void {
  const clear = (client: QueryClient | null) => {
    client?.removeQueries({ predicate: isProfiledQuery });
  };

  clear(resolvedQueryClient);
}

function installNavigationCacheIsolation(): void {
  let lastWasOtw = isInventoryOtwTab();
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  window.history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
    const nextUrl = url == null ? new URL(window.location.href) : new URL(String(url), window.location.href);
    const nextWasOtw = isInventoryOtwUrl(nextUrl);
    if (nextWasOtw !== lastWasOtw) clearProfiledQueries();
    originalPushState(data, unused, url);
    lastWasOtw = nextWasOtw;
  };

  window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
    const nextUrl = url == null ? new URL(window.location.href) : new URL(String(url), window.location.href);
    const nextWasOtw = isInventoryOtwUrl(nextUrl);
    if (nextWasOtw !== lastWasOtw) clearProfiledQueries();
    originalReplaceState(data, unused, url);
    lastWasOtw = nextWasOtw;
  };

  window.addEventListener("popstate", () => {
    const nextWasOtw = isInventoryOtwTab();
    if (nextWasOtw !== lastWasOtw) clearProfiledQueries();
    lastWasOtw = nextWasOtw;
  });
}

function profileFor(url: URL): string | null {
  if (url.pathname === "/api/containers") return "otw-summary";
  if (url.pathname === "/api/containers/otw-items") return "stock-otw";
  if (
    url.pathname === "/api/inventory" &&
    url.searchParams.get("page") === "1" &&
    url.searchParams.get("pageSize") === "100"
  ) {
    return "combined";
  }
  if (/^\/api\/containers\/\d+$/.test(url.pathname)) return "combined-detail";
  return null;
}

function rewriteInput(input: RequestInfo | URL, url: URL): RequestInfo | URL {
  if (typeof input === "string") {
    return input.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  }
  if (input instanceof URL) return url;
  if (input instanceof Request) return new Request(url.toString(), input);
  return input;
}

export function installBandwidthPhase2PayloadGuard(): void {
  if (
    typeof window === "undefined" ||
    (window as unknown as (Window & typeof globalThis) & { __bandwidthPhase2PayloadGuardInstalled: boolean })
      .__bandwidthPhase2PayloadGuardInstalled
  )
    return;
  (
    window as unknown as (Window & typeof globalThis) & { __bandwidthPhase2PayloadGuardInstalled: true }
  ).__bandwidthPhase2PayloadGuardInstalled = true;

  installNavigationCacheIsolation();
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (requestMethod(input, init) !== "GET" || !isInventoryOtwTab()) {
      return originalFetch(input, init);
    }

    const url = resolveUrl(input);
    if (!url || !url.pathname.startsWith("/api/")) return originalFetch(input, init);

    const profile = profileFor(url);
    if (!profile || url.searchParams.has("profile")) return originalFetch(input, init);

    url.searchParams.set("profile", profile);
    return originalFetch(rewriteInput(input, url), init);
  };
}

installBandwidthPhase2PayloadGuard();
