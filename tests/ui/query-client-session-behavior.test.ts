/**
 * client/src/lib/queryClient.ts wraps window.fetch once, at import. That wrapper
 * decides when a 401 means "logged out" (only after /api/auth/me confirms it),
 * stops protected traffic once it does, attaches CSRF tokens to raw writes,
 * and keeps Factory pages from reading accounting data they do not own. These
 * cases drive the wrapper the way the app does — through window.fetch — over a
 * fake network, and check what reaches it and what the caller gets back.
 */
type Network = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;
type QueryClientModule = typeof import("@/lib/queryClient");

const realFetch = window.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function paths(network: Network): string[] {
  return network.mock.calls.map(([input]) => String(input).split("?")[0]);
}

function header(network: Network, call: number, name: string): string | null {
  return new Headers(network.mock.calls[call][1]?.headers).get(name);
}

/**
 * A network that answers /api/auth/me with `authMeStatus` (or throws when it is
 * "offline"), /api/csrf-token with a token, and everything else from `routes`.
 */
function fakeNetwork(routes: Record<string, () => Response> = {}, authMeStatus: number | "offline" = 200): Network {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    if (path === "/api/auth/me") {
      if (authMeStatus === "offline") throw new TypeError("Failed to fetch");
      return json({ id: "u1" }, authMeStatus);
    }
    if (path === "/api/csrf-token") return json({ csrfToken: `token-${Date.now()}` });
    return routes[path]?.() ?? json([]);
  });
}

async function loadWith(network: Network): Promise<{ client: QueryClientModule; redirects: string[] }> {
  window.fetch = network as unknown as typeof fetch;
  const client = await import("@/lib/queryClient");
  const redirects: string[] = [];
  client._testOnly_setRedirectFn((href) => redirects.push(href));
  return { client, redirects };
}

beforeEach(() => {
  vi.resetModules();
  delete (window as any).__csrfFetchPatched;
  window.history.replaceState({}, "", "/dashboard");
});

afterEach(() => {
  window.fetch = realFetch;
  delete (window as any).__csrfFetchPatched;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("queryClient fetch wrapper — session expiry", () => {
  it("keeps the user signed in when a business endpoint answers 401 but the session is valid", async () => {
    const network = fakeNetwork({ "/api/pos/discount-approval": () => json({ message: "Not allowed" }, 401) });
    const { client, redirects } = await loadWith(network);

    const response = await window.fetch("/api/pos/discount-approval");

    expect(response.status).toBe(401);
    expect(paths(network)).toEqual(["/api/pos/discount-approval", "/api/auth/me"]);
    expect(redirects).toEqual([]);
    expect(client._testOnly_isSessionTrafficBlocked()).toBe(false);
  });

  it("redirects to /login once /api/auth/me confirms the session is gone, then blocks protected traffic", async () => {
    const network = fakeNetwork({ "/api/vouchers": () => json({ message: "Unauthorized" }, 401) }, 401);
    const { client, redirects } = await loadWith(network);

    await window.fetch("/api/vouchers");
    expect(redirects).toEqual(["/login"]);
    expect(client._testOnly_isSessionTrafficBlocked()).toBe(true);

    const blocked = await window.fetch("/api/customers");
    expect(blocked.status).toBe(401);
    await expect(blocked.json()).resolves.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(paths(network)).not.toContain("/api/customers");

    // The login flow itself still reaches the server.
    await window.fetch("/api/auth/login", { method: "POST", body: "{}" });
    expect(paths(network)).toContain("/api/auth/login");
  });

  it("checks /api/auth/me once for a burst of simultaneous 401s and redirects once", async () => {
    const network = fakeNetwork({ "/api/vouchers": () => json({}, 401) }, 401);
    const { redirects } = await loadWith(network);

    await Promise.all([window.fetch("/api/vouchers"), window.fetch("/api/vouchers"), window.fetch("/api/vouchers")]);

    expect(paths(network).filter((path) => path === "/api/auth/me")).toHaveLength(1);
    expect(redirects).toEqual(["/login"]);
  });

  it.each([
    ["the server is unreachable", "offline" as const],
    ["/api/auth/me fails with a 5xx", 502],
  ])("never logs the user out when %s", async (_label, authMeStatus) => {
    const network = fakeNetwork({ "/api/vouchers": () => json({}, 401) }, authMeStatus);
    const { client, redirects } = await loadWith(network);

    await window.fetch("/api/vouchers");

    expect(redirects).toEqual([]);
    expect(client._testOnly_isSessionTrafficBlocked()).toBe(false);
  });

  it("does not redirect while the user is already on the login page", async () => {
    window.history.replaceState({}, "", "/login");
    const network = fakeNetwork({ "/api/vouchers": () => json({}, 401) }, 401);
    const { client, redirects } = await loadWith(network);

    await window.fetch("/api/vouchers");

    expect(redirects).toEqual([]);
    expect(client._testOnly_isSessionTrafficBlocked()).toBe(false);
  });

  it("does not verify the session for a 401 from the auth endpoints themselves", async () => {
    const network = fakeNetwork({ "/api/auth/login": () => json({ message: "Wrong password" }, 401) });
    await loadWith(network);

    await window.fetch("/api/auth/login", { method: "POST", body: "{}" });

    expect(paths(network)).not.toContain("/api/auth/me");
  });

  it("verifies the session after a write that comes back 401", async () => {
    const network = fakeNetwork({ "/api/vouchers": () => json({}, 401) }, 401);
    const { redirects } = await loadWith(network);

    await window.fetch("/api/vouchers", { method: "POST", body: "{}" });

    expect(redirects).toEqual(["/login"]);
  });
});

describe("queryClient fetch wrapper — CSRF for raw writes", () => {
  it("attaches the CSRF token to a raw fetch() write and fetches the token only once", async () => {
    const network = fakeNetwork();
    await loadWith(network);

    await window.fetch("/api/notes", { method: "POST", body: "{}" });
    await window.fetch("/api/notes", { method: "PUT", body: "{}" });

    expect(paths(network)).toEqual(["/api/csrf-token", "/api/notes", "/api/notes"]);
    expect(header(network, 1, "X-CSRF-Token")).toMatch(/^token-/);
    expect(header(network, 2, "X-CSRF-Token")).toBe(header(network, 1, "X-CSRF-Token"));
  });

  it("refreshes a stale token and retries a rejected raw write exactly once", async () => {
    let attempts = 0;
    const network = fakeNetwork({
      "/api/notes": () => (++attempts === 1 ? json({ code: "CSRF_TOKEN_MISMATCH" }, 403) : json({ ok: true })),
    });
    await loadWith(network);

    const response = await window.fetch("/api/notes", { method: "POST", body: "{}" });

    expect(response.status).toBe(200);
    expect(paths(network)).toEqual(["/api/csrf-token", "/api/notes", "/api/csrf-token", "/api/notes"]);
  });

  it("returns the second CSRF rejection instead of retrying again", async () => {
    const network = fakeNetwork({ "/api/notes": () => json({ code: "CSRF_TOKEN_MISMATCH" }, 403) });
    await loadWith(network);

    const response = await window.fetch("/api/notes", { method: "POST", body: "{}" });

    expect(response.status).toBe(403);
    expect(paths(network).filter((path) => path === "/api/notes")).toHaveLength(2);
  });

  it("keeps an explicit X-CSRF-Token and leaves GETs without one", async () => {
    const network = fakeNetwork();
    await loadWith(network);

    await window.fetch("/api/notes", { method: "POST", body: "{}", headers: { "X-CSRF-Token": "caller-token" } });
    await window.fetch("/api/notes");

    expect(paths(network)).toEqual(["/api/notes", "/api/notes"]);
    expect(header(network, 0, "X-CSRF-Token")).toBe("caller-token");
    expect(header(network, 1, "X-CSRF-Token")).toBeNull();
  });
});

describe("queryClient fetch wrapper — Factory pages", () => {
  it("tags API requests made from a Factory page with the app mode and page", async () => {
    window.history.replaceState({}, "", "/factory/vouchers");
    const network = fakeNetwork();
    await loadWith(network);

    await window.fetch("/api/factory/customers");

    expect(header(network, 0, "X-App-Mode")).toBe("factory");
    expect(header(network, 0, "X-Factory-Page")).toBe("/factory/vouchers");
  });

  it("answers shared accounting reads locally on a Factory page that does not own them", async () => {
    window.history.replaceState({}, "", "/factory/bale-stock-entry");
    const network = fakeNetwork();
    await loadWith(network);

    const ledger = await window.fetch("/api/ledger-accounts");
    const accounts = await window.fetch("/api/accounts/all");

    await expect(ledger.json()).resolves.toEqual([]);
    await expect(accounts.json()).resolves.toEqual({ accounts: [], asOfDate: null });
    expect(network).not.toHaveBeenCalled();
  });

  it("lets an owning Factory page read them, unless accounting access is switched off", async () => {
    window.history.replaceState({}, "", "/factory/vouchers");
    const network = fakeNetwork();
    const { client } = await loadWith(network);

    await window.fetch("/api/ledger-accounts");
    expect(paths(network)).toEqual(["/api/ledger-accounts"]);

    client.setFactoryAccountingModuleAccess(false);
    const denied = await window.fetch("/api/ledger-accounts");
    await expect(denied.json()).resolves.toEqual([]);
    expect(paths(network)).toEqual(["/api/ledger-accounts"]);
  });

  it("does not tag requests from non-Factory pages", async () => {
    const network = fakeNetwork();
    await loadWith(network);

    await window.fetch("/api/customers");

    expect(header(network, 0, "X-App-Mode")).toBeNull();
  });
});

describe("queryClient request helpers", () => {
  it("apiRequest retries once on a CSRF mismatch with a fresh token", async () => {
    let attempts = 0;
    const network = fakeNetwork({
      "/api/customers": () => (++attempts === 1 ? json({ code: "CSRF_TOKEN_MISMATCH" }, 403) : json({ id: 3 }, 201)),
    });
    const { client } = await loadWith(network);

    const response = await client.apiRequest("POST", "/api/customers", { legalName: "Atlas" });

    expect(response.status).toBe(201);
    expect(attempts).toBe(2);
  });

  it("apiRequest surfaces a second CSRF mismatch as an error", async () => {
    const network = fakeNetwork({
      "/api/customers": () => json({ code: "CSRF_TOKEN_MISMATCH", message: "bad token" }, 403),
    });
    const { client } = await loadWith(network);

    await expect(client.apiRequest("POST", "/api/customers", {})).rejects.toThrow(/bad token/);
  });

  it("apiRequestPrivileged sends the write and retries a single CSRF mismatch", async () => {
    let attempts = 0;
    const network = fakeNetwork({
      "/api/pos/manager-approval": () =>
        ++attempts === 1 ? json({ code: "CSRF_TOKEN_MISMATCH" }, 403) : json({ approved: true }),
    });
    const { client } = await loadWith(network);

    const response = await client.apiRequestPrivileged("POST", "/api/pos/manager-approval", { pin: "1234" });

    await expect(response.json()).resolves.toEqual({ approved: true });
    expect(attempts).toBe(2);
  });

  it("apiRequestPrivileged gives up after one retry when the token keeps being rejected", async () => {
    let attempts = 0;
    const network = fakeNetwork({
      "/api/pos/manager-approval": () => {
        attempts += 1;
        // An unbounded retry never yields to the timer queue, so the test timeout
        // cannot stop it; fail the request instead of hanging the run.
        if (attempts > 5) throw new Error("retried without limit");
        return json({ code: "CSRF_TOKEN_MISMATCH", message: "bad token" }, 403);
      },
    });
    const { client } = await loadWith(network);

    await expect(client.apiRequestPrivileged("POST", "/api/pos/manager-approval", { pin: "1" })).rejects.toThrow(
      /bad token/
    );
    expect(attempts).toBe(2);
  });

  it("apiRequestPrivileged reports a server error without queueing it", async () => {
    const network = fakeNetwork({ "/api/auth/change-password": () => json({ message: "Too weak" }, 400) });
    const { client } = await loadWith(network);

    await expect(client.apiRequestPrivileged("POST", "/api/auth/change-password", { password: "x" })).rejects.toThrow(
      /Too weak/
    );
  });

  it("the query function returns null for a 401 when asked to", async () => {
    const network = fakeNetwork({ "/api/auth/status": () => json({}, 401) });
    const { client } = await loadWith(network);

    const queryFn = client.getQueryFn({ on401: "returnNull" });

    await expect(queryFn({ queryKey: ["/api/auth/status"] } as never)).resolves.toBeNull();
  });

  it("getAppDate formats today in the company timezone and ignores an invalid one", async () => {
    const { client } = await loadWith(fakeNetwork());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T22:30:00.000Z"));
    try {
      client.setAppTimezone("Asia/Beirut");
      expect(client.getAppDate()).toBe("2026-03-02");
      client.setAppTimezone("America/Los_Angeles");
      expect(client.getAppDate()).toBe("2026-03-01");
      client.setAppTimezone("Not/AZone");
      expect(client.getAppDate()).toBe(new Date().toLocaleDateString("en-CA"));
    } finally {
      client.setAppTimezone(null);
      vi.useRealTimers();
    }
  });

  it("keyStartsWith matches URL-with-params keys by prefix only", async () => {
    const { client } = await loadWith(fakeNetwork());
    const matches = client.keyStartsWith("/api/factory/customer-orders");

    expect(matches({ queryKey: ["/api/factory/customer-orders?status=LOADING"] })).toBe(true);
    expect(matches({ queryKey: ["/api/factory/customers"] })).toBe(false);
    expect(matches({ queryKey: [42] })).toBe(false);
  });

  it("invalidates the customer balance and landed-cost views it names", async () => {
    const { client } = await loadWith(fakeNetwork());
    const keys = [
      ["/api/factory/customers"],
      ["/api/customers?active=true"],
      ["/api/accounts/all"],
      ["/api/vouchers?page=1"],
      ["/api/factory/customers", 7, "statement"],
      ["/api/offloads/3"],
      ["/api/containers?status=OTW"],
      ["/api/inventory/summary"],
      ["/api/location-inventory/2"],
      ["/api/stock-groups"],
    ];
    for (const key of keys) client.queryClient.setQueryData(key, []);

    client.invalidateCustomerBalances(7);
    client.invalidateContainerLandedCostQueries();

    const invalidated = keys.filter((key) => client.queryClient.getQueryState(key)?.isInvalidated);
    expect(invalidated).toEqual(keys.slice(0, -1));
  });
});
