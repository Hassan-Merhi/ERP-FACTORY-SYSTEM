import type { QueryKey } from "@tanstack/react-query";
import { queryClient } from "./queryClient";

export async function forcedApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
  headers.set("x-bypass-request-storm-guard", "1");

  return fetch(input, {
    ...(init ?? {}),
    method: init?.method || (input instanceof Request ? input.method : "GET"),
    headers,
    cache: "reload",
  });
}

/**
 * Refresh an existing JSON React Query from the authenticated server instead of
 * accepting either the browser request-storm cache or the server read microcache.
 *
 * This is intentionally opt-in for explicit user actions only. Automatic
 * polling, WebSocket invalidations and normal navigation remain cache-friendly.
 */
export async function forceJsonQueryRefresh<T>(
  queryKey: QueryKey,
  requestUrl: string,
  init?: RequestInit
): Promise<T> {
  return queryClient.fetchQuery<T>({
    queryKey,
    staleTime: 0,
    queryFn: async () => {
      const response = await forcedApiFetch(requestUrl, {
        credentials: "include",
        ...(init ?? {}),
      });
      if (!response.ok) throw new Error(`Forced refresh failed: ${response.status}`);
      return response.json() as Promise<T>;
    },
  });
}
