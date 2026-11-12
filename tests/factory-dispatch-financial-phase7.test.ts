/** Phase 7 tests staged in GitHub. Per owner instruction, DO NOT RUN CI/tests. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateOrderDispatchReconciliation,
  type OrderReconciliationInput,
} from "../server/routes/factory/customer-orders/loadingDispatchOrderReconciliationModel";

function fixture(): OrderReconciliationInput {
  return {
    companyId: 4, orderId: 122, status: "LOADING", deleted: false, invoiceNumber: null,
    loaded: [
      { orderBaleId: 1, baleId: 11, baleReference: "B-11", articleCode: "A100", productName: "Shirts", weightKg: 12.5 },
      { orderBaleId: 2, baleId: 12, baleReference: "B-12", articleCode: "A100", productName: "Shirts", weightKg: 13.0 },
      { orderBaleId: 3, baleId: 13, baleReference: "B-13", articleCode: "B200", productName: "Jeans", weightKg: 10.0 },
    ],
    scans: [
      { scanId: "51",dispatchId: "21",dispatchNumber: 1,baleId:11,baleReference:"B-11",
        articleCode:"A100",productName:"Shirts",weightKg:12.5,scannedBy:"A",scannedAt:"2026-11-10T06:00Z" },
      { scanId: "52",dispatchId: "22",dispatchNumber: 2,baleId:12,baleReference:"B-12",
        articleCode:"A100",productName:"Shirts",weightKg:13,scannedBy:"B",scannedAt:"2026-11-10T06:00Z" },
    ],
    trips: [
      {id:"21",dispatchNumber:1,status:"CLOSED",truckPlate:null},
      {id:"22",dispatchNumber:2,status:"CLOSED",truckPlate:null},
    ],
    financials: [
      {
        dispatchId:"21",status:"POSTED",revision:1,financialId:"101",postingId:"501",
        postingVerified:true,sourceFingerprint:"a".repeat(64),goodsSubtotal:"10.00",
        billableChargesTotal:"2.00",discountTotal:"1.00",customerTotal:"11.00",
        exportedPoNumber:null,exportedAt:null,
        financialBales:[{baleId:11,baleReference:"B-11",articleCode:"A100",weightKg:"12.500",lineTotal:"10.00"}],
      },{
        dispatchId:"22",status:"POSTED",revision:1,financialId:"102",postingId:"502",
        postingVerified:true,sourceFingerprint:"b".repeat(64),goodsSubtotal:"20.00",
        billableChargesTotal:"3.00",discountTotal:"0.00",customerTotal:"23.00",
        exportedPoNumber:null,exportedAt:null,
        financialBales:[{baleId:12,baleReference:"B-12",articleCode:"A100",weightKg:"13.000",lineTotal:"20.00"}],
      },
    ],
    orderCharges:[],
  };
}
describe("Phase 7 all-truck financial reconciliation", () => {
  it("reports exact missing Pending Loading references before approval", () => {
    const r=calculateOrderDispatchReconciliation(fixture());
    expect(r.ready).toBe(false);
    expect(r.summary.unshippedBales).toBe(1);
    expect(r.missingBales.map(b=>b.baleReference)).toEqual(["B-13"]);
    expect(r.summary.physicallyScannedBales).toBe(2);
    expect(r.summary.postedTrips).toBe(2);
  });
  it("can sign off when the actually unshipped bale is removed and both trips match",()=>{
    const src=fixture();src.loaded=src.loaded.slice(0,2);
    const r=calculateOrderDispatchReconciliation(src);
    expect(r.ready).toBe(true);
    expect(r.blockingReasons).toEqual([]);
    expect(r.summary.customerTotal).toBe("34.00");
    expect(r.summary.goodsSubtotal).toBe("30.00");
    expect(r.summary.billableChargesTotal).toBe("5.00");
    expect(r.summary.discountTotal).toBe("1.00");
    expect(r.includedPostingIds).toEqual(["501","502"]);
  });
  it("rejects duplicate physical barcode across two trucks",()=>{
    const src=fixture();src.loaded=src.loaded.slice(0,2);
    src.scans.push({...src.scans[0],scanId:"53",dispatchId:"22",dispatchNumber:2});
    const r=calculateOrderDispatchReconciliation(src);
    expect(r.ready).toBe(false);
    expect(r.duplicateScans).toHaveLength(1);
  });
  it("refuses unfinished or non-posted financial trip",()=>{
    const src=fixture();src.loaded=src.loaded.slice(0,2);
    src.trips[1].status="OPEN";
    src.financials[1].status="DRAFT";
    src.financials[1].postingId=null;
    expect(calculateOrderDispatchReconciliation(src).blockingReasons)
      .toContain("Every dispatch trip must be physically closed");
    expect(calculateOrderDispatchReconciliation(src).blockingReasons)
      .toContain("Every physically closed trip must have one valid financial POST");
  });
  it("refuses a signed financial source that does not match physical scanned evidence",()=>{
    const src=fixture();src.loaded=src.loaded.slice(0,2);
    src.financials[0].financialBales[0].baleReference="REPLACED";
    const r=calculateOrderDispatchReconciliation(src);
    expect(r.ready).toBe(false);
    expect(r.blockingReasons).toContain("Signed financial bales do not match the original order and physical scans");
  });
  it("requires live source vouchers, exact goods sum and unique posting IDs",()=>{
    const src=fixture();src.loaded=src.loaded.slice(0,2);
    src.financials[0].postingVerified=false;
    src.financials[1].postingId="501";
    src.financials[0].goodsSubtotal="12.00";
    const r=calculateOrderDispatchReconciliation(src);
    expect(r.ready).toBe(false);
    expect(r.blockingReasons).toContain("A financially posted trip has missing, reversed or inconsistent source vouchers");
    expect(r.blockingReasons).toContain("Signed trip line totals do not match financially posted goods");
    expect(r.blockingReasons).toContain("The same financial posting was assigned to multiple trips");
  });
  it("records separate legacy order charges without double-counting trip receivables",()=>{
    const src=fixture();src.loaded=src.loaded.slice(0,2);
    src.orderCharges=[{id:7,name:"Handling",amount:"25.00"}];
    const r=calculateOrderDispatchReconciliation(src);
    expect(r.ready).toBe(true);
    expect(r.summary.customerTotal).toBe("34.00");
    expect(r.summary.existingOrderChargeTotal).toBe("25.00");
    expect(r.warnings.some(w=>w.includes("duplicate customer billing"))).toBe(true);
  });
  it("keeps the signed fingerprint stable across later manual PO Excel generation",()=>{
    const src=fixture();src.loaded=src.loaded.slice(0,2);
    const initial=calculateOrderDispatchReconciliation(src);
    src.financials[0].exportedAt="2026-11-10T09:00:00Z";
    src.financials[0].exportedPoNumber="FDPO-4-122-21";
    const exported=calculateOrderDispatchReconciliation(src);
    expect(exported.fingerprint).toBe(initial.fingerprint);
    expect(exported.trips[0].erpPoFileStatus).toBe("GENERATED_NOT_CONFIRMED_IMPORTED");
  });
  it("keeps unshipped removal atomic, audited and separate from final invoice posting",()=>{
    const read=(p:string)=>fs.readFileSync(path.join(process.cwd(),p),"utf8");
    const routes=read("server/routes/factory/customer-orders/loadingDispatchOrderReconciliationRoutes.ts");
    const page=read("client/src/pages/factory/FactoryLoadingDispatchCompare.tsx");
    const source=read("server/routes/factory/customer-orders/bale-scanning/remove.ts");
    const ddl=read("docs/sql/manual/2026-11-10-factory-dispatch-phase7-order-reconciliation.sql");
    expect(routes).toContain("await db.transaction(async tx=>");
    expect(routes).toContain("ORDER_UNSHIPPED_BALES_REMOVED");
    expect(routes).toContain("ORDER_DISPATCH_RECONCILIATION_APPROVED");
    expect(routes).toContain("reconciliation_fingerprint");
    expect(page).toContain('"/remove-unshipped"');
    expect(page).not.toContain('"?source=dispatch-reconciliation"');
    expect(source).toContain("USE_ATOMIC_DISPATCH_RECONCILIATION");
    expect(ddl).toContain("factory_dispatch_signed_order_bale_guard");
    expect(ddl).toContain("factory_dispatch_signed_financial_guard");
    expect(ddl).toContain("factory_dispatch_signed_consolidation_guard");
    expect(routes).not.toContain("postFactoryVoucherTx(");
  });
});
