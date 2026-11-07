import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHRISTMAS_LOGIN_ENTRANCE_KEY,
  clearChristmasLoginEntrancePending,
  consumeChristmasLoginEntrancePending,
  markChristmasLoginEntrancePending,
} from "./christmasLoginEntrance";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Christmas Mode post-login entrance", () => {
  it("plays once after a successful login and never on refresh", () => {
    markChristmasLoginEntrancePending(1_000_000);
    expect(consumeChristmasLoginEntrancePending(1_002_000)).toBe(true);
    expect(consumeChristmasLoginEntrancePending(1_002_100)).toBe(false);
  });

  it("discards an expired login hint", () => {
    markChristmasLoginEntrancePending(1_000_000);
    expect(consumeChristmasLoginEntrancePending(1_121_000)).toBe(false);
    expect(storage.has(CHRISTMAS_LOGIN_ENTRANCE_KEY)).toBe(false);
  });

  it("rejects invalid or future hints", () => {
    storage.set(CHRISTMAS_LOGIN_ENTRANCE_KEY, "invalid");
    expect(consumeChristmasLoginEntrancePending(1_100_000)).toBe(false);
    markChristmasLoginEntrancePending(1_150_000);
    expect(consumeChristmasLoginEntrancePending(1_100_000)).toBe(false);
  });

  it("clears an unconsumed hint on logout", () => {
    markChristmasLoginEntrancePending(1_000_000);
    clearChristmasLoginEntrancePending();
    expect(consumeChristmasLoginEntrancePending(1_000_500)).toBe(false);
  });

  it("never fails login or logout when sessionStorage is unavailable", () => {
    vi.stubGlobal("window", {
      get sessionStorage() {
        throw new Error("Storage disabled");
      },
    });
    expect(() => markChristmasLoginEntrancePending()).not.toThrow();
    expect(consumeChristmasLoginEntrancePending()).toBe(false);
    expect(() => clearChristmasLoginEntrancePending()).not.toThrow();
  });
});
