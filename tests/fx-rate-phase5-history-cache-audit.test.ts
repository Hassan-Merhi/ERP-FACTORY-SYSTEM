/**
 * Phase 5 source safety contracts. Execute Vitest / typecheck before release;
 * these assertions are NOT a substitute for live company reconciliation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const rateReader = source("server/services/accounting/monetaryFxRates.ts");
const history = source("server/services/accounting/monetaryFxHistoricalRatePreview.ts");
const route = source("server/routes/stats/statsMultiCurrencyRoutes.ts");
const netPosition = source("server/routes/stats/statsNetProfitRoutes.ts");
const factory = source("server/routes/factory/employee-pos/employeeNetPositionRoutes.ts");
const accounts = source("server/routes/accounts/all.ts");
const rateSave = source("server/services/accounting/exchangeRateWrites.ts");
const rateRoutes = source("server/routes/exchangeRateRoutes.ts");
const overlay = source("server/services/accounting/monetaryFxReportOverlay.ts");

describe("Phase 5 effective-date, historical-lock, company and cache safety", () => {
  it("validates effective days and never selects future exchange rates", () => {
    expect(rateReader).toContain("fxDay(value: string)");
    expect(rateReader).toContain("effective_date<=${date}::date");
    expect(rateReader).toContain("FX_RATE_CONFLICT");
    expect(rateReader).toContain("FX_BASE_UNSUPPORTED");
    expect(history).toContain("if (asOf > businessToday)");
    expect(history).toContain("FX_DATE_FUTURE");
    expect(history).toContain("effective_date <= ${asOf}::date");
  });

  it("never presents today's account balances as a prior historical snapshot", () => {
    expect(history).toContain('valuationMode: "EFFECTIVE_RATE_PREVIEW_ONLY"');
    expect(history).toContain("historicalBookUsdLocked: true");
    expect(history).toContain("historicalBalancesRevalued: false");
    expect(route).toContain('"/api/accounts/multi-currency/rates-as-of", requireAuth, requireNonPOS');
    expect(route).toContain("req.session.currentCompanyId");
    expect(route).toContain("getMonetaryFxHistoricalRatePreview(companyId, asOf)");
    expect(history).toContain("assertTransactionCompanyScope(tx, companyId)");
    expect(history).toContain("ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  });

  it("leaves dated ERP Accounts, ERP Net Position and Factory reconstruction locked", () => {
    expect(route).toContain('req.path !== "/api/stats/net-profit" || req.query.toDate');
    expect(accounts).toContain("!balStartDate && !effectiveEndDate");
    expect(factory).toContain("!asOfContext.isHistorical");
    expect(overlay).toContain("historical_usd_mismatch");
    expect(overlay).toContain("missing_in_report");
    expect(overlay).toContain("duplicate_report_row");
  });

  it("avoids live Net Position stale process-local snapshots across Render workers", () => {
    expect(netPosition).toContain("const _cached = toDate ? _getCached(_cacheKey) : null");
    expect(netPosition).toContain("if (toDate) _setCached(_cacheKey, _result)");
    expect(netPosition).toContain('res.setHeader?.("Cache-Control", "private, no-store")');
  });

  it("audits only actual revised rates in the SAME transaction, with no journal posting", () => {
    expect(rateSave).toContain("new Decimal(String(existing.rate)).eq(new Decimal(input.rate))");
    expect(rateSave).toContain("return existing;");
    expect(rateSave).toContain("sameDayRows.length > 1");
    expect(rateSave).toContain("FX_RATE_DUPLICATE_ROWS");
    expect(rateSave).toContain("await datedMonetaryRateTx(tx, actor.companyId, input.toCurrency, input.effectiveDate)");
    expect(rateRoutes).toContain("error instanceof MonetaryFxError");
    expect(rateRoutes).toContain("error.status");
    expect(rateSave).toContain("writeAuditEvent(");
    expect(rateSave).toContain("effectiveDate: { old:");
    expect(rateSave).toContain("CURRENT_MANAGEMENT_USD_ONLY");
    expect(rateRoutes.indexOf("invalidateCompanyFxRateCaches(companyId)"))
      .toBeGreaterThan(rateRoutes.indexOf("await saveCompanyExchangeRate("));
    expect(rateRoutes).not.toContain("postErpVoucherTx");
    for (const forbidden of ["INSERT INTO", "UPDATE vouchers", "DELETE FROM", "FX-REVAL-"]) {
      expect(history).not.toContain(forbidden);
    }
  });
});
