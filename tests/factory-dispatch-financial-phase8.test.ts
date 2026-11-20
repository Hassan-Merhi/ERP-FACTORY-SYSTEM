/**
 * Phase 8 staged regression contract. NOT RUN by owner request (no tests/CI).
 * Run after manual TablePlus migrations and branch-level QA approval.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MoneyDecimal, sumMoney } from "../server/lib/money";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

const at = (pathName: string) => readModuleFamily(path.join(process.cwd(), pathName));
// Whitespace-insensitive source matching: Prettier formats the split service modules.
const compact = (text: string) => text.replace(/\s+/g, "");
describe("Phase 8: one combined Factory invoice without double customer billing", () => {
  const service = compact(at("server/routes/factory/customer-orders/loadingDispatchCombinedInvoiceService.ts"));
  const route = compact(at("server/routes/factory/customer-orders/loadingDispatchCombinedInvoiceRoutes.ts"));
  const docSource = at("server/services/factoryInvoiceDocumentSource.ts");
  const docPrint = at("server/services/factoryInvoiceDocumentService.ts");
  const sql = at("docs/sql/manual/2026-11-10-factory-dispatch-phase8-one-invoice.sql");
  it("keeps exact signed goods, posted charges and original charges distinct", () => {
    const signedGoods = sumMoney(["5000.00", "7500.00"]);
    const tripBillable = sumMoney(["200.00", "300.00"]);
    const tripDiscounts = sumMoney(["40.00", "10.00"]);
    const existingReceivable = signedGoods.plus(tripBillable).minus(tripDiscounts);
    const originalOrderCharges = new MoneyDecimal("125.00");
    const invoiceTotal = existingReceivable.plus(originalOrderCharges);
    expect(signedGoods.toFixed(2)).toBe("12500.00");
    expect(existingReceivable.toFixed(2)).toBe("12950.00");
    expect(invoiceTotal.toFixed(2)).toBe("13075.00");
  });
  it("requires locked signed Phase 7 fingerprint, posting IDs, all frozen bales and live voucher matching", () => {
    expect(service).toContain(compact("loadOrderDispatchReconciliationTx(tx,s)"));
    expect(service).toContain(compact("signed.fingerprint"));
    expect(service).toContain(compact("current.includedPostingIds"));
    expect(service).toContain(compact("loadCombinedInvoicePlanTx(tx,s)"));
    expect(service).toContain(compact("plan.fingerprint!==expectedFingerprint"));
    expect(service).toContain(compact("Signed financial bale count"));
  });
  it("uses one invoice number and never re-debits posted truck receivables", () => {
    expect(service).toContain(compact("invoiceNumberTx(tx,s.companyId)"));
    expect(service).toContain(compact("FACTORY_DISPATCH_CLEARING"));
    expect(service).toContain(compact("FACTORY_BALE_SALES_INCOME"));
    expect(service).toContain(compact("Recognize already-posted trip goods"));
    expect(service).not.toContain(compact("syncFactoryInvoiceTx("));
    expect(service).not.toContain(compact("insert(customerBalances)"));
    expect(service).not.toContain(compact('transactionType: "SALE"'));
    expect(service).toContain(compact("customerReceivableReposted:false"));
  });
  it("posts stock costs only under active perpetual cutover and returns only scanned bales to SOLD", () => {
    expect(service).toContain(compact("isPerpetualInventoryActive(tx,s.companyId,s.postingDate)"));
    expect(service).toContain(compact('"COGS"'));
    expect(service).toContain(compact('"FACTORY_FINISHED_GOODS"'));
    expect(service).toContain(compact("await rewriteCommercialLinesTx(tx,s,bales)"));
    expect(service).toContain(compact('status:"SOLD"'));
    expect(service).toContain(compact("baleIds=bales.map(b=>b.baleId)"));
  });
  it("requires reason, no-double-billing acknowledgments and supervisor-only finalization", () => {
    expect(route).toContain("data.confirmNoDuplicateReceivable!==true");
    expect(route).toContain("data.confirmTripChargesReviewed!==true");
    expect(route).toContain('["admin","owner","developer"]');
    expect(route).toContain("data.expectedFingerprint");
  });
  it("renders every trip with charges and signed discounts, while excluding internal-only expenses", () => {
    expect(docSource).toContain("factory_dispatch_trip_charges c");
    expect(docSource).toContain("c.kind IN ('BILLABLE','DISCOUNT')");
    expect(docSource).toContain('row.kind==="DISCOUNT"?-1:1');
    expect(docSource).toContain("dispatchTrips");
    expect(docPrint).toContain("document.dispatchTrips");
  });
  it("pins the finalization snapshot and prevents a second invoice after any restart", () => {
    expect(service).toContain(compact('if(consolidation?.status==="FINALIZED")'));
    expect(service).toContain(compact("replayed:true"));
    expect(service).toContain(compact("finalization_details="));
    expect(sql).toContain("factory_dispatch_order_consolidations_final_invoice_ck");
    expect(sql).toContain("factory_dispatch_final_invoice_guard");
    expect(sql).toContain("factory_dispatch_final_invoice_number_uq");
  });
});
