/**
 * Phase 3 integration seams: keep both entry methods, backend cache reset,
 * and realtime invalidation in sync. The existing voucher-safety tests ensure
 * no FX-REVAL posting is introduced by saving a rate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const exchangeRoutes = source("server/routes/exchangeRateRoutes.ts");
const settings = source("client/src/components/ExchangeRateSettings.tsx");
const popup = source("client/src/components/DailyRateModal.tsx");
const refresh = source("client/src/lib/invalidateExchangeRateReadModels.ts");
const realtimeClient = source("client/src/hooks/use-ws-invalidation.ts");
const realtimeServer = source("server/routes/writeInvalidationSignal.ts");
const groupReport = source("server/routes/stats/groupNetPositionRoutes.ts");
const monetaryService = source("server/services/accounting/monetaryFxValuationService.ts");
const readMicrocache = source("server/routes/performance/readMicrocache.ts");
const serverCacheReset = source("server/services/accounting/invalidateCompanyFxRateCaches.ts");

describe("Phase 3 rate-change propagation", () => {
  it("invalidates only after the server confirms its audited rate transaction", () => {
    const saved = exchangeRoutes.indexOf("const rate = await saveCompanyExchangeRate(");
    const invalidated = exchangeRoutes.indexOf("invalidateCompanyFxRateCaches(companyId);");
    const answered = exchangeRoutes.indexOf("res.json(rate);");
    expect(saved).toBeGreaterThan(0);
    expect(invalidated).toBeGreaterThan(saved);
    expect(answered).toBeGreaterThan(invalidated);
    expect(exchangeRoutes).not.toContain("postErpVoucherTx(");
    expect(exchangeRoutes).toContain("private, no-store");
  });

  it("connects Settings and daily popup to one endpoint and one client refresh helper", () => {
    for (const component of [settings, popup]) {
      expect(component).toContain('apiRequest("POST", "/api/exchange-rates"');
      expect(component).toContain("await invalidateExchangeRateReadModels(savedCompanyId)");
    }
    expect(popup).toContain("daily: true");
    expect(settings).toContain("effectiveDate: data.effectiveDate");
    expect(refresh).toContain("isFxRateDependentQuery(query.queryKey, savedCompanyId)");
    expect(refresh).toContain('refetchType: "active"');
  });

  it("invalidates other tabs without indiscriminately refreshing stable financial reports", () => {
    expect(realtimeServer).toContain('broadcast(');
    expect(realtimeClient).toContain('invalidation.topics.has("fx") && isFxRateDependentQuery(query.queryKey)');
    expect(realtimeClient).toContain('if (topic === "fx") return isFxRateDependentQuery(query.queryKey)');
    expect(realtimeClient).toContain('if (isStableQueryKey(key) &&');
  });

  it("prevents a live group snapshot being held at a stale company FX rate", () => {
    expect(groupReport).toContain("forceRefresh || useCurrentSnapshot ? null : _getCached(cacheKey)");
    expect(groupReport).toContain("if (!useCurrentSnapshot) _setCached(cacheKey");
  });

  it("clears both server microcache and browser response cache dependencies", () => {
    expect(readMicrocache).toContain('isFxRateDependentPath(req.path)');
    expect(readMicrocache).toContain('[...(baseTopics ?? []), "fx"]');
    expect(serverCacheReset).toContain('net-profit:${companyId}:');
    expect(serverCacheReset).toContain('group-net-position:');
    expect(refresh).toContain('invalidateBandwidthReadCaches("all")');
    expect(realtimeClient).toContain('invalidation.topics.has("fx") ? "all" : "live"');
  });

  it("retains report-only monetary valuation and no policy parameter shadowing", () => {
    expect(monetaryService).toContain('const eligibility = monetaryFxEligibility({');
    expect(monetaryService).not.toContain('const policy = monetaryFxEligibility(');
    expect(monetaryService).toContain("bookBalancesModified: false, fxVouchersPosted: false");
  });
});
