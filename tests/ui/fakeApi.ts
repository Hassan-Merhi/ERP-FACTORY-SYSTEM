/**
 * A route-table fake for `fetch`, the one boundary every client request crosses:
 * React Query's default queryFn, `apiRequest`, the CSRF bootstrap and the raw
 * `fetch()` calls in legacy pages all end there. Page tests that used
 * `stubFetch()` only ever saw empty arrays, so loaded-data and error paths never
 * ran. Register the responses a test needs instead:
 *
 *   const api = installFakeApi();
 *   api.get("/api/customers", [buildCustomer()]);
 *   api.get("/api/customers/:id", ({ params }) => buildCustomer({ id: Number(params.id) }));
 *   api.post("/api/vouchers", ({ body }) => respond(201, { id: 9, ...body }));
 *   api.get("/api/stock-items", respond(500, { message: "boom" }));
 *   ...
 *   expect(api.callsTo("POST", "/api/vouchers")[0].body).toMatchObject({ amount: "10.00" });
 *
 * Patterns match the path only (query string ignored) and support `:param`
 * segments, a trailing `*`, or a RegExp. When several routes match, the one
 * registered last wins, so a test can override a suite-level default. Requests
 * no route matches answer 200 `[]`, as `stubFetch()` did, and are recorded in
 * `api.unhandled`; pass `{ onUnhandled: "error" }` to answer them 404 instead.
 * The fake replaces `globalThis.fetch` after client/src/lib/queryClient.ts has
 * wrapped it, so that wrapper (CSRF injection for raw fetch() writes, the
 * expired-session block) does not run in front of it — exactly as with
 * `stubFetch()`. `apiRequest` adds its own CSRF header, so its writes still carry
 * one. Test the wrapper itself against the real window.fetch.
 *
 * Importing this module registers a file-level `afterEach` that puts the real
 * `fetch` back, so `installFakeApi()` is safe in a test body or a `beforeEach`.
 */
import { afterEach, vi } from "vitest";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FakeRequest {
  method: HttpMethod;
  url: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Headers;
  body: unknown;
}

export interface FakeResponse {
  readonly __fakeResponse: true;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A JSON-serialisable body, or `respond(...)` for a specific status. */
type Reply = FakeResponse | object | string | number | boolean | null;
// Spelled out rather than `unknown` so a handler function is contextually typed.
export type FakeHandler = Reply | ((request: FakeRequest) => Reply | Promise<Reply>);

const installed: Array<() => void> = [];

afterEach(() => {
  // Newest first, so the original fetch is what remains.
  while (installed.length > 0) installed.pop()!();
});

interface Route {
  method: HttpMethod;
  match: (path: string) => Record<string, string> | null;
  handler: FakeHandler;
}

export interface FakeApiOptions {
  onUnhandled?: "empty" | "error";
}

/** A reply with an explicit status, for errors and non-200 successes. */
export function respond(status: number, body: unknown = null, headers?: Record<string, string>): FakeResponse {
  return { __fakeResponse: true, status, body, headers };
}

function isFakeResponse(value: unknown): value is FakeResponse {
  return typeof value === "object" && value !== null && (value as FakeResponse).__fakeResponse === true;
}

function compile(pattern: string | RegExp): Route["match"] {
  if (pattern instanceof RegExp) {
    return (path) => {
      const found = pattern.exec(path);
      return found ? { ...found.groups } : null;
    };
  }
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        names.push(segment.slice(1));
        return "([^/]+)";
      }
      if (segment === "*") return ".*";
      return segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  const regex = new RegExp(`^${source}/?$`);
  return (path) => {
    const found = regex.exec(path);
    if (!found) return null;
    return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(found[index + 1])]));
  };
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined;
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function toResponse(reply: Reply): Response {
  const { status, body, headers } = isFakeResponse(reply) ? reply : { status: 200, body: reply, headers: undefined };
  const noBody = status === 204 || status === 304;
  return new Response(noBody ? null : JSON.stringify(body ?? null), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function installFakeApi(options: FakeApiOptions = {}) {
  const routes: Route[] = [];
  const calls: FakeRequest[] = [];
  const unhandled: FakeRequest[] = [];
  const originalFetch = globalThis.fetch;

  const on = (method: HttpMethod, pattern: string | RegExp, handler: FakeHandler) => {
    routes.push({ method, match: compile(pattern), handler });
    return api;
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(rawUrl, "http://localhost");
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() as HttpMethod;
    const request: FakeRequest = {
      method,
      url: rawUrl,
      path: parsed.pathname,
      query: parsed.searchParams,
      params: {},
      headers: new Headers(init.headers),
      body: parseBody(init.body),
    };
    calls.push(request);

    for (let index = routes.length - 1; index >= 0; index -= 1) {
      const route = routes[index];
      if (route.method !== method) continue;
      const params = route.match(request.path);
      if (!params) continue;
      request.params = params;
      const reply = typeof route.handler === "function" ? await route.handler(request) : route.handler;
      return toResponse(reply);
    }

    unhandled.push(request);
    return toResponse(
      options.onUnhandled === "error" ? respond(404, { message: `No fake for ${method} ${request.path}` }) : []
    );
  });

  const api = {
    fetch: fetchMock,
    calls,
    unhandled,
    get: (pattern: string | RegExp, handler: FakeHandler) => on("GET", pattern, handler),
    post: (pattern: string | RegExp, handler: FakeHandler) => on("POST", pattern, handler),
    put: (pattern: string | RegExp, handler: FakeHandler) => on("PUT", pattern, handler),
    patch: (pattern: string | RegExp, handler: FakeHandler) => on("PATCH", pattern, handler),
    delete: (pattern: string | RegExp, handler: FakeHandler) => on("DELETE", pattern, handler),
    /** Requests whose method and path match, in the order they were made. */
    callsTo: (method: HttpMethod, pattern: string | RegExp) => {
      const match = compile(pattern);
      return calls.filter((call) => call.method === method && match(call.path) !== null);
    },
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };

  // Writes fetch a CSRF token first; answer it so every POST/PUT/PATCH/DELETE does
  // not need its own route. A test can still override it.
  api.get("/api/csrf-token", { csrfToken: "test-csrf-token" });

  globalThis.fetch = fetchMock as typeof fetch;
  installed.push(api.restore);
  return api;
}

export type FakeApi = ReturnType<typeof installFakeApi>;
