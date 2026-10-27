/**
 * Phase 2 safety contract. These source-level checks protect integration
 * seams until full tenant-scoped DB fixture tests are executed by CI/Claude.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const service = read("server/services/accounting/monetaryFxValuationService.ts");
const route = read("server/routes/stats/statsMultiCurrencyRoutes.ts");
const core = read("server/services/accounting/monetaryFxValuationCore.ts");

describe("Phase 2 four-category valuation integration boundaries", () => {
  it("reuses one-balance-engine customer ownership and ensures one bank/ledger row", () => {
    expect(service).toContain('customerLinksBody("$1")');
    expect(service).toContain('noNonCustomerTarget("p")');
    expect(service).toContain("WHEN p.ledger_account_id IS NOT NULL AND cl.customer_id IS NOT NULL THEN 'customer'");
    expect(service).toContain("WHEN p.bank_account_id IS NOT NULL THEN 'bank'");
    expect(service).toContain("NOT EXISTS (SELECT 1 FROM customer_links cl WHERE cl.ledger_account_id = la.id)");
    expect(service).toContain('const accountKey = `${master.kind}:${master.id}`;');
  });
  it("accepts only posted same-company entries and the company business date", () => {
    expect(service).toContain("v.company_id = $1 AND v.optional = false AND v.deleted_at IS NULL");
    expect(service).toContain("COALESCE(v.effective_date,v.voucher_date) <= $2::date");
    expect(service).toContain("companyBusinessDate(companyId, tx)");
    expect(service).toContain("assertTransactionCompanyScope(tx, companyId)");
    expect(service).toContain('return sql.join(chunks, sql``);');
  });
  it("uses approved stored FX rates, never Factory quote defaults", () => {
    expect(service).toContain("datedMonetaryRateTx(tx, companyId, code, day)");
    expect(core).toContain('direction === "FOREIGN_PER_USD"');
    expect(core).toContain('direction === "USD_PER_FOREIGN"');
    expect(core).not.toContain("factory_fx_rates");
  });
  it("is read only and guards the route by session company and auth", () => {
    expect(route).toContain('"/api/accounts/multi-currency/monetary-valuation", requireAuth, requireNonPOS');
    expect(route).toContain("req.session.currentCompanyId");
    expect(route).toContain('res.setHeader("Cache-Control", "private, no-store")');
    for (const mutating of ["INSERT INTO", "UPDATE voucher", "DELETE FROM", "postErpVoucherTx", "FX-REVAL-"]) {
      expect(service).not.toContain(mutating);
    }
  });
  it("does not allow the client to approve generic monetary assets", () => {
    expect(service).toContain("policy: MonetaryFxEligibilityOptions = {}");
    expect(route).toContain("getMonetaryFxValuation(companyId)");
    expect(route).not.toContain("approvedMonetaryAssetCodes: req.");
  });
});
