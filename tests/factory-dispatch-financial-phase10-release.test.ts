/**
 * Phase 10 regression contract — intentionally NOT EXECUTED per owner:
 * no CI, no test runner, no migrations, no merge, no deployment.
 *
 * Run only after the manual SQL is installed in a controlled staging database.
 * Live accounting scenarios (concurrency, settlements, RLS, cutover, recovery)
 * also require the separate human-led release checklist.
 */
import fs from "node:fs";
import path from "node:path";
import { describe,expect,it } from "vitest";
import { MoneyDecimal,sumMoney } from "../server/lib/money";

function file(p:string){return fs.readFileSync(path.join(process.cwd(),p),"utf8");}
const phase4=file("docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase4-guards.sql");
const phase7=file("docs/sql/manual/2026-11-10-factory-dispatch-phase7-order-reconciliation.sql");
const phase8=file("docs/sql/manual/2026-11-10-factory-dispatch-phase8-one-invoice.sql");
const release=file("server/services/factory/dispatchReleaseReadiness.ts");
const audit=file("server/services/factory/dispatchInvoiceIntegrity.ts");
const approvals=file("server/routes/factory/customer-orders/loadingDispatchOrderReconciliationRoutes.ts");
const finalizer=file("server/routes/factory/customer-orders/loadingDispatchCombinedInvoiceService.ts");
const posting=file("server/services/factory/dispatchTripFinancialPosting.ts");
const readinessRoute=file("server/routes/factory/customer-orders/loadingDispatchReleaseReadinessRoutes.ts");
const exportModel=file("server/routes/factory/customer-orders/loadingDispatchPoExportModel.ts");
const importGuard=file("server/routes/import/factoryDispatchPoImportGuard.ts");
const legacyFinal=file("server/routes/factory/customer-orders/finalize-loading/finalize.ts");
const legacyUnfinal=file("server/routes/factory/customer-orders/finalize-loading/unfinalize.ts");

describe("Phase 10 Factory dispatch accounting safety / release contract",()=>{
  it("preserves all six handoff sections without executing SQL",()=>{
    const together=file("docs/sql/manual/2026-11-10-factory-dispatch-all-phases-tableplus.sql");
    for(const name of [
      "phase2.sql","phase4-guards.sql","phase5-export.sql",
      "phase6-receipts.sql","phase7-order-reconciliation.sql","phase8-one-invoice.sql",
    ])expect(together).toContain(name);
    expect(together).toContain("NOT RUN");
  });
  it("rejects malformed PostgreSQL dollar-quoted voucher triggers",()=>{
    expect(phase4).toContain("CREATE OR REPLACE FUNCTION factory_dispatch_guard_posted_vouchers()");
    expect(phase4).toContain("RETURNS TRIGGER LANGUAGE plpgsql AS $$");
    expect(phase4).not.toMatch(/RETURNS TRIGGER LANGUAGE plpgsql AS \$\n/);
    expect(phase4).not.toMatch(/\n\$;\s*DROP TRIGGER/);
    expect((phase4.match(/\$\$/g)||[]).length).toBe(6);
    expect((phase8.match(/\$\$/g)||[]).length%2).toBe(0);
  });
  it("requires installed immutable financial, physical and voucher guards before approval",()=>{
    for(const fragment of [
      "factory_dispatch_signed_trip_guard",
      "factory_dispatch_signed_order_bale_guard",
      "factory_dispatch_signed_order_charge_guard",
      "factory_dispatch_signed_financial_guard",
      "factory_dispatch_source_voucher_entries_guard",
      "factory_dispatch_order_consolidations_signoff_ck",
    ])expect(release).toContain(fragment);
    expect(approvals).toContain('assertFactoryDispatchReleaseReadyTx(tx,"RECONCILIATION")');
    expect(approvals).toContain("RECONCILIATION_SIGNOFF_CONFLICT");
  });
  it("requires final invoice one-time check, unique invoice and protected original source vouchers",()=>{
    for(const guard of [
      "factory_dispatch_final_invoice_guard",
      "factory_dispatch_final_voucher_guard",
      "factory_dispatch_final_voucher_entries_guard",
      "factory_dispatch_final_posting_identity_guard",
      "factory_dispatch_final_invoice_number_uq",
    ]){expect(release).toContain(guard);expect(phase8).toContain(guard);}
    expect(finalizer).toContain('assertFactoryDispatchReleaseReadyTx(tx,"FINAL_INVOICE")');
  });
  it("ensures original FDTR invoice voucher carries the expected customer debit and clearing credit",()=>{
    const source=file("server/routes/factory/customer-orders/loadingDispatchOrderReconciliationData.ts");
    expect(source).toContain("goodsClearingCredit");
    expect(source).toContain("customerDebit");
    expect(source).toContain("factory_dispatch_trip_postings");
    expect(source).toContain("reverses_posting_id");
    expect(source).toContain("financial.postingVerified=true");
  });
  it("forces one all-or-nothing correction of ONLY physically unshipped, reserved bales",()=>{
    expect(approvals).toContain("await db.transaction(async tx=>");
    expect(approvals).toContain("RECONCILIATION_STOCK_OWNERSHIP_CHANGED");
    expect(approvals).toContain('["RESERVED_FOR_ORDER","IN_STOCK"].includes(b.status)');
    expect(approvals).toContain("RECONCILIATION_BALE_SHARED_WITH_OTHER_LOADING");
    expect(approvals).toContain("ORDER_UNSHIPPED_BALES_REMOVED");
    expect(approvals).toContain("expectedFingerprint");
  });
  it("has exact no-double-customer-billing semantics",()=>{
    const goods=sumMoney(["120.00","230.00"]);
    const fees=sumMoney(["10.00","25.00"]);
    const discounts=sumMoney(["5.00","0.00"]);
    const postedReceivable=goods.plus(fees).minus(discounts);
    const originalOrderCharges=new MoneyDecimal("8.00");
    expect(goods.toFixed(2)).toBe("350.00");
    expect(postedReceivable.toFixed(2)).toBe("380.00");
    expect(postedReceivable.plus(originalOrderCharges).toFixed(2)).toBe("388.00");
    expect(finalizer).toContain("FACTORY_DISPATCH_CLEARING");
    expect(finalizer).toContain("FACTORY_BALE_SALES_INCOME");
    expect(finalizer).not.toContain("syncFactoryInvoiceTx(");
    expect(finalizer).not.toContain("insert(customerBalances)");
    expect(finalizer).toContain("customerReceivableReposted:false");
    expect(legacyFinal).toContain("DISPATCH_CONSOLIDATION_REQUIRED");
    expect(legacyUnfinal).toContain("DISPATCH_FINANCIAL_REVERSAL_REQUIRED");
  });
  it("keeps all ORIGINAL order charge vouchers attached to the final immutable invoice",()=>{
    expect(finalizer).toContain("const originalChargesVoucherIds:number[]=plan.originalCharges");
    expect(finalizer).toContain("c.alreadyPosted && c.voucherId!==null");
    expect(finalizer).toContain("originalChargesVoucherIds.push(voucher.id)");
    expect(finalizer).toContain("COMBINED_INVOICE_DUPLICATE_ORIGINAL_CHARGE_VOUCHER");
  });
  it("uses a single customer invoice, true cutover-aware COGS and signed physical bales",()=>{
    expect(finalizer).toContain("invoiceNumberTx(tx,s.companyId)");
    expect(finalizer).toContain("isPerpetualInventoryActive(tx,s.companyId,s.postingDate)");
    expect(finalizer).toContain('status:"SOLD"');
    expect(finalizer).toContain("source_fingerprint");
    expect(finalizer).toContain("replayed:true");
  });
  it("exposes no-write, company-scoped release diagnostics and final voucher integrity",()=>{
    expect(readinessRoute).toContain("REPEATABLE READ, READ ONLY");
    expect(readinessRoute).toContain("access.companyId");
    expect(readinessRoute).toContain("auditFactoryDispatchInvoiceTx");
    expect(audit).toContain("NO_DUPLICATE_LEGACY_INVOICE");
    expect(audit).toContain("GOODS_CLEARING_TO_SALES");
    expect(audit).toContain("INVENTORY_COGS_JOURNAL");
    expect(audit).toContain("FINAL_VOUCHERS_ACTIVE");
    expect(audit).toContain("SIGNED_BALES_SOLD_ONCE");
  });
  it("keeps ERP purchase costs manually validated and separate from Factory customer sales",()=>{
    expect(importGuard).toContain("Supplier_Code");
    expect(importGuard).toContain("Item_Barcode");
    expect(exportModel).toContain("supplier");
    expect(posting).not.toContain("/api/po-import/import");
    expect(finalizer).not.toContain("/api/po-import/import");
  });
});
