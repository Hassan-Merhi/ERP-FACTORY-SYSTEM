import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../../../scripts/lib/readModuleFamily.mjs";

const routeSource = readModuleFamily(new URL("./spGoldenCoastPhase7HadiTransferRoutes.ts", import.meta.url));
const spIndexSource = readModuleFamily(new URL("./index.ts", import.meta.url));
const accessControlSource = readModuleFamily(new URL("./spAccessControl.ts", import.meta.url));
const serviceSource = readModuleFamily(
  new URL("../../services/accounting/goldenCoastPhase7HadiTransfer.ts", import.meta.url)
);

const phase16GuardSource = readModuleFamily(new URL("./spGoldenCoastPhase16HadiTransferGuard.ts", import.meta.url));

describe("Golden Coast Phase 7 HADI transfer route surface", () => {
  it("registers after the mounted POS-sale route and before the legacy Supplier Partner sales route", () => {
    // Phase 6 supersedes Phase 5 as the mounted POS-sale route; Phase 7 must
    // settle cash only after a sale has been posted.
    const posSaleIndex = spIndexSource.indexOf("registerSpGoldenCoastPhase6PosSaleRoutes(app);");
    const phase7Index = spIndexSource.indexOf("registerSpGoldenCoastPhase7HadiTransferRoutes(app);");
    const legacySalesIndex = spIndexSource.indexOf("registerSpSalesRoutes(app);");

    expect(posSaleIndex).toBeGreaterThan(-1);
    expect(phase7Index).toBeGreaterThan(posSaleIndex);
    expect(phase7Index).toBeLessThan(legacySalesIndex);
  });

  it("keeps the readiness GET out of POS-role sessions", () => {
    expect(routeSource).toContain(
      'app.get(\n    "/api/sp/golden-coast/phase7/sales-cash-transfer/readiness",\n    privilegedReadRateLimit'
    );
    expect(routeSource).toContain("requireNonPOS");
    expect(routeSource).toContain("requireAuth");
  });

  it("only declares the POST path; the Phase 16 guard, mounted first, answers every POST", () => {
    expect(routeSource).toContain("app.post(\n    GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH,");
    expect(routeSource).toContain("res.status(409).json(goldenCoastPhase16LegacyHadiRetiredPayload())");
    expect(spIndexSource.indexOf("registerSpGoldenCoastPhase16HadiTransferGuard(app);")).toBeLessThan(
      spIndexSource.indexOf("registerSpGoldenCoastPhase7HadiTransferRoutes(app);")
    );
    expect(phase16GuardSource).toContain("res.status(409).json(goldenCoastPhase16LegacyHadiRetiredPayload());");
    expect(phase16GuardSource).toContain("void handleRemittance(req, res);");
  });

  it("inherits sp_sales_create permission and SP audit logging from the shared access-control boundary", () => {
    expect(accessControlSource).toContain('if ((path.includes("sales") || path.includes("sale")) && method !== "GET")');
    expect(accessControlSource).toContain('return "sp_sales_create";');
    expect(routeSource).toContain('/phase7/sales-cash-transfer/readiness"');
    expect(spIndexSource.indexOf("registerSpAccessControl(app);")).toBeLessThan(
      spIndexSource.indexOf("registerSpGoldenCoastPhase7HadiTransferRoutes(app);")
    );
  });

  it("derives HADI from the configured parent company instead of hard-coding company 1 or a display name", () => {
    expect(routeSource).toContain("parentCompanyId: companies.parentCompanyId");
    expect(routeSource).toContain("const parentCompanyId = Number(goldenCoast.parentCompanyId ?? 0)");
    expect(routeSource).not.toContain("parentCompanyId ?? 1");
    expect(routeSource).not.toContain("eq(companies.name");
    expect(routeSource).not.toContain("eq(ledgerAccounts.companyId, 1)");
  });

  it("requires both configured companies to be active and distinct", () => {
    expect(routeSource).toContain("eq(companies.active, true)");
    expect(routeSource).toContain("parentCompanyId === companyId");
    expect(routeSource).toContain("GC_PHASE7_PARENT_COMPANY_INVALID");
  });

  it("resolves GC Sales Cash by the canonical Phase 2 role", () => {
    expect(routeSource).toContain("getGoldenCoastAccountDefinition(role)");
    expect(routeSource).toContain('"gc_sales_cash"');
    expect(routeSource).toContain("definition.acceptedAccountTypes.includes(account.accountType)");
    expect(routeSource).toContain("account.active === true");
    expect(routeSource).toContain("account.deletedAt == null");
  });

  it("requires the exact child and parent Intercompany roles and rejects ambiguous/wrong-type accounts", () => {
    expect(routeSource).toContain('"sp_hadi_intercompany"');
    expect(routeSource).toContain('"hadi_sp_intercompany"');
    expect(routeSource).toContain('rows[0].accountType !== "Intercompany"');
    expect(routeSource).toContain(".limit(2)");
    expect(routeSource).toContain("GC_PHASE7_INTERCOMPANY_INVALID");
  });

  it("lists only active cash/bank accounts of their owning company", () => {
    expect(routeSource).toContain("eq(bankAccounts.companyId, companyId)");
    expect(routeSource).toContain("eq(bankAccounts.active, true)");
    expect(routeSource).toContain("isNull(bankAccounts.deletedAt)");
    expect(routeSource).toContain("eq(ledgerAccounts.companyId, companyId)");
    expect(routeSource).toContain("eq(ledgerAccounts.active, true)");
    expect(routeSource).toContain("isNull(ledgerAccounts.deletedAt)");
    expect(routeSource).toContain('inArray(ledgerAccounts.accountType, ["Cash", "Bank"])');
  });

  it("requires the tenant boundary to have authorized HADI and never widens scope itself", () => {
    expect(routeSource).toContain("function assertHadiCompanyAuthorized(pair: GoldenCoastPhase7CompanyPair)");
    expect(routeSource).toContain("requestContext.authorizedCompanyIds?.includes(pair.hadiCompanyId)");
    expect(routeSource).toContain("GC_PHASE7_HADI_SCOPE_UNAUTHORIZED");
    // The route may only read the boundary's verified list; assigning to it
    // would let Phase 7 grant itself a company the boundary never checked.
    expect(routeSource).not.toContain("authorizedCompanyIds =");
    expect(routeSource).not.toContain("authorizedCompanyIds.add");
  });

  it("scopes every cross-company read with assertTransactionCompanyScope", () => {
    expect(routeSource).toContain("assertTransactionCompanyScope(tx, pair.hadiCompanyId)");
    expect(routeSource).toContain("assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId)");
  });

  it("only reads: the readiness probe posts and writes nothing", () => {
    expect(routeSource).not.toContain("postBalancedVoucherTx");
    expect(routeSource).not.toContain("tx.insert(");
    expect(routeSource).not.toContain("tx.update(");
  });

  it("binds idempotency to the material payload and resolved account routing", () => {
    expect(serviceSource).toContain("goldenCoastPhase7TransferDigest");
    expect(serviceSource).toContain("hadiCashAccount: transfer.hadiCashAccount");
    expect(serviceSource).toContain("goldenCoastCashAccount: transfer.goldenCoastCashAccount");
    expect(serviceSource).toContain("accounts: canonicalAccounts,");
    expect(serviceSource).toContain("GOLDEN_COAST_PHASE7_SOURCE_TYPE");
  });

  it("limits remittance to Phase 7 collections instead of the shared raw intercompany balance", () => {
    expect(routeSource).toContain("outstandingPhase7HadiCollections");
    expect(routeSource).toContain("apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}");
    expect(routeSource).toContain("split_part(apr.source_id, ':', 1) = 'collect_via_hadi'");
    expect(routeSource).toContain("split_part(apr.source_id, ':', 1) = 'remit_from_hadi'");
    expect(routeSource).not.toContain("SUM(CASE WHEN la.sub_type = 'sp_hadi_intercompany'");
  });

  it("reads GC Sales Cash as a credit-normal payable rather than capping collection against it", () => {
    expect(routeSource).toContain("gcSalesCashSignedBalance");
    expect(routeSource).toContain("SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric))");
    // The signed ledger figure is converted before it reaches the planner.
    expect(routeSource).toContain("gcSalesCashPayableBalance(");
    // A collection raises that payable, so it must not be capped by it.
    expect(serviceSource).not.toContain("GC_PHASE7_COLLECTION_EXCEEDS_BALANCE");
    expect(serviceSource).toContain("GC_PHASE7_REMITTANCE_EXCEEDS_COLLECTIONS");
  });

  it("does not depend on or copy Phase 6 special-location implementation", () => {
    expect(routeSource).not.toContain("goldenCoastPhase6");
    expect(serviceSource).not.toContain("goldenCoastPhase6");
    expect(routeSource).not.toContain("specialLocation");
    expect(serviceSource).not.toContain("hassanSavings");
  });

  it("does not duplicate Phase 5 POS, FIFO, COGS or inventory mutation logic", () => {
    expect(routeSource).not.toContain("planGoldenCoastPhase5Sale");
    expect(routeSource).not.toContain("spStockMovements");
    expect(routeSource).not.toContain("adjustSpInventoryAtomic");
    expect(routeSource).not.toContain("spSales");
    expect(routeSource).not.toContain("spSaleLines");
    expect(serviceSource).not.toContain("Cost of Goods Sold");
    expect(serviceSource).not.toContain("Stock in Hand");
  });
});
