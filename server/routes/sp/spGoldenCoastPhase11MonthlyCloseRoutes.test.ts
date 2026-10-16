import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(new URL("./spGoldenCoastPhase11MonthlyCloseRoutes.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const accessSource = readFileSync(new URL("./spAccessControl.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(
  new URL("../../services/accounting/goldenCoastPhase11MonthlyClose.ts", import.meta.url),
  "utf8"
);

describe("Golden Coast Phase 11 monthly close route surface", () => {
  it("mounts after Phase 10 and before legacy reports", () => {
    const phase10 = indexSource.indexOf("registerSpGoldenCoastPhase10SalesCashSettlementRoutes(app);");
    const phase11 = indexSource.indexOf("registerSpGoldenCoastPhase11MonthlyCloseRoutes(app);");
    const reports = indexSource.indexOf("registerSpReportRoutes(app);");
    expect(phase11).toBeGreaterThan(phase10);
    expect(phase11).toBeLessThan(reports);
  });

  it("inherits report permission plus the existing sensitive profit-split confirmation", () => {
    expect(routeSource).toContain("/phase11/profit-splits/monthly-close");
    expect(accessSource).toContain('path.includes("profit-splits")');
    expect(accessSource).toContain('confirmation: "FINALIZE SP PROFIT SPLIT"');
    expect(routeSource).toContain("requireNonPOS");
    expect(routeSource).toContain("privilegedMutationRateLimit");
    expect(routeSource).toContain("phase11RequestBudget");
  });

  it("derives revenue, COGS and shared charges from posted company-scoped vouchers", () => {
    expect(routeSource).toContain("salesItemsPeriodActivity");
    expect(routeSource).toContain("SUM(CAST(si.total_sales AS numeric))");
    expect(routeSource).toContain("SUM(CAST(si.total_cost AS numeric))");
    expect(routeSource).toContain("FROM sales_items si");
    expect(routeSource).toContain("v.company_id = ${companyId}");
    expect(routeSource).toContain("COALESCE(v.optional, false) = false");
    expect(routeSource).toContain("v.deleted_at IS NULL");
    expect(routeSource).toContain("accountPeriodActivity");
    expect(routeSource).toContain("new Decimal(shared.debit).minus(shared.credit).abs()");
  });

  it("does not require the obsolete Phase 3 opening cutover", () => {
    expect(routeSource).not.toContain("assertCutoverPosted");
    expect(routeSource).not.toContain("Golden Coast Phase 3 cutover must be posted");
    expect(serviceSource).not.toContain("GC_PHASE11_PRE_CUTOVER_MONTH");
    expect(routeSource).not.toContain("GC_PHASE11_MONTH_NOT_ENDED");
  });

  it("serializes the close and checks Profit Pending Distribution before and after posting", () => {
    expect(routeSource).toContain("pg_advisory_xact_lock");
    expect(routeSource).toContain("LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE");
    expect(routeSource).toContain("pendingBefore");
    expect(routeSource).toContain("pendingAfter");
    expect(routeSource).toContain("Profit Pending Distribution did not return to zero");
  });


  it("allows only developers to edit an unfinalized month and keeps corrections auditable", () => {
    expect(routeSource).toContain('"/api/sp/golden-coast/profit-correction"');
    expect(routeSource).toContain("requireDeveloperProfitEdit(req, res)");
    expect(routeSource).toContain("getLatestSpProfitCorrection");
    expect(routeSource).toContain("GC_PROFIT_PERIOD_CLOSED");
    expect(routeSource).toContain("pg_advisory_xact_lock(73111");
    expect(routeSource).toContain("sp_profit_manual_corrections");
    expect(routeSource).toContain("correctionSuspenseAccountId");
    expect(serviceSource).toContain("manualAdjustmentUsd");
    expect(serviceSource).toContain("Manual profit correction suspense ledger");
  });

  it("returns the persisted Journal voucher when a month has already been closed", () => {
    expect(routeSource).toContain("goldenCoastPhase11IdempotencyKey(companyId, probe.periodMonth)");
    expect(routeSource).toContain('journal?.voucherType === "Journal"');
    expect(routeSource).toContain("journalVerified: Boolean(voucher)");
    expect(routeSource).toContain("return { replayed: false, split, voucher: posted.voucher, plan }");
  });

  it("posts only through the central engine", () => {
    expect(routeSource).toContain("postBalancedVoucherTx");
    expect(routeSource).toContain("createDatabasePostingDependencies()");
    expect(routeSource).not.toContain("tx.insert(vouchers)");
  });

  it("retires the old client-calculated Golden Coast split before generic reports mount", () => {
    expect(routeSource).toMatch(/app\.post\(\s*"\/api\/sp\/profit-splits"/);
    expect(routeSource).toContain("GC_PHASE11_LEGACY_PROFIT_SPLIT_RETIRED");
    expect(routeSource).toContain("client-supplied profit totals are retired");
  });

  it("keeps the split hard-coded to 50/50 and never touches savings, sales cash, stock, reserve, or HADI", () => {
    expect(serviceSource).toContain('GOLDEN_COAST_PHASE11_SPLIT_PCT = "50.00"');
    expect(serviceSource).toContain("freshStartShareUsd");
    expect(serviceSource).toContain("hassanShareUsd");
    expect(serviceSource).not.toContain("hassan_savings");
    expect(serviceSource).not.toContain("gc_sales_cash");
    expect(serviceSource).not.toContain("stock_otw");
    expect(serviceSource).not.toContain("container_reserve");
    expect(serviceSource).not.toContain("hadi");
  });
});
