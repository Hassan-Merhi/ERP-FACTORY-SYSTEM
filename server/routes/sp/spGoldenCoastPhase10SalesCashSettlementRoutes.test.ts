import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  new URL("./spGoldenCoastPhase10SalesCashSettlementRoutes.ts", import.meta.url),
  "utf8"
);
const spIndexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const accessControlSource = readFileSync(new URL("./spAccessControl.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(
  new URL("../../services/accounting/goldenCoastPhase10SalesCashSettlement.ts", import.meta.url),
  "utf8"
);

describe("Golden Coast Phase 10 GC Sales Cash settlement route surface", () => {
  it("registers after the existing Golden Coast production accounting routes and before legacy SP sales", () => {
    const phase8Index = spIndexSource.indexOf("registerSpGoldenCoastPhase8ContainerOffloadRoutes(app);");
    const phase10Index = spIndexSource.indexOf("registerSpGoldenCoastPhase10SalesCashSettlementRoutes(app);");
    const legacySalesIndex = spIndexSource.indexOf("registerSpSalesRoutes(app);");

    expect(phase8Index).toBeGreaterThan(-1);
    expect(phase10Index).toBeGreaterThan(phase8Index);
    expect(phase10Index).toBeLessThan(legacySalesIndex);
  });

  it("keeps direct cash settlement out of POS-role sessions and applies privileged endpoint controls", () => {
    expect(routeSource).toContain("requireNonPOS");
    expect(routeSource).toContain("privilegedMutationRateLimit");
    expect(routeSource).toContain("phase10RequestBudget");
    expect(routeSource).toContain("privilegedReadRateLimit");
    expect(routeSource).toContain("requireAuth");
  });

  it("inherits sp_sales_create permission and audit logging from the shared SP boundary", () => {
    expect(accessControlSource).toContain('if ((path.includes("sales") || path.includes("sale")) && method !== "GET")');
    expect(accessControlSource).toContain('return "sp_sales_create";');
    expect(routeSource).toContain('/phase10/sales-cash-settlement"');
    expect(spIndexSource.indexOf("registerSpAccessControl(app);")).toBeLessThan(
      spIndexSource.indexOf("registerSpGoldenCoastPhase10SalesCashSettlementRoutes(app);")
    );
  });

  it("resolves only one active canonical GC Sales Cash account in the selected company", () => {
    expect(routeSource).toContain('const PHASE10_ROLE = "gc_sales_cash"');
    expect(routeSource).toContain("getGoldenCoastAccountDefinition(PHASE10_ROLE)");
    expect(routeSource).toContain("eq(ledgerAccounts.companyId, companyId)");
    expect(routeSource).toContain("eq(ledgerAccounts.active, true)");
    expect(routeSource).toContain("isNull(ledgerAccounts.deletedAt)");
    expect(routeSource).toContain(".limit(2)");
    expect(routeSource).toContain("definition.acceptedAccountTypes.includes(account.accountType)");
  });

  it("validates every direct payment target as same-company active Cash/Bank", () => {
    expect(routeSource).toContain("validatePaymentAccount");
    expect(routeSource).toContain("eq(bankAccounts.companyId, companyId)");
    expect(routeSource).toContain("eq(bankAccounts.active, true)");
    expect(routeSource).toContain("isNull(bankAccounts.deletedAt)");
    expect(routeSource).toContain('inArray(ledgerAccounts.accountType, ["Cash", "Bank"])');
  });

  it("computes the payable balance from opening semantics plus posted vouchers at the settlement date", () => {
    expect(routeSource).toContain("gcSalesCashDebitBalance");
    expect(routeSource).toContain("SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric))");
    expect(routeSource).toContain("WHEN la.opening_balance_side = 'Cr'");
    expect(routeSource).toContain("ELSE COALESCE(la.opening_balance, 0)::numeric");
    expect(routeSource).toContain("COALESCE(v.effective_date, v.voucher_date) <=");
    expect(routeSource).toContain("COALESCE(v.optional, false) = false");
    expect(serviceSource).toContain("GC_PHASE10_SETTLEMENT_EXCEEDS_BALANCE");
  });

  it("detects an exact replay before the mutable balance cap", () => {
    const digestIndex = routeSource.indexOf("const settlementDigest = goldenCoastPhase10SettlementDigest");
    const replayIndex = routeSource.indexOf("const replayed = await findReplayedSettlement");
    const lockIndex = routeSource.indexOf("LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE");
    const datedBalanceIndex = routeSource.indexOf("const datedBalanceUsd = await gcSalesCashDebitBalance");
    const allPostedBalanceIndex = routeSource.indexOf("const allPostedBalanceUsd = await gcSalesCashDebitBalance");

    expect(digestIndex).toBeGreaterThan(-1);
    expect(replayIndex).toBeGreaterThan(digestIndex);
    expect(lockIndex).toBeGreaterThan(replayIndex);
    expect(datedBalanceIndex).toBeGreaterThan(lockIndex);
    expect(allPostedBalanceIndex).toBeGreaterThan(datedBalanceIndex);
    expect(routeSource).toContain("GC_PHASE10_IDEMPOTENCY_CONFLICT");
    expect(routeSource).toContain("GC_PHASE10_IDEMPOTENCY_INCONSISTENT");
    expect(routeSource).toContain("accountingPostingRequests");
  });

  it("serializes the capped balance against Phase 7, Phase 10 and all voucher-entry writers", () => {
    expect(routeSource).toContain("db.transaction(async (tx) =>");
    expect(routeSource).toContain("pg_advisory_xact_lock");
    expect(routeSource).toContain("golden-coast-phase7:${companyId}");
    expect(routeSource).toContain("golden-coast-phase10:${companyId}");
    expect(routeSource).toContain("LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE");
  });

  it("posts through the central engine and never writes voucher tables directly", () => {
    expect(routeSource).toContain("postBalancedVoucherTx");
    expect(routeSource).toContain("createDatabasePostingDependencies()");
    expect(routeSource).not.toContain("tx.insert(vouchers)");
    expect(routeSource).not.toContain("tx.insert(voucherEntries)");
  });

  it("binds replay identity to amount, date, reference, payment routing and canonical GC Sales Cash", () => {
    expect(serviceSource).toContain("goldenCoastPhase10SettlementDigest");
    expect(serviceSource).toContain("paymentAccount: input.settlement.paymentAccount");
    expect(serviceSource).toContain("reference: input.settlement.reference");
    expect(serviceSource).toContain("gcSalesCashAccountId:");
    expect(serviceSource).toContain("GOLDEN_COAST_PHASE10_SOURCE_TYPE");
  });

  it("posts only Dr GC Sales Cash / Cr Cash/Bank and does not duplicate other phase accounting", () => {
    expect(serviceSource).toContain("Dr canonical GC Sales Cash / Cr selected Golden Coast Cash/Bank");
    expect(serviceSource).not.toContain("Hassan Savings withdrawal");
    expect(routeSource).not.toContain("spStockMovements");
    expect(routeSource).not.toContain("adjustSpInventoryAtomic");
    expect(routeSource).not.toContain("spSaleLines");
    expect(routeSource).not.toContain("hadiCompanyId");
  });

  it("resolves Shared Charges by canonical sub type, never by account name", () => {
    // The fee's posting shape is proven behaviourally in the service suite; what
    // only source can show is that the expense account is found by its role.
    expect(routeSource).toContain("eq(ledgerAccounts.subType, SHARED_CHARGES_SUBTYPE)");
  });
});
