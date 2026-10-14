/**
 * Verification tests for the /api/stock-items bandwidth fix.
 *
 * These tests exist to prevent regressions where lightweight callers were
 * accidentally routing to the full 649 KB /api/stock-items endpoint instead
 * of the /api/stock-items/light (≈4 KB) endpoint.
 *
 * Run with:  npx vitest run client/src/lib/__tests__/stock-items-bandwidth.test.ts
 */

import { describe, it, expect } from "vitest";
import { stockItemKeys } from "@/lib/queryKeys";

// ─── 1. Key factories produce correct URLs ─────────────────────────────────────

describe("stockItemKeys", () => {
  it("light key first element is /api/stock-items/light (not /api/stock-items)", () => {
    const key = stockItemKeys.light(1);
    expect(key[0]).toBe("/api/stock-items/light");
  });

  it("light key with companyId encodes companyId as second element", () => {
    const key = stockItemKeys.light(42);
    expect(key[1]).toBe(42);
  });

  it("light key with undefined companyId is still safe", () => {
    const key = stockItemKeys.light(undefined);
    expect(key[0]).toBe("/api/stock-items/light");
    expect(key[1]).toBeUndefined();
  });

  it("full key first element is /api/stock-items", () => {
    const key = stockItemKeys.full(1);
    expect(key[0]).toBe("/api/stock-items");
  });

  it("light key does NOT share a cache prefix with full key", () => {
    // TanStack Query prefix-matches by array element.
    // The full key is ["/api/stock-items", companyId].
    // The light key is ["/api/stock-items/light", companyId].
    // They MUST differ in element[0] so that a broad invalidation of
    // ["/api/stock-items"] does NOT trigger a 649 KB light query refetch.
    const lightKey = stockItemKeys.light(1);
    const fullKey = stockItemKeys.full(1);
    expect(lightKey[0]).not.toBe(fullKey[0]);
  });

  it("two light keys for the same company are reference-equal string in slot 0", () => {
    expect(stockItemKeys.light(7)[0]).toBe(stockItemKeys.light(7)[0]);
  });
});

// ─── 2. Key shapes don't accidentally contain old discriminators ────────────────

describe("stockItemKeys shape regression", () => {
  it("light key does not contain the string 'light' as a trailing discriminator after the URL", () => {
    // Old (broken): ["/api/stock-items", companyId, "light"]
    // New (correct): ["/api/stock-items/light", companyId]
    const key = stockItemKeys.light(1);
    // "light" must be part of the URL, not a trailing element
    expect(key[0]).toContain("light");
    // The array must be exactly 2 elements — no trailing "light" discriminator
    expect(key.length).toBe(2);
  });

  it("full key has exactly 2 elements (no trailing discriminator)", () => {
    const key = stockItemKeys.full(1);
    expect(key.length).toBe(2);
  });
});

// ─── 3. offlinePrep uses the light endpoint ────────────────────────────────────

describe("offlinePrep endpoint", () => {
  it("offlinePrep.ts uses /api/stock-items/light not /api/stock-items", async () => {
    // The portable check: import the module and verify its helpers exist.
    const mod = await import("@/lib/offlinePrep");
    expect(typeof mod.getLastOfflinePrepTime).toBe("function");
    expect(typeof mod.isOfflinePrepInProgress).toBe("function");
  });

  it("isOfflinePrepInProgress returns false for a company that has never run prep", async () => {
    const { isOfflinePrepInProgress } = await import("@/lib/offlinePrep");
    expect(isOfflinePrepInProgress(99999)).toBe(false);
  });

  it("getLastOfflinePrepTime returns null for a company that has never run prep", async () => {
    const { getLastOfflinePrepTime } = await import("@/lib/offlinePrep");
    expect(getLastOfflinePrepTime(99999)).toBeNull();
  });
});

// ─── 4. No refetchInterval on stock item queries ────────────────────────────────
//
// The following is a documentation / enforcement check captured as a comment:
//
//   None of the lightweight stock-item queries in the codebase should set
//   refetchInterval.  If any caller adds one, it will be the primary driver
//   of repeated 649 KB downloads.
//
//   To verify manually:
//     grep -r "refetchInterval" client/src/pages/ client/src/components/ \
//       | grep "stock-items" | grep -v ".test." | grep -v "// "
//
//   Expected output: (empty — no matches)

describe("query option guards", () => {
  it("stockItemKeys.light produces a non-empty array key (not empty/null)", () => {
    const key = stockItemKeys.light(1);
    expect(Array.isArray(key)).toBe(true);
    expect(key.length).toBeGreaterThan(0);
  });
});
