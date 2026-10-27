/**
 * Phase 6 source integrity checks for the live read-only valuation pipeline.
 * They complement, but do not replace, database fixture tests and TypeScript CI.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const file = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const service = file("server/services/accounting/monetaryFxValuationService.ts");
const netPosition = file("server/routes/stats/statsMultiCurrencyRoutes.ts");
const factory = file("server/routes/factory/employee-pos/employeeNetPositionRoutes.ts");
const mainReport = file("server/routes/stats/statsNetProfitRoutes.ts");
const accounts = file("server/routes/accounts/all.ts");
const customers = file("server/routes/customers/customerMasterRoutes.ts");
const factoryCustomers = file("server/routes/factory/customers-core/crud.ts");
const overlay = file("server/services/accounting/monetaryFxReportOverlay.ts");

describe("Phase 6 reconciliation and read-only release gates", () => {
  it("reuses owner attribution, excludes optional/deleted vouchers and keeps one opening", () => {
    expect(service).toContain('customerLinksBody("$1")');
    expect(service).toContain('noNonCustomerTarget("p")');
    expect(service).toContain("NOT EXISTS (SELECT 1 FROM customer_links cl WHERE cl.ledger_account_id = la.id)");
    expect(service).toContain('v.company_id = $1 AND v.optional = false AND v.deleted_at IS NULL');
    expect(service).toContain('COALESCE(v.effective_date,v.voucher_date) <= $2::date');
  });

  it("rejects mismatched native/book opening evidence instead of inventing current USD", () => {
    expect(service).toContain('baseOpening.minus(opening.abs()).abs().gt("0.03")');
    expect(service).toContain("openingBookMismatch = true");
    expect(service).toContain("unresolvedOpening = true");
    expect(service).toContain("historicalBaseUsd: calculation.historicalBaseUsd");
    expect(service).toContain("provisional: eligibility ===");
  });

  it("isolates one corrupt rate from other foreign currencies without cross-company fallback", () => {
    expect(service).toContain("datedMonetaryRateTx(tx, companyId, code, day)");
    expect(service).toContain("if (!(error instanceof MonetaryFxError)) throw error;");
    expect(service).toContain("errors[code] = error.code;");
    expect(service).toContain('errors[code] = "FX_RATE_MISSING";');
    expect(service).toContain("rateErrorsByCurrency: rateResolution.errors");
    expect(service).toContain("assertTransactionCompanyScope(tx, companyId)");
    expect(service).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  });

  it("reports partial valuation rather than hiding errors in ERP/Factory", () => {
    expect(netPosition).toContain("rateErrorsByCurrency: valuation.rateErrorsByCurrency");
    expect(factory).toContain("rateErrorsByCurrency: valuation.rateErrorsByCurrency");
    expect(netPosition).toContain('req.query.toDate');
    expect(factory).toContain("!asOfContext.isHistorical");
    expect(accounts).toContain("!balStartDate && !effectiveEndDate");
    expect(mainReport).toContain("const _cached = toDate ? _getCached(_cacheKey) : null");
  });

  it("revalues no unposted factory memo and no physical or perpetual stock", () => {
    expect(overlay).toContain("Math.abs(row.notInLedgerTotal ?? 0) >= 0.005");
    expect(overlay).toContain("Math.abs(row.heldUnfinalizedCharges ?? 0) >= 0.005");
    expect(overlay).toContain("historical_usd_mismatch");
    expect(overlay).toContain('if (val.eligibility === "needs_review") continue;');
    expect(customers).toContain("applyCurrentCustomerFxOverlay(bookRows, valuation)");
    expect(factoryCustomers).toContain("applyCurrentCustomerFxOverlay(customersWithBalances, valuation)");
  });

  it("contains no voucher posting or rate mutation in the valuation service", () => {
    expect(service).not.toContain("postErpVoucherTx(");
    expect(service).not.toContain("INSERT INTO voucher");
    expect(service).not.toContain("UPDATE exchange_rates");
    expect(service).not.toContain("DELETE FROM");
  });
});
