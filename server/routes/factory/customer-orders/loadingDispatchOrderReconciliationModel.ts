/**
 * Phase 7 — deterministic order-wide reconciliation.
 * No expected bale allocations per truck: physically signed scans are evidence.
 * This pure builder refuses mismatched goods, unexpected/duplicate barcodes,
 * missing order bales, unposted trips, and incorrect signed financial snapshots.
 */
import { createHash } from "node:crypto";
import { MoneyDecimal, sumMoney } from "../../../lib/money";
import type {
  ComparisonBale, ComparisonScan, ComparisonTrip,
} from "./loadingDispatchComparison";

export type FinancialTripStatus = "DRAFT" | "POSTED" | "REVERSED" | "CONSOLIDATED" | "MISSING";
export interface OrderFinancialTripEvidence {
  dispatchId: string;
  status: FinancialTripStatus;
  revision: number;
  financialId: string | null;
  postingId: string | null;
  sourceFingerprint: string | null;
  goodsSubtotal: string;
  billableChargesTotal: string;
  discountTotal: string;
  customerTotal: string;
  exportedPoNumber: string | null;
  exportedAt: string | null;
  financialBales: Array<{
    baleId: number; baleReference: string; articleCode: string;
    weightKg: string; lineTotal: string;
  }>;
}
export interface OrderReconciliationInput {
  companyId: number;
  orderId: number;
  status: string;
  deleted: boolean;
  invoiceNumber: string | null;
  loaded: ComparisonBale[];
  scans: ComparisonScan[];
  trips: ComparisonTrip[];
  financials: OrderFinancialTripEvidence[];
  orderCharges: Array<{ id: number; name: string; amount: string }>;
}
export interface OrderReconciliationTrip {
  dispatchId: string;
  dispatchNumber: number;
  physicalStatus: string;
  financialStatus: FinancialTripStatus;
  postingId: string | null;
  financialId: string | null;
  revision: number;
  physicallyScannedBales: number;
  postedBales: number;
  goodsSubtotal: string;
  billableChargesTotal: string;
  discountTotal: string;
  customerTotal: string;
  erpPoFileStatus: "GENERATED_NOT_CONFIRMED_IMPORTED" | "NOT_GENERATED";
  exportedPoNumber: string | null;
}
export interface OrderReconciliationResult {
  fingerprint: string;
  ready: boolean;
  blockingReasons: string[];
  summary: {
    originalLoadedBales: number; physicallyScannedBales: number;
    signedFinancialBales: number; unshippedBales: number;
    unexpectedScans: number; duplicateScans: number;
    goodsSubtotal: string; billableChargesTotal: string; discountTotal: string;
    customerTotal: string; existingOrderChargeTotal: string;
    tripCount: number; postedTrips: number; openTrips: number;
  };
  missingBales: ComparisonBale[];
  unexpectedScans: ComparisonScan[];
  duplicateScans: ComparisonScan[];
  trips: OrderReconciliationTrip[];
  includedPostingIds: string[];
  warnings: string[];
}
export class OrderReconciliationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = "OrderReconciliationError";
  }
}
const fail = (code: string, message: string): never => { throw new OrderReconciliationError(code, message); };
function safeMoney(s: string): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(s)) fail("RECONCILIATION_INVALID_AMOUNT", "Financial posting has an invalid monetary amount");
  return new MoneyDecimal(s).toFixed(2);
}
function kg(value: string | number): string {
  const v = String(value);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(v)) fail("RECONCILIATION_INVALID_KG", "Trip bale has invalid KG");
  return new MoneyDecimal(v).toFixed(3);
}
const canonicalArticle = (article: string) => article.trim().toUpperCase();
function amount(value: string): MoneyDecimal { return new MoneyDecimal(safeMoney(value)); }
function key(id: unknown): string { return String(id ?? ""); }
export function calculateOrderDispatchReconciliation(input: OrderReconciliationInput): OrderReconciliationResult {
  if (![input.companyId,input.orderId].every(v=>Number.isSafeInteger(v) && v>0)) fail("RECONCILIATION_ID_INVALID", "Invalid company or order");
  const issues = new Set<string>();
  const warnings: string[] = [];
  if (input.deleted || !["LOADING","PENDING_VERIFICATION","VERIFIED"].includes(input.status) || input.invoiceNumber) {
    issues.add("Order must be active and not already invoiced");
  }
  if (!input.trips.length) issues.add("Create and close at least one physical dispatch trip");
  const tripMap = new Map<string, ComparisonTrip>();
  for (const trip of input.trips) {
    if (tripMap.has(trip.id)) issues.add("Repeated physical dispatch trip ID");
    tripMap.set(trip.id, trip);
    if (trip.status !== "CLOSED") issues.add("Every dispatch trip must be physically closed");
  }
  const loaded = new Map<number, ComparisonBale>();
  for (const bale of input.loaded) {
    if (!Number.isSafeInteger(bale.baleId) || bale.baleId <= 0 || loaded.has(bale.baleId)) {
      issues.add("Pending Loading contains repeated or invalid bale identifiers");
    }
    loaded.set(bale.baleId, bale);
  }
  const scanned = new Map<number, ComparisonScan>();
  const duplicateScans: ComparisonScan[] = [];
  const unexpectedScans: ComparisonScan[] = [];
  for (const scan of input.scans) {
    if (scanned.has(scan.baleId)) duplicateScans.push(scan);
    else scanned.set(scan.baleId, scan);
    const loadedBale = loaded.get(scan.baleId);
    if (!loadedBale || !tripMap.has(scan.dispatchId)) {
      unexpectedScans.push(scan);
    } else if (loadedBale.baleReference !== scan.baleReference ||
      canonicalArticle(loadedBale.articleCode) !== canonicalArticle(scan.articleCode) ||
      kg(loadedBale.weightKg) !== kg(scan.weightKg)) {
      unexpectedScans.push(scan);
    }
  }
  if (duplicateScans.length) issues.add("A bale was scanned on more than one truck");
  if (unexpectedScans.length) issues.add("Unexpected, missing-from-loading, or changed scanned bale references");
  const missingBales = input.loaded.filter(b=>!scanned.has(b.baleId)).sort((a,b)=>a.baleId-b.baleId);
  if (missingBales.length) issues.add("Remove or resolve unshipped Pending Loading bales before approving the final order");
  if (scanned.size === 0) issues.add("No physically scanned bales on any trip");
  const financialMap = new Map<string, OrderFinancialTripEvidence>();
  for(const f of input.financials) {
    if(financialMap.has(f.dispatchId) || !tripMap.has(f.dispatchId)) issues.add("Unexpected or repeated financial trip record");
    financialMap.set(f.dispatchId,f);
  }
  const postingIds: string[] = [];
  const tr: OrderReconciliationTrip[] = [];
  const billedBaleIds = new Set<number>();
  for(const trip of input.trips) {
    const f=financialMap.get(trip.id);
    const scansForTrip=input.scans.filter(s=>s.dispatchId===trip.id);
    if(!f || !["POSTED","CONSOLIDATED"].includes(f.status) || !f.sourceFingerprint ||
       !/^[a-f0-9]{64}$/.test(f.sourceFingerprint) || !f.postingId || !/^[1-9][0-9]*$/.test(f.postingId) ||
       f.revision<1) issues.add("Every physically closed trip must have one valid financial POST");
    if(f?.postingId) postingIds.push(f.postingId);
    const financialBales = f?.financialBales ?? [];
    const signedMap = new Map<number, OrderFinancialTripEvidence["financialBales"][number]>();
    for(const b of financialBales){
      if(signedMap.has(b.baleId) || billedBaleIds.has(b.baleId)) issues.add("A signed financial bale appears more than once");
      signedMap.set(b.baleId,b); billedBaleIds.add(b.baleId);
    }
    if(financialBales.length!==scansForTrip.length) issues.add("Physical scan count differs from financially posted bales");
    for(const scan of scansForTrip){
      const frozen=signedMap.get(scan.baleId);
      if(!frozen || frozen.baleReference!==scan.baleReference ||
         canonicalArticle(frozen.articleCode)!==canonicalArticle(scan.articleCode) ||
         kg(frozen.weightKg)!==kg(scan.weightKg) || !loaded.has(scan.baleId)) {
        issues.add("Signed financial bales do not match the original order and physical scans");
      }
    }
    if(f && !sumMoney(financialBales.map(b=>safeMoney(b.lineTotal))).eq(amount(f.goodsSubtotal))){
      issues.add("Signed trip line totals do not match financially posted goods");
    }
    if(f && !amount(f.goodsSubtotal).plus(f.billableChargesTotal).minus(f.discountTotal).eq(amount(f.customerTotal))){
      issues.add("Financial trip customer total does not reconcile with charges and discounts");
    }
    tr.push({
      dispatchId:trip.id,dispatchNumber:trip.dispatchNumber,physicalStatus:trip.status,
      financialStatus:f?.status??"MISSING",financialId:f?.financialId??null,
      postingId:f?.postingId??null,revision:f?.revision??0,
      physicallyScannedBales:scansForTrip.length,postedBales:financialBales.length,
      goodsSubtotal:f?.goodsSubtotal??"0.00",billableChargesTotal:f?.billableChargesTotal??"0.00",
      discountTotal:f?.discountTotal??"0.00",customerTotal:f?.customerTotal??"0.00",
      erpPoFileStatus:f?.exportedAt?"GENERATED_NOT_CONFIRMED_IMPORTED":"NOT_GENERATED",
      exportedPoNumber:f?.exportedPoNumber??null,
    });
  }
  if(billedBaleIds.size!==scanned.size) issues.add("Signed financial coverage differs from physical truck scans");
  if(new Set(postingIds).size!==postingIds.length) issues.add("The same financial posting was assigned to multiple trips");
  const goodsSubtotal=sumMoney(tr.map(t=>safeMoney(t.goodsSubtotal))).toFixed(2);
  const billableChargesTotal=sumMoney(tr.map(t=>safeMoney(t.billableChargesTotal))).toFixed(2);
  const discountTotal=sumMoney(tr.map(t=>safeMoney(t.discountTotal))).toFixed(2);
  const customerTotal=sumMoney(tr.map(t=>safeMoney(t.customerTotal))).toFixed(2);
  const orderChargesTotal=sumMoney(input.orderCharges.map(c=>safeMoney(c.amount))).toFixed(2);
  if(input.orderCharges.some(c=>amount(c.amount).gt(0))){
    warnings.push("This loading has separate order-level charges. Phase 8 must classify them once and prevent duplicate customer billing; they are NOT included in signed trip totals.");
  }
  if(tr.some(t=>t.erpPoFileStatus==="NOT_GENERATED")){
    warnings.push("Some Factory trip PO Excel files have not been generated. ERP imports are manual and are not confirmed by this Factory-only preview.");
  } else if(tr.length){
    warnings.push("Generated PO files do not prove ERP actually imported or posted each truck. Verify in Normal ERP.");
  }
  const includedPostingIds=postingIds.slice().sort((a,b)=>Number(a)-Number(b));
  const fingerprint=createHash("sha256").update(JSON.stringify({
    version:1,companyId:input.companyId,orderId:input.orderId,status:input.status,
    loaded:[...input.loaded].sort((a,b)=>a.baleId-b.baleId),
    scans:[...input.scans].sort((a,b)=>a.scanId.localeCompare(b.scanId)),
    trips:[...input.trips].sort((a,b)=>a.id.localeCompare(b.id)),
    financials:[...input.financials].sort((a,b)=>a.dispatchId.localeCompare(b.dispatchId))
      .map(f=>({...f,financialBales:[...f.financialBales].sort((a,b)=>a.baleId-b.baleId)})),
    orderCharges:input.orderCharges.slice().sort((a,b)=>a.id-b.id),
  })).digest("hex");
  return {
    fingerprint,ready:issues.size===0,blockingReasons:[...issues],
    summary:{
      originalLoadedBales:input.loaded.length,physicallyScannedBales:input.scans.length,
      signedFinancialBales:[...input.financials].reduce((n,f)=>n+f.financialBales.length,0),
      unshippedBales:missingBales.length,unexpectedScans:unexpectedScans.length,
      duplicateScans:duplicateScans.length,goodsSubtotal,billableChargesTotal,
      discountTotal,customerTotal,existingOrderChargeTotal:orderChargesTotal,
      tripCount:input.trips.length,postedTrips:tr.filter(t=>t.financialStatus==="POSTED"||t.financialStatus==="CONSOLIDATED").length,
      openTrips:tr.filter(t=>t.physicalStatus!=="CLOSED").length,
    },
    missingBales,unexpectedScans,duplicateScans,trips:tr,includedPostingIds,warnings,
  };
}
