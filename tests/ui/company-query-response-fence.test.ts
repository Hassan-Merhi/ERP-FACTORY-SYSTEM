import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly_resetCompanyCacheScope,
  activateCompanyCacheScope,
  beginCompanyCacheTransition,
  resumeCompanyCacheScope,
} from "../../client/src/lib/companyCacheScope";
import { getQueryFn } from "../../client/src/lib/queryClientGetQueryFn";

beforeEach(() => _testOnly_resetCompanyCacheScope());
afterEach(() => {
  vi.unstubAllGlobals();
  _testOnly_resetCompanyCacheScope();
});

describe("React Query company response fence", () => {
  it("rejects a Company A JSON body that finishes parsing after Company B activates", async () => {
    activateCompanyCacheScope(1);
    let releaseJson!: (body: { name: string }) => void;
    const deferredBody = new Promise<{ name: string }>((resolve) => { releaseJson = resolve; });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => deferredBody,
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    const query = getQueryFn<{ name: string }>({ on401: "throw" });
    const pending = Promise.resolve(query({
      queryKey: ["/api/customers"],
      signal: new AbortController().signal,
    } as Parameters<typeof query>[0]));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    beginCompanyCacheTransition();
    activateCompanyCacheScope(2);
    releaseJson({ name: "Company A customer" });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps session identity requests available while company-specific GETs are fenced", async () => {
    activateCompanyCacheScope(1);
    beginCompanyCacheTransition();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ companyId: 2 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const query = getQueryFn<{ companyId: number }>({ on401: "throw" });
    const context = (url: string) => ({
      queryKey: [url],
      signal: new AbortController().signal,
    } as Parameters<typeof query>[0]);

    await expect(Promise.resolve(query(context("/api/auth/session-company")))).resolves.toMatchObject({
      companyId: 2,
    });
    await expect(Promise.resolve(query(context("/api/customers")))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resumeCompanyCacheScope();
  });
});
