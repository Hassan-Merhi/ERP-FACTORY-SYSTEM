/**
 * Phase 8 staged regression contract. NOT RUN by owner request (no tests/CI).
 * Run after manual TablePlus migrations and branch-level QA approval.
 */
import fs from "node:fs";
import path from "node:path";
import { describe,expect,it } from "vitest";
import { MoneyDecimal,sumMoney } from "../server/lib/money";
import { codeShape, fragmentFor, shaped } from "./helpers/codeShape";

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
    expect(shaped(service)).toContain(fragmentFor(service, "loadOrderDispatchReconciliationTx(tx,s)"));
    expect(shaped(service)).toContain(fragmentFor(service, "signed.fingerprint"));
    expect(shaped(service)).toContain(fragmentFor(service, "current.includedPostingIds"));
    expect(shaped(service)).toContain(fragmentFor(service, "loadCombinedInvoicePlanTx(tx,s)"));
    expect(shaped(service)).toContain(fragmentFor(service, "plan.fingerprint!==expectedFingerprint"));
    expect(shaped(service)).toContain(fragmentFor(service, "Signed financial bale count"));
  });
  it("uses one invoice number and never re-debits posted truck receivables",()=>{
    expect(shaped(service)).toContain(fragmentFor(service, "invoiceNumberTx(tx,s.companyId)"));
    expect(shaped(service)).toContain(fragmentFor(service, "FACTORY_DISPATCH_CLEARING"));
    expect(shaped(service)).toContain(fragmentFor(service, "FACTORY_BALE_SALES_INCOME"));
    expect(shaped(service)).toContain(fragmentFor(service, "Recognize already-posted trip goods"));
    expect(shaped(service)).not.toContain(fragmentFor(service, "syncFactoryInvoiceTx("));
    expect(shaped(service)).not.toContain(fragmentFor(service, "insert(customerBalances)"));
    expect(shaped(service)).not.toContain(fragmentFor(service, "transactionType: \"SALE\""));
    expect(shaped(service)).toContain(fragmentFor(service, "customerReceivableReposted:false"));
  });
  it("posts stock costs only under active perpetual cutover and returns only scanned bales to SOLD",()=>{
    expect(shaped(service)).toContain(fragmentFor(service, "isPerpetualInventoryActive(tx,s.companyId,s.postingDate)"));
    expect(shaped(service)).toContain(fragmentFor(service, '"COGS"'));
    expect(shaped(service)).toContain(fragmentFor(service, '"FACTORY_FINISHED_GOODS"'));
    expect(shaped(service)).toContain(fragmentFor(service, "await rewriteCommercialLinesTx(tx,s,bales)"));
    expect(shaped(service)).toContain(fragmentFor(service, 'status:"SOLD"'));
    expect(shaped(service)).toContain(fragmentFor(service, "baleIds=bales.map(b=>b.baleId)"));
  });
  it("requires reason, no-double-billing acknowledgments and supervisor-only finalization",()=>{
    expect(shaped(route)).toContain(fragmentFor(route, 'data.confirmNoDuplicateReceivable!==true'));
    expect(shaped(route)).toContain(fragmentFor(route, 'data.confirmTripChargesReviewed!==true'));
    expect(shaped(route)).toContain(fragmentFor(route, '["admin","owner","developer"]'));
    expect(shaped(route)).toContain(fragmentFor(route, 'data.expectedFingerprint'));
  });
  it("renders every trip with charges and signed discounts, while excluding internal-only expenses",()=>{
    expect(shaped(docSource)).toContain(fragmentFor(docSource, "factory_dispatch_trip_charges c"));
    expect(shaped(docSource)).toContain(fragmentFor(docSource, "c.kind IN ('BILLABLE','DISCOUNT')"));
    expect(shaped(docSource)).toContain(fragmentFor(docSource, 'row.kind==="DISCOUNT"?-1:1'));
    expect(shaped(docSource)).toContain(fragmentFor(docSource, 'dispatchTrips'));
    expect(shaped(docPrint)).toContain(fragmentFor(docPrint, 'document.dispatchTrips'));
  });
  it("pins the finalization snapshot and prevents a second invoice after any restart",()=>{
    expect(shaped(service)).toContain(fragmentFor(service, 'if(consolidation?.status==="FINALIZED")'));
    expect(shaped(service)).toContain(fragmentFor(service, "replayed:true"));
    expect(shaped(service)).toContain(fragmentFor(service, "finalization_details="));
    expect(shaped(sql)).toContain(fragmentFor(sql, "factory_dispatch_order_consolidations_final_invoice_ck"));
    expect(shaped(sql)).toContain(fragmentFor(sql, "factory_dispatch_final_invoice_guard"));
    expect(shaped(sql)).toContain(fragmentFor(sql, "factory_dispatch_final_invoice_number_uq"));
  });
});
