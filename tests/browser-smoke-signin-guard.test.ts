/**
 * The browser smoke suites used to report a rejected sign-in as
 * "Waiting failed: 45000ms exceeded" against whichever route came next,
 * because nothing inspected the sign-in response. That is what made the login
 * flood guard's 429 look like random, wandering UI flakiness.
 *
 * These tests pin the guard that replaced it: the rejection is named, and the
 * wait stops as soon as the server has said no instead of burning its timeout.
 */
import { describe, expect, it, vi } from "vitest";

import { awaitAuthenticatedShell, watchSignInResponses } from "../scripts/lib/browser-smoke-signin.mjs";

type Listener = (response: unknown) => void;

/** Minimal Puppeteer page stand-in: only `on`/`off` for "response" are used. */
function fakePage() {
  const listeners = new Set<Listener>();
  return {
    on(event: string, listener: Listener) {
      if (event === "response") listeners.add(listener);
    },
    off(event: string, listener: Listener) {
      if (event === "response") listeners.delete(listener);
    },
    emit(response: unknown) {
      for (const listener of [...listeners]) listener(response);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function fakeResponse({
  url = "http://127.0.0.1:5000/api/auth/login",
  method = "POST",
  status = 429,
  statusText = "Too Many Requests",
}: { url?: string; method?: string; status?: number; statusText?: string } = {}) {
  return {
    url: () => url,
    status: () => status,
    statusText: () => statusText,
    ok: () => status >= 200 && status < 300,
    request: () => ({ method: () => method }),
  };
}

describe("browser smoke sign-in guard", () => {
  it("names a rejected sign-in instead of letting the shell wait time out", async () => {
    const page = fakePage();
    const signIn = watchSignInResponses(page);

    page.emit(fakeResponse({ status: 429, statusText: "Too Many Requests" }));

    // A shell wait that never settles stands in for the app that will never render.
    await expect(awaitAuthenticatedShell(signIn, new Promise(() => {}))).rejects.toThrow(
      /sign-in rejected by the server \(429 Too Many Requests\)/
    );
    signIn.stop();
  });

  it("stops waiting as soon as the rejection arrives, without the shell settling", async () => {
    const page = fakePage();
    const signIn = watchSignInResponses(page);
    const neverSettles = new Promise<void>(() => {});

    const pending = awaitAuthenticatedShell(signIn, neverSettles);
    page.emit(fakeResponse({ status: 429 }));

    await expect(pending).rejects.toThrow(/sign-in rejected/);
    signIn.stop();
  });

  it("passes a successful sign-in straight through", async () => {
    const page = fakePage();
    const signIn = watchSignInResponses(page);

    page.emit(fakeResponse({ status: 200, statusText: "OK" }));

    await expect(awaitAuthenticatedShell(signIn, Promise.resolve())).resolves.toBeUndefined();
    expect(signIn.rejection).toBeNull();
    signIn.stop();
  });

  it("surfaces a genuine shell failure unchanged when the sign-in was accepted", async () => {
    const page = fakePage();
    const signIn = watchSignInResponses(page);
    const timeout = new Error("Waiting failed: 45000ms exceeded");

    await expect(awaitAuthenticatedShell(signIn, Promise.reject(timeout))).rejects.toBe(timeout);
    signIn.stop();
  });

  it("ignores responses that are not a failed login POST", async () => {
    const page = fakePage();
    const signIn = watchSignInResponses(page);

    page.emit(fakeResponse({ method: "GET", status: 429 }));
    page.emit(fakeResponse({ url: "http://127.0.0.1:5000/api/auth/logout", status: 429 }));
    page.emit(fakeResponse({ url: "http://127.0.0.1:5000/api/user/companies", status: 500 }));

    expect(signIn.rejection).toBeNull();
    await expect(awaitAuthenticatedShell(signIn, Promise.resolve())).resolves.toBeUndefined();
    signIn.stop();
  });

  it("keeps the first rejection and detaches its listener on stop", async () => {
    const page = fakePage();
    const signIn = watchSignInResponses(page);

    page.emit(fakeResponse({ status: 429, statusText: "Too Many Requests" }));
    page.emit(fakeResponse({ status: 503, statusText: "Service Unavailable" }));
    expect(signIn.rejection).toBe("429 Too Many Requests");

    expect(page.listenerCount).toBe(1);
    signIn.stop();
    expect(page.listenerCount).toBe(0);
  });

  it("does not treat an uninspectable response as a rejection", async () => {
    const page = fakePage();
    const signIn = watchSignInResponses(page);

    page.emit({
      url: () => {
        throw new Error("detached frame");
      },
      request: () => ({ method: () => "POST" }),
    });

    expect(signIn.rejection).toBeNull();
    signIn.stop();
  });
});
