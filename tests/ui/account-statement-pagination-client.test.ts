import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENDPOINT = "/api/accounts/ledger/17/transactions";

let underlyingFetch: ReturnType<typeof vi.fn>;
let intervalSpy: ReturnType<typeof vi.spyOn>;
let paginationModule: typeof import("../../client/src/lib/accountStatementPaginationClient");

function sentUrl(call: unknown[]): URL {
  const input = call[0];
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  return new URL(raw, "http://localhost");
}

function pageResponse(overrides: Record<string, unknown> = {}): Response {
  return {
    ok: true,
    status: 200,
    clone() {
      return this;
    },
    json: async () => ({
      transactions: [{ id: 1 }],
      total: 240,
      page: 1,
      limit: 100,
      totalPages: 3,
      periodDebitTotal: 125.5,
      periodCreditTotal: 40.25,
      closingNetBalance: 85.25,
      ...overrides,
    }),
  } as unknown as Response;
}

function resetRouteState(): void {
  window.history.replaceState({}, "", "/outside-accounts");
  window.dispatchEvent(new PopStateEvent("popstate"));
  document.querySelector("#erp-account-statement-pagination")?.remove();
  window.history.replaceState({}, "", "/accounts");
}

beforeAll(async () => {
  window.history.replaceState({}, "", "/accounts");
  delete window.__erpAccountStatementPaginationInstalled;
  underlyingFetch = vi.fn(async () => pageResponse());
  window.fetch = underlyingFetch as unknown as typeof window.fetch;
  intervalSpy = vi.spyOn(globalThis, "setInterval");
  paginationModule = await import("../../client/src/lib/accountStatementPaginationClient");
});

beforeEach(() => {
  resetRouteState();
  underlyingFetch.mockClear();
  underlyingFetch.mockImplementation(async () => pageResponse());
});

afterEach(() => {
  resetRouteState();
});

afterAll(() => {
  intervalSpy.mockRestore();
});

describe("account statement compatibility client", () => {
  it("keeps an unmigrated request bounded without rendering pagination controls", async () => {
    await window.fetch(`${ENDPOINT}?fromDate=2026-01-01`);

    const url = sentUrl(underlyingFetch.mock.calls[0]);
    expect(url.searchParams.get("pagination")).toBe("1");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(paginationModule.getAccountStatementPaginationSnapshot()).toMatchObject({
      total: 240,
      page: 1,
      limit: 100,
      totalPages: 3,
      periodDebitTotal: 125.5,
      periodCreditTotal: 40.25,
      closingNetBalance: 85.25,
    });
    expect(document.querySelector('[data-testid="account-statement-pagination"]')).toBeNull();
    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it("passes Wave 3 continuous requests through without injecting legacy page state", async () => {
    await window.fetch(ENDPOINT);
    expect(paginationModule.getAccountStatementPaginationSnapshot()).not.toBeNull();

    underlyingFetch.mockClear();
    await window.fetch(`${ENDPOINT}?continuous=1&limit=250&cursor=next-token`);

    const url = sentUrl(underlyingFetch.mock.calls[0]);
    expect(url.searchParams.get("continuous")).toBe("1");
    expect(url.searchParams.get("cursor")).toBe("next-token");
    expect(url.searchParams.get("limit")).toBe("250");
    expect(url.searchParams.has("pagination")).toBe(false);
    expect(url.searchParams.has("page")).toBe(false);
    expect(paginationModule.getAccountStatementPaginationSnapshot()).toBeNull();
  });

  it("leaves unrelated endpoints and non-GET requests untouched", async () => {
    await window.fetch("/api/accounts/ledger/17/summary");
    await window.fetch(ENDPOINT, { method: "POST" });

    expect(sentUrl(underlyingFetch.mock.calls[0]).searchParams.has("pagination")).toBe(false);
    expect(sentUrl(underlyingFetch.mock.calls[1]).searchParams.has("pagination")).toBe(false);
  });

  it("notifies subscribers and clears the snapshot when leaving accounts", async () => {
    const listener = vi.fn();
    const unsubscribe = paginationModule.subscribeAccountStatementPagination(listener);

    await window.fetch(ENDPOINT);
    expect(listener).toHaveBeenCalledTimes(1);

    window.history.replaceState({}, "", "/dashboard");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(paginationModule.getAccountStatementPaginationSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("passes failed and malformed responses through without corrupting compatibility metadata", async () => {
    underlyingFetch.mockImplementationOnce(async () => ({ ok: false, status: 503 }) as unknown as Response);
    const failed = await window.fetch(ENDPOINT);
    expect(failed.status).toBe(503);
    expect(paginationModule.getAccountStatementPaginationSnapshot()).toBeNull();

    underlyingFetch.mockImplementationOnce(
      async () =>
        ({
          ok: true,
          status: 200,
          clone() {
            return this;
          },
          json: async () => {
            throw new Error("invalid payload");
          },
        }) as unknown as Response
    );
    const malformed = await window.fetch(ENDPOINT);
    expect(malformed.ok).toBe(true);
    expect(paginationModule.getAccountStatementPaginationSnapshot()).toBeNull();
  });
});
