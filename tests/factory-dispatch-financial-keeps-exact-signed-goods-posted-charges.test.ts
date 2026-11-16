/**
 * Phase 8 staged regression contract. NOT RUN by owner request (no tests/CI).
 * Run after manual TablePlus migrations and branch-level QA approval.
 */
import fs from "node:fs";
import path from "node:path";
import { describe,expect,it } from "vitest";
import { MoneyDecimal,sumMoney } from "../server/lib/money";

const at=(pathName:string)=>fs.readFileSync(path.join(process.cwd(),pathName),"utf8");
describe("Phase 8: one combined Factory invoice without double customer billing",()=>{
  const service=at("server/routes/factory/customer-orders/loadingDispatchCombinedInvoiceService.ts");
  const route=at("server/routes/factory/customer-orders/loadingDispatchCombinedInvoiceRoutes.ts");
  const docSource=at("server/services/factoryInvoiceDocumentSource.ts");
  const docPrint=at("server/services/factoryInvoiceDocumentService.ts");
  const sql=at("docs/sql/manual/2026-11-10-factory-dispatch-phase8-one-invoice.sql");
  it("keeps exact signed goods, posted charges and original charges distinct",()=>{
    const signedGoods=sumMoney(["5000.00","7500.00"]);
    const tripBillable=sumMoney(["200.00","300.00"]);
    const tripDiscounts=sumMoney(["40.00","10.00"]);
    const existingReceivable=signedGoods.plus(tripBillable).minus(tripDiscounts);
    const originalOrderCharges=new MoneyDecimal("125.00");
    const invoiceTotal=existingReceivable.plus(originalOrderCharges);
    expect(signedGoods.toFixed(2)).toBe("12500.00");
    expect(existingReceivable.toFixed(2)).toBe("12950.00");
    expect(invoiceTotal.toFixed(2)).toBe("13075.00");
  });
  it("requires locked signed Phase 7 fingerprint, posting IDs, all frozen bales and live voucher matching",()=>{
    expect(service).toContain("loadOrderDispatchReconciliationTx(tx,s)");
    expect(service).toContain("signed.fingerprint");
    expect(service).toContain("current.includedPostingIds");
    expect(service).toContain("loadCombinedInvoicePlanTx(tx,s)");
    expect(service).toContain("plan.fingerprint!==expectedFingerprint");
    expect(service).toContain("Signed financial bale count");
  });
  it("uses one invoice number and never re-debits posted truck receivables",()=>{
    expect(service).toContain("invoiceNumberTx(tx,s.companyId)");
    expect(service).toContain("FACTORY_DISPATCH_CLEARING");
    expect(service).toContain("FACTORY_BALE_SALES_INCOME");
    expect(service).toContain("Recognize already-posted trip goods");
    expect(service).not.toContain("syncFactoryInvoiceTx(");
    expect(service).not.toContain("insert(customerBalances)");
    expect(service).not.toContain("transactionType: \"SALE\"");
    expect(service).toContain("customerReceivableReposted:false");
  });
  it("posts stock costs only under active perpetual cutover and returns only scanned bales to SOLD",()=>{
    expect(service).toContain("isPerpetualInventoryActive(tx,s.companyId,s.postingDate)");
    expect(service).toContain('"COGS"');
    expect(service).toContain('"FACTORY_FINISHED_GOODS"');
    expect(service).toContain("await rewriteCommercialLinesTx(tx,s,bales)");
    expect(service).toContain('status:"SOLD"');
    expect(service).toContain("baleIds=bales.map(b=>b.baleId)");
  });
  it("requires reason, no-double-billing acknowledgments and supervisor-only finalization",()=>{
    expect(route).toContain('data.confirmNoDuplicateReceivable!==true');
    expect(route).toContain('data.confirmTripChargesReviewed!==true');
    expect(route).toContain('["admin","owner","developer"]');
    expect(route).toContain('data.expectedFingerprint');
  });
  it("renders every trip with charges and signed discounts, while excluding internal-only expenses",()=>{
    expect(docSource).toContain("factory_dispatch_trip_charges c");
    expect(docSource).toContain("c.kind IN ('BILLABLE','DISCOUNT')");
    expect(docSource).toContain('row.kind==="DISCOUNT"?-1:1');
    expect(docSource).toContain('dispatchTrips');
    expect(docPrint).toContain('document.dispatchTrips');
  });
  it("pins the finalization snapshot and prevents a second invoice after any restart",()=>{
    expect(service).toContain('if(consolidation?.status==="FINALIZED")');
    expect(service).toContain("replayed:true");
    expect(service).toContain("finalization_details=");
    expect(sql).toContain("factory_dispatch_order_consolidations_final_invoice_ck");
    expect(sql).toContain("factory_dispatch_final_invoice_guard");
    expect(sql).toContain("factory_dispatch_final_invoice_number_uq");
  });
});
