/**
 * clientObservability reports browser crashes to the server: it tags API
 * requests with an X-Request-Id, remembers the last one the server echoed so a
 * report can be joined to its server log, and turns window errors and
 * unhandled rejections into rate-limited, de-duplicated reports. These cases
 * check what it sends, and what it deliberately does not.
 */
type Network = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;
type Observability = typeof import("@/lib/clientObservability");

const ENDPOINT = "/api/auth/observability/client-error";
const realFetch = window.fetch;
const addedListeners: Array<[string, EventListenerOrEventListenerObject]> = [];
let now = 1_000_000;

function reports(network: Network): Array<Record<string, unknown>> {
  return network.mock.calls
    .filter(([input]) => String(input) === ENDPOINT)
    .map(([, init]) => JSON.parse(String(init?.body)));
}

async function load(network: Network = vi.fn(async () => new Response("{}"))): Promise<Observability> {
  window.fetch = network as unknown as typeof fetch;
  return import("@/lib/clientObservability");
}

beforeEach(() => {
  vi.resetModules();
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  // Each fresh import installs window listeners; track them so a test's
  // listeners cannot report the next test's events.
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type: string, listener: any, options?: any) => {
    addedListeners.push([type, listener]);
    add(type, listener, options);
  });
  window.history.replaceState({}, "", "/vouchers?tab=journal");
});

afterEach(() => {
  for (const [type, listener] of addedListeners.splice(0)) window.removeEventListener(type, listener);
  window.fetch = realFetch;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("client error reports", () => {
  it("posts the error with its route, trimmed fields and the last echoed request id", async () => {
    const network: Network = vi.fn(async () => new Response("{}", { headers: { "X-Request-Id": "req-42" } }));
    const observability = await load(network);
    observability.installClientObservability();
    await window.fetch("/api/customers");

    observability.reportClientError({
      source: "react_error_boundary",
      message: `  ${"x".repeat(2_100)}  `,
      stack: "Error: boom\n    at Page",
      componentStack: "   ",
    });

    const [report] = reports(network);
    expect(report).toMatchObject({
      source: "react_error_boundary",
      route: "/vouchers?tab=journal",
      stack: "Error: boom\n    at Page",
      lastRequestId: "req-42",
    });
    expect(report.message).toHaveLength(2_000);
    expect(report).not.toHaveProperty("componentStack");
    const [, init] = network.mock.calls.find(([input]) => String(input) === ENDPOINT)!;
    expect(init).toMatchObject({ method: "POST", credentials: "include", keepalive: true });
  });

  it("drops a report with no message", async () => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);

    observability.reportClientError({ source: "manual", message: "   " });

    expect(reports(network)).toEqual([]);
  });

  it("sends the same error once per minute, then again after the window", async () => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);
    const report = { source: "manual" as const, message: "Same failure" };

    observability.reportClientError(report);
    observability.reportClientError(report);
    expect(reports(network)).toHaveLength(1);

    now += 60_001;
    observability.reportClientError(report);
    expect(reports(network)).toHaveLength(2);
  });

  it("treats the same message on another route as a different error", async () => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);

    observability.reportClientError({ source: "manual", message: "Same failure" });
    window.history.replaceState({}, "", "/stock");
    observability.reportClientError({ source: "manual", message: "Same failure" });

    expect(reports(network).map((report) => report.route)).toEqual(["/vouchers?tab=journal", "/stock"]);
  });

  it("sends at most ten distinct reports a minute", async () => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);

    for (let index = 0; index < 12; index += 1) {
      observability.reportClientError({ source: "manual", message: `Failure ${index}` });
    }
    expect(reports(network)).toHaveLength(10);

    now += 60_000;
    observability.reportClientError({ source: "manual", message: "Failure after the window" });
    expect(reports(network)).toHaveLength(11);
  });

  it("never lets a failed report post throw into the page", async () => {
    const network: Network = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const observability = await load(network);

    expect(() => observability.reportClientError({ source: "manual", message: "offline" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("installed browser hooks", () => {
  it("tags API requests with a request id but leaves non-API and the report endpoint alone", async () => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);
    observability.installClientObservability();

    await window.fetch("/api/customers");
    await window.fetch("/api/customers", { headers: { "X-Request-Id": "caller-id" } });
    await window.fetch("/assets/logo.svg");
    await window.fetch(ENDPOINT, { method: "POST", body: "{}" });

    const ids = network.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-Request-Id"));
    expect(ids[0]).toMatch(/.+/);
    expect(ids.slice(1)).toEqual(["caller-id", null, null]);
  });

  it("installs its hooks only once", async () => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);

    observability.installClientObservability();
    const wrapped = window.fetch;
    observability.installClientObservability();

    expect(window.fetch).toBe(wrapped);
  });

  it("reports an uncaught window error", async () => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);
    observability.installClientObservability();

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("Cannot read properties of undefined") }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));

    expect(reports(network).map((report) => [report.source, report.message])).toEqual([
      ["window_error", "Cannot read properties of undefined"],
      ["window_error", "Script error."],
    ]);
  });

  function rejection(reason: unknown): PromiseRejectionEvent {
    const event = new Event("unhandledrejection", { cancelable: true }) as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", { value: reason });
    return event;
  }

  it("reports an unhandled rejection", async () => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);
    observability.installClientObservability();

    window.dispatchEvent(rejection(new Error("Voucher save failed")));
    window.dispatchEvent(rejection("plain string reason"));

    expect(reports(network).map((report) => report.message)).toEqual(["Voucher save failed", "plain string reason"]);
  });

  it("silences the expected 401 from the session probe on the login page", async () => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);
    observability.installClientObservability();

    const event = rejection({ status: 401, url: "/api/auth/me", message: "Unauthorized" });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(reports(network)).toEqual([]);
  });

  it.each([
    "TypeError: Failed to fetch dynamically imported module: /assets/Page.js",
    "ChunkLoadError: Loading chunk 42 failed.",
    "Unable to preload CSS for /assets/page.css",
  ])("does not report a stale-deploy chunk failure: %s", async (message) => {
    const network: Network = vi.fn(async () => new Response("{}"));
    const observability = await load(network);
    observability.installClientObservability();

    window.dispatchEvent(rejection(new Error(message)));

    expect(reports(network)).toEqual([]);
  });
});

describe("isExpectedUnauthenticatedProbe", () => {
  it.each([
    [{ status: 401, url: "/api/auth/me" }, true],
    [{ status: 401, message: "GET /api/auth/me failed" }, true],
    [{ status: 401, message: "Failed to load authenticated user (401)" }, true],
    [{ status: 401, url: "/api/vouchers" }, false],
    [{ status: 403, url: "/api/auth/me" }, false],
    ["401 /api/auth/me", false],
    [null, false],
  ])("%j → %s", async (value, expected) => {
    const observability = await load();
    expect(observability.isExpectedUnauthenticatedProbe(value)).toBe(expected);
  });
});
