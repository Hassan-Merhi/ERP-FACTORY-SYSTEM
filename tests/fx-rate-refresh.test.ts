import { describe, expect, it } from "vitest";
import {
  isFxRateDependentPath,
  isFxRateDependentQuery,
} from "../shared/fxRateQueryInvalidation";
import {
  classifyRealtimeWrite,
  parseRealtimeInvalidationMessage,
} from "../shared/realtimeInvalidation";
import {
  _getCached, _setCached, _invalidateCachedWhere,
} from "../server/services/shared/ttlCache";

describe("Phase 3 FX read-model invalidation policy", () => {
  it("recognizes monetary valuation, finance snapshots, account screens, and rate history", () => {
    for (const path of [
      "/api/exchange-rates/check-today",
      "/api/exchange-rates/latest?fromCurrency=USD&toCurrency=CFA",
      "/api/accounts/multi-currency/monetary-valuation",
      "/api/accounts/multi-currency/cash-bank-revaluation",
      "/api/accounts/all?limit=100",
      "/api/customers",
      "/api/loans",
      "/api/balance-sheet",
      "/api/stats/net-profit?toDate=2026-10-27",
      "/api/stats/group-net-position",
      "/api/factory/net-position",
    ]) {
      expect(isFxRateDependentPath(path), path).toBe(true);
    }
  });

  it("does not broadly re-request voucher history, unrelated company rates, or inventory", () => {
    for (const path of [
      "/api/vouchers",
      "/api/sales",
      "/api/inventory",
      "/api/reports/net-profit-statement",
      "/api/stats/net-profitable",
      "/api/exchange-rates-unrelated",
      "/api/factory/net-position-other",
    ]) {
      expect(isFxRateDependentPath(path), path).toBe(false);
    }
    expect(isFxRateDependentQuery(["/api/exchange-rates/latest", 20, "USD", "ZMW"], 9)).toBe(false);
    expect(isFxRateDependentQuery(["/api/exchange-rates/latest", 9, "USD", "CFA"], 9)).toBe(true);
    expect(isFxRateDependentQuery(["/api/exchange-rates/check-today", 19], 9)).toBe(false);
    expect(isFxRateDependentQuery(["/api/exchange-rates?companyId=19"], 9)).toBe(false);
    expect(isFxRateDependentQuery(["/api/exchange-rates?companyId=9"], 9)).toBe(true);
    expect(isFxRateDependentQuery(["/api/accounts/all", { filter: 19 }], 9)).toBe(true);
    expect(isFxRateDependentQuery(["/api/stats/net-profit", 19], 9)).toBe(true);
  });

  it("emits a targeted FX realtime topic only for the exchange-rate save", () => {
    expect(classifyRealtimeWrite("/api/exchange-rates", {}).topics).toEqual(["fx"]);
    expect(classifyRealtimeWrite("/api/exchange-rates?companyId=9", {}).topics).toEqual(["fx"]);
    expect(classifyRealtimeWrite("/api/vouchers", {}).topics).not.toContain("fx");
    expect(parseRealtimeInvalidationMessage({ type: "invalidate", topics: ["fx", "bogus"] })?.topics).toEqual(["fx"]);
  });

  it("evicts only cache entries selected by the predicate", () => {
    const ours = "net-profit:99119::phase3-fixture";
    const other = "net-profit:99120::phase3-fixture";
    _setCached(ours, { usd: "100" });
    _setCached(other, { usd: "200" });
    expect(_invalidateCachedWhere((key) => key.startsWith("net-profit:99119:"))).toBe(1);
    expect(_getCached(ours)).toBeNull();
    expect(_getCached(other)).toEqual({ usd: "200" });
    _invalidateCachedWhere((key) => key === other);
  });
});
