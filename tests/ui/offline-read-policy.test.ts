import { describe, expect, it } from "vitest";
import {
  classifyOfflineReadFallback,
  normalizeOfflineReadUrl,
  offlineReadKey,
  readPaginationPlan,
} from "@/lib/offline/offlineReadPolicy";

describe("Phase 2 offline read policy", () => {
  it("only allows exact known authorized GET URL shapes", () => {
    expect(normalizeOfflineReadUrl("/api/inventory")).toBe("/api/inventory");
    expect(normalizeOfflineReadUrl("/api/factory/suppliers")).toBe("/api/factory/suppliers");
    expect(normalizeOfflineReadUrl("/api/auth/me")).toBeNull();
    expect(normalizeOfflineReadUrl("/api/auth/session-company")).toBeNull();
    expect(normalizeOfflineReadUrl("/api/health")).toBeNull();
    expect(normalizeOfflineReadUrl("/api/inventory?profile=combined")).toBeNull();
    expect(normalizeOfflineReadUrl("/api/inventory/quick-adjust")).toBeNull();
    expect(normalizeOfflineReadUrl("https://attacker.example/api/inventory")).toBeNull();
    expect(normalizeOfflineReadUrl("//attacker.example/api/inventory")).toBeNull();
  });

  it("makes keys include both company and authenticated operator", () => {
    expect(offlineReadKey(6, "operator-one", "/api/inventory")).not.toBe(
      offlineReadKey(7, "operator-one", "/api/inventory")
    );
    expect(offlineReadKey(6, "operator-one", "/api/inventory")).not.toBe(
      offlineReadKey(6, "operator-two", "/api/inventory")
    );
  });

  it("does not conceal authorization or application server errors", () => {
    expect(classifyOfflineReadFallback("GET", "/api/inventory", "network")).toBe(true);
    expect(classifyOfflineReadFallback("POST", "/api/inventory", "network")).toBe(false);
    expect(classifyOfflineReadFallback("GET", "/api/inventory", 401)).toBe(false);
    expect(classifyOfflineReadFallback("GET", "/api/inventory", 403)).toBe(false);
    expect(classifyOfflineReadFallback("GET", "/api/inventory", 500)).toBe(false);
    expect(classifyOfflineReadFallback("GET", "/api/inventory", 503)).toBe(false);
    expect(classifyOfflineReadFallback("GET", "/api/inventory", "sw-offline")).toBe(true);
  });

  it("treats a genuinely empty inventory table as one complete page", () => {
    expect(readPaginationPlan(
      { data: [], page: 1, total: 0, totalPages: 0, pageSize: 100 },
      new Headers()
    )).toEqual({ field: "data", totalPages: 1, total: 0, pageSize: 100 });
  });

  it("detects all remaining inventory pages rather than accepting page one", () => {
    expect(
      readPaginationPlan({ data: [{ id: 1 }], page: 1, pageSize: 1, total: 3, totalPages: 3 }, new Headers())
    ).toEqual({ totalPages: 3, total: 3, field: "data", pageSize: 1 });
    expect(
      readPaginationPlan([{ id: 1 }], new Headers({ "X-Total-Count": "201", "X-Total-Pages": "3", "X-Page-Size": "100" }))
    ).toEqual({ totalPages: 3, total: 201, field: "array", pageSize: 100 });
    expect(readPaginationPlan([{ id: 1 }], new Headers())).toEqual({
      totalPages: 1, total: 1, field: "array", pageSize: 1,
    });
    expect(() => readPaginationPlan({ data: [], total: 10, totalPages: 2000, pageSize: 1 }, new Headers()))
      .toThrow("OFFLINE_PAGINATION_UNBOUNDED");
  });
});
