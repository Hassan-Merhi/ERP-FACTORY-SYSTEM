/**
 * The rest of client/src/lib/queryClient.ts: what happens when the CSRF token
 * cannot be fetched, how apiRequest, apiRequestPrivileged and the query
 * function time out or cancel, how the query cache recovers from a stray
 * AbortError while the page is still mounted, and how a mutation saved
 * offline is announced once for every page.
 */
import { QueryObserver } from "@tanstack/react-query";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ toast }));

type Network = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;
type QueryClientModule = typeof import("@/lib/queryClient");

const realFetch = window.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Never answers; rejects with an AbortError once the request is aborted. */
function hanging(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
}

async function loadWith(network: Network): Promise<QueryClientModule> {
  window.fetch = network as unknown as typeof fetch;
  return import("@/lib/queryClient");
}

beforeEach(() => {
  vi.resetModules();
  toast.mockClear();
  delete (window as { __csrfFetchPatched?: boolean }).__csrfFetchPatched;
  window.history.replaceState({}, "", "/dashboard");
});

afterEach(() => {
  window.fetch = realFetch;
  delete (window as { __csrfFetchPatched?: boolean }).__csrfFetchPatched;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CSRF token unavailable", () => {
  it.each([
    ["refused", () => json({}, 500)],
    ["without a token", () => json({ token: "wrong-field" })],
    [
      "unreachable",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])("still sends a raw write when the token endpoint is %s", async (_label, tokenAnswer) => {
    const network: Network = vi.fn(async (input) => {
      if (String(input) === "/api/csrf-token") return tokenAnswer();
      return json({ ok: true });
    });
    await loadWith(network);

    const response = await window.fetch("/api/notes", { method: "POST", body: "{}" });

    expect(response.ok).toBe(true);
    const write = network.mock.calls.find(([input]) => String(input) === "/api/notes")!;
    expect(new Headers(write[1]?.headers).has("x-csrf-token")).toBe(false);
  });
});

describe("timeouts and cancellation", () => {
  const network = (): Network =>
    vi.fn(async (input, init) => (String(input) === "/api/csrf-token" ? json({ csrfToken: "t" }) : hanging(init)));

  it("apiRequest gives up with a timeout message", async () => {
    const client = await loadWith(network());

    await expect(client.apiRequest("POST", "/api/notes", { a: 1 }, false, 30)).rejects.toThrow(
      "Request timeout after 0 seconds for POST /api/notes"
    );
  });

  it("apiRequestPrivileged gives up with a timeout message", async () => {
    const client = await loadWith(network());

    await expect(client.apiRequestPrivileged("POST", "/api/auth/change-password", {}, 30)).rejects.toThrow(
      "Request timeout after 0 seconds for POST /api/auth/change-password"
    );
  });

  it("the query function times out after five minutes", async () => {
    const client = await loadWith(network());
    vi.useFakeTimers();
    const queryFn = client.getQueryFn({ on401: "throw" });

    const pending = queryFn({ queryKey: ["/api/slow"] } as never);
    const settled = expect(pending).rejects.toThrow("Request timed out after 30 seconds: GET /api/slow");
    await vi.advanceTimersByTimeAsync(300_000);
    await settled;
  });

  it("the query function stops when the query is cancelled", async () => {
    const client = await loadWith(network());
    const controller = new AbortController();
    const queryFn = client.getQueryFn({ on401: "throw" });

    const pending = queryFn({ queryKey: ["/api/slow"], signal: controller.signal } as never);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("global caches", () => {
  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

  it("quietly refetches a mounted query that failed with a stray AbortError", async () => {
    const client = await loadWith(vi.fn(async () => json([])));
    let attempts = 0;
    const observer = new QueryObserver(client.queryClient, {
      queryKey: ["/api/recover"],
      queryFn: async () => {
        attempts += 1;
        if (attempts === 1) throw abortError();
        return ["ok"];
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => expect(client.queryClient.getQueryData(["/api/recover"])).toEqual(["ok"]));
    expect(attempts).toBe(2);
    unsubscribe();
    client.queryClient.clear();
  });

  it("does not refetch a mounted query that failed for a real reason", async () => {
    const client = await loadWith(vi.fn(async () => json([])));
    const failing = vi.fn(async () => {
      throw new Error("Server error");
    });
    const observer = new QueryObserver(client.queryClient, {
      queryKey: ["/api/real-failure"],
      queryFn: failing,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe("error"));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(failing).toHaveBeenCalledTimes(1);
    unsubscribe();
    client.queryClient.clear();
  });

  it("leaves other query errors and unmounted queries alone", async () => {
    const client = await loadWith(vi.fn(async () => json([])));
    const failing = vi.fn(async () => {
      throw new Error("Server error");
    });
    const aborting = vi.fn(async () => {
      throw abortError();
    });

    await client.queryClient.fetchQuery({ queryKey: ["/api/fails"], queryFn: failing, retry: false }).catch(() => {});
    await client.queryClient.fetchQuery({ queryKey: ["/api/aborts"], queryFn: aborting, retry: false }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(failing).toHaveBeenCalledTimes(1);
    expect(aborting).toHaveBeenCalledTimes(1);
    client.queryClient.clear();
  });

  it("announces a mutation saved offline once, with its description", async () => {
    const client = await loadWith(vi.fn(async () => json([])));
    const offline = Object.assign(new Error("Saved offline"), { name: "OfflineQueued", description: "Bale entry" });
    const plain = Object.assign(new Error("Saved offline"), { name: "OfflineQueued" });

    for (const error of [offline, plain, new Error("Rejected")]) {
      await client.queryClient
        .getMutationCache()
        .build(client.queryClient, {
          mutationFn: async () => {
            throw error;
          },
        })
        .execute(undefined)
        .catch(() => {});
    }

    expect(toast.mock.calls.map(([arg]) => arg.description)).toEqual([
      "Bale entry saved — will sync automatically when connected",
      "Action saved — will sync automatically when connected",
    ]);
    expect((offline as { _handledGlobally?: boolean })._handledGlobally).toBe(true);
  });
});
