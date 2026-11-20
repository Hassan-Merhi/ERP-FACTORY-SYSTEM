import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly_resetCompanyCacheScope,
  activateCompanyCacheScope,
  beginCompanyCacheTransition,
  rememberVerifiedServerCompanyRevision,
} from "../../client/src/lib/companyCacheScope";
import { prepareApiRequest, resetCsrfToken } from "../../client/src/lib/queryClientGetAppDate";

beforeEach(() => {
  _testOnly_resetCompanyCacheScope();
  resetCsrfToken();
});

afterEach(() => {
  _testOnly_resetCompanyCacheScope();
  resetCsrfToken();
  vi.unstubAllGlobals();
});

describe("Phase 5 browser write transport", () => {
  it("stamps the original verified company on vouchers and factory payment writes", async () => {
    activateCompanyCacheScope(4);
    rememberVerifiedServerCompanyRevision(4, "session-4-revision");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    for (const endpoint of ["/api/vouchers", "/api/factory/supplier-payments"]) {
      const prepared = await prepareApiRequest("POST", endpoint, { amount: 10 }, 10000);
      const headers = new Headers(prepared.init.headers);
      expect(headers.get("X-Expected-Company-Id")).toBe("4");
      expect(headers.get("X-Expected-Company-Revision")).toBe("session-4-revision");
      expect(headers.get("X-CSRF-Token")).toBe("csrf-token");
      clearTimeout(prepared.timeoutId);
    }

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never attaches a business-company token to login, logout or user preferences", async () => {
    activateCompanyCacheScope(4);
    rememberVerifiedServerCompanyRevision(4, "session-4-revision");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
      headers: { "Content-Type": "application/json" },
    })));

    for (const endpoint of ["/api/auth/set-company", "/api/auth/logout", "/api/user-preferences"]) {
      const prepared = await prepareApiRequest("POST", endpoint, {}, 10000);
      expect(new Headers(prepared.init.headers).has("X-Expected-Company-Revision")).toBe(false);
      clearTimeout(prepared.timeoutId);
    }
  });

  it("cancels an already prepared draft if the company changes during the CSRF roundtrip", async () => {
    activateCompanyCacheScope(4);
    rememberVerifiedServerCompanyRevision(4, "old-revision");
    let finishCsrf!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => { finishCsrf = resolve; });
    const fetchMock = vi.fn(() => tokenResponse);
    vi.stubGlobal("fetch", fetchMock);

    const pendingWrite = prepareApiRequest("POST", "/api/vouchers", { debit: 10 }, 10000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    beginCompanyCacheTransition();
    activateCompanyCacheScope(5);
    rememberVerifiedServerCompanyRevision(5, "new-revision");
    finishCsrf(new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
      headers: { "Content-Type": "application/json" },
    }));
    await expect(pendingWrite).rejects.toMatchObject({ name: "AbortError" });
  });
});
