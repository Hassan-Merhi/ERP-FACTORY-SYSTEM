import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _testOnly_isSessionTrafficBlocked,
  _testOnly_resetSessionExpired,
  _testOnly_setRedirectFn,
  handlePossibleSessionExpiry,
  queryClient,
} from "@/lib/queryClient";

function response(status: number): Response {
  return new Response(null, { status });
}

function authMe401(): typeof window.fetch {
  return vi.fn(async () => response(401)) as unknown as typeof window.fetch;
}

describe("session expiry traffic quiescence", () => {
  beforeEach(() => {
    _testOnly_resetSessionExpired();
    _testOnly_setRedirectFn(() => {});
  });

  it("blocks protected traffic and cancels active queries after confirmed expiry", async () => {
    const cancelSpy = vi.spyOn(queryClient, "cancelQueries").mockResolvedValue(undefined);

    await handlePossibleSessionExpiry(response(401), "/api/reports/example", authMe401());

    expect(_testOnly_isSessionTrafficBlocked()).toBe(true);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
