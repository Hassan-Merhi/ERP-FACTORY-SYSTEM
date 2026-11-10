/**
 * Phase 8: ONE combined Factory invoice for a supervisor-signed multi-truck order.
 *
 * The existing trip POST journals ALREADY debit customer receivable and credit
 * clearing/customer-charge income. This path must NEVER create another full
 * invoice receivable or call syncFactoryInvoiceTx / legacy /finalize.
 *
 * New journals: Dr Dispatch Clearing / Cr Bale Sales Income (goods ONLY);
 * optional Dr COGS / Cr Finished Goods at company's active inventory cut-over;
 * and any unposted original loading charges EXACTLY ONCE, each with its own
 * customer voucher. All effects and one invoice number commit in ONE tx.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { MoneyDecimal, sumMoney } from "../../../lib/money";
import { customerLedgerAccountTx } from "../../../services/accounting/perpetualInventory/factoryInvoice";
import { isPerpetualInventoryActive } from "../../../services/accounting/perpetualInventory/cutover";
import { ledgerAccountByCodeTx, systemAccountIdsTx } from "../../../services/accounting/perpetualInventory/linkedJournal";
import { postFactoryVoucherTx } from "../../../services/factory/factoryVoucherPosting";
import { writeDaybookEntry } from "../_helpers";
import { customerOrderLines,
  customerOrders, factoryBales, customerOrderCharges,
} from "@shared/schema";
import {
  loadOrderDispatchReconciliationTx,
  type OrderReconciliationScope,
} from "./loadingDispatchOrderReconciliationData";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "./priorityScanQueue";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { OrderReconciliationError } from "./loadingDispatchOrderReconciliationModel";
import { assertFactoryDispatchReleaseReadyTx } from "../../../services/factory/dispatchReleaseReadiness";

const arr = async (tx:DbTransaction,q:ReturnType<typeof sql>)=>resultRows(await tx.execute(q));
const money=(v:unknown)=>new MoneyDecimal(String(v??"0"));
const moneyText=(v:unknown)=>{
  const text=String(v??"");
  if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(text)){
    raise("COMBINED_INVOICE_INVALID_AMOUNT","Financial source has an invalid two-decimal amount");
  }
  return money(text).toFixed(2);
};
const raise=(code:string,message:string,status=409):never=>{
  throw new OrderReconciliationError(code,message,status);
};
const costText=(v:unknown)=>{
  const raw=String(v??"");
  // Factory bale costs are NUMERIC(20,7): sum full precision, round once
  // for the final COGS voucher, matching existing Factory inventory accounting.
  if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,7})?$/.test(raw)){
    raise("COMBINED_INVOICE_COST_INVALID","A shipped bale has an invalid 7-decimal cost");
  }
  return new MoneyDecimal(raw);
};
const numberId=(v:unknown)=>{
  const n=Number(v);
  if(!Number.isSafeInteger(n)||n<1)raise("COMBINED_INVOICE_INVALID_ID","Invoice source has an invalid record ID");
  return n;
};
interface PostedBale {
  baleId:number;
  articleCode:string;
  productName:string;
  weightKg:string;
  lineTotal:string;
}
interface OriginalCharge {
  id:number;
  name:string;
  chargeType:string;
  amount:string;
  ledgerAccountId:number|null;
  voucherId:number|null;
  alreadyPosted:boolean;
}
export interface CombinedInvoiceScope extends OrderReconciliationScope {
  reason:string;
  postingDate:string;
}
export interface CombinedInvoicePlan {
  fingerprint:string;
  ready:boolean;
  blockingReasons:string[];
  tripCount:number;
  postingIds:string[];
  goodsSubtotal:string;
  tripBillableCharges:string;
  tripDiscounts:string;
  tripCustomerTotal:string;
  originalOrderCharges:string;
  finalInvoiceTotal:string;
  physicalBales:number;
  totalCost:string;
  postCOGS:boolean;
  originalCharges:OriginalCharge[];
  trips:Array<{dispatchId:string;dispatchNumber:number;customerTotal:string;postedBales:number}>;
}
interface LoadedPlan {plan:CombinedInvoicePlan; bales:PostedBale[]; customerId:number;}
const sameIds=(a:string[],b:string[])=>JSON.stringify(a.map(String).sort())===JSON.stringify(b.map(String).sort());
async function verifyOriginalChargeTx(
  tx:DbTransaction,s:OrderReconciliationScope,customerId:number,
  row:{
    id:unknown;name:unknown;chargeType:unknown;amount:unknown;
    ledgerAccountId:unknown;voucherId:unknown;
  }
):Promise<OriginalCharge>{
  const charge:OriginalCharge={
    id:numberId(row.id),name:String(row.name??"Charge"),
    chargeType:String(row.chargeType??"OTHER"),
    amount:moneyText(row.amount),
    ledgerAccountId:row.ledgerAccountId==null?null:numberId(row.ledgerAccountId),
    voucherId:row.voucherId==null?null:numberId(row.voucherId),
    alreadyPosted:false,
  };
  if(money(charge.amount).isZero())return charge;
  if(!charge.ledgerAccountId)raise("COMBINED_INVOICE_CHARGE_ACCOUNT_REQUIRED",
    `Original order charge "${charge.name}" needs a ledger account before the final invoice`);
  const [account]=await arr(tx,sql`
    SELECT id,account_type AS "accountType" FROM ledger_accounts
     WHERE id=${charge.ledgerAccountId} AND company_id=${s.companyId}
       AND active=TRUE AND is_hidden=FALSE AND deleted_at IS NULL
  `);
  if(!account || !/income|revenue|liability/i.test(String(account.accountType))){
    raise("COMBINED_INVOICE_CHARGE_ACCOUNT_INVALID",
      `Original order charge "${charge.name}" has no active, company-owned income/payable account`);
  }
  if(charge.voucherId){
    const [existing]=await arr(tx,sql`
      SELECT v.id,
        COALESCE(SUM(CASE WHEN ve.customer_id=${customerId}
          THEN ve.debit_amount-ve.credit_amount ELSE 0 END),0)::text AS "customerImpact",
        COALESCE(SUM(CASE WHEN ve.ledger_account_id=${charge.ledgerAccountId}
          AND ve.customer_id IS NULL THEN ve.credit_amount-ve.debit_amount
          ELSE 0 END),0)::text AS "chargeCredit"
      FROM vouchers v LEFT JOIN voucher_entries ve ON ve.voucher_id=v.id
       WHERE v.company_id=${s.companyId} AND v.id=${charge.voucherId}
        AND v.deleted_at IS NULL AND COALESCE(v.optional,FALSE)=FALSE
       GROUP BY v.id
    `);
    if(!existing || !money(existing.customerImpact).eq(money(charge.amount)) ||
       !money(existing.chargeCredit).eq(money(charge.amount))) {
      raise("COMBINED_INVOICE_CHARGE_ALREADY_POSTED_DIFFERENT",
        `Existing voucher for original charge "${charge.name}" does not match its customer amount`);
    }
    charge.alreadyPosted=true;
  } else {
    // Older loading workflows may have created a CHARGE-PRE voucher without
    // linking its FK. Refuse rather than double charge the customer.
    const [orphan]=await arr(tx,sql`
      SELECT id FROM vouchers WHERE company_id=${s.companyId}
       AND voucher_number=${"CHARGE-PRE-"+s.orderId+"-"+charge.id}
       AND deleted_at IS NULL LIMIT 1
    `);
    if(orphan)raise("COMBINED_INVOICE_PRECHARGE_REVIEW",
      `Original charge "${charge.name}" has an unlinked pre-invoice voucher; reconcile it first`);
  }
  return charge;
}
async function signedBalesTx(tx:DbTransaction,s:OrderReconciliationScope):Promise<PostedBale[]>{
  const rows=await arr(tx,sql`
    SELECT b.bale_id AS "baleId",b.article_code AS "articleCode",
           b.product_name AS "productName",b.weight_kg::text AS "weightKg",
           b.line_total::text AS "lineTotal"
     FROM factory_dispatch_trip_financial_bales b
     JOIN factory_dispatch_trip_financials f
       ON f.id=b.financial_id AND f.company_id=b.company_id
      AND f.order_id=b.order_id AND f.dispatch_id=b.dispatch_id
      AND b.snapshot_revision=f.snapshot_revision
    WHERE f.company_id=${s.companyId} AND f.order_id=${s.orderId}
      AND f.status='POSTED'
    ORDER BY b.bale_id
  `);
  return rows.map(r=>({
    baleId:numberId(r.baleId),
    articleCode:String(r.articleCode),productName:String(r.productName),
    weightKg:String(r.weightKg),lineTotal:moneyText(r.lineTotal),
  }));
}
/** Caller locks parent order, dispatches and signed consolidation first. */
export async function loadCombinedInvoicePlanTx(
  tx:DbTransaction,s:OrderReconciliationScope
):Promise<LoadedPlan>{
  const signedRows=await arr(tx,sql`
    SELECT id,status,reconciliation_fingerprint AS "fingerprint",
           included_posting_ids AS "postingIds",reconciled_at AS "reconciledAt",
           goods_subtotal::text AS goods,billable_charges_total::text AS billable,
           discount_total::text AS discounts,customer_total::text AS total
     FROM factory_dispatch_order_consolidations
    WHERE company_id=${s.companyId} AND order_id=${s.orderId} LIMIT 1
  `);
  const signed=signedRows[0];
  if(!signed || !signed.reconciledAt || signed.status!=="DRAFT"){
    raise("COMBINED_INVOICE_RECONCILIATION_REQUIRED",
      "Approve the exact all-truck reconciliation before creating the combined invoice");
  }
  const current=(await loadOrderDispatchReconciliationTx(tx,s)).result;
  const issues=[...current.blockingReasons];
  if(!current.ready || current.fingerprint!==signed.fingerprint){
    issues.push("The approved all-truck fingerprint no longer matches live physical and financial evidence");
  }
  if(!sameIds(current.includedPostingIds,
      Array.isArray(signed.postingIds)?signed.postingIds.map(String):[])){
    issues.push("Signed financial posting IDs no longer match the approved order");
  }
  for(const [name,a,b] of [
    ["goods",current.summary.goodsSubtotal,signed.goods],
    ["billable charges",current.summary.billableChargesTotal,signed.billable],
    ["discounts",current.summary.discountTotal,signed.discounts],
    ["customer total",current.summary.customerTotal,signed.total],
  ]){
    if(!money(a).eq(money(b)))issues.push("Signed "+name+" changed");
  }
  const [order]=await arr(tx,sql`
    SELECT customer_id AS "customerId",status,invoice_number AS "invoiceNumber",
           deleted_at AS "deletedAt" FROM customer_orders
    WHERE id=${s.orderId} AND company_id=${s.companyId}
  `);
  if(!order || order.deletedAt || order.invoiceNumber ||
     !["LOADING","PENDING_VERIFICATION"].includes(String(order.status))){
    issues.push("Original loading is already invoiced, cancelled or inactive");
  }
  const customerId=order?numberId(order.customerId):0;
  const bales=await signedBalesTx(tx,s);
  if(bales.length!==current.summary.physicallyScannedBales){
    issues.push("Signed financial bale count is not the exact total of shipped barcodes");
  }
  const unique=new Set(bales.map(b=>b.baleId));
  if(unique.size!==bales.length)issues.push("The same physical bale belongs to multiple invoice trips");
  if(!sumMoney(bales.map(b=>b.lineTotal)).eq(money(current.summary.goodsSubtotal))){
    issues.push("Frozen bale prices no longer match signed invoiced goods");
  }
  const originals=await tx.select({
    id:customerOrderCharges.id,name:customerOrderCharges.name,
    chargeType:customerOrderCharges.chargeType,amount:customerOrderCharges.amount,
    ledgerAccountId:customerOrderCharges.ledgerAccountId,
    voucherId:customerOrderCharges.voucherId,
  }).from(customerOrderCharges).where(eq(customerOrderCharges.orderId,s.orderId))
    .orderBy(customerOrderCharges.id);
  const originalCharges:OriginalCharge[]=[];
  for(const row of originals){
    originalCharges.push(await verifyOriginalChargeTx(tx,s,customerId,row));
  }
  const originalTotal=sumMoney(originalCharges.map(c=>c.amount));
  if(!originalTotal.eq(money(current.summary.existingOrderChargeTotal))){
    issues.push("Original order charges changed after signed reconciliation");
  }
  const finalTotal=money(current.summary.customerTotal).plus(originalTotal);
  if(finalTotal.lte(0))issues.push("Final customer invoice must be positive");
  let cost=new MoneyDecimal(0);
  if(bales.length){
    const ids=bales.map(b=>b.baleId);
    const physical=await arr(tx,sql`
      SELECT id,status,total_cost::text AS "totalCost"
      FROM factory_bales
      WHERE company_id=${s.companyId} AND id IN (${sql.join(ids.map(n=>sql`${n}`),sql`,`)})
      ORDER BY id
    `);
    if(physical.length!==bales.length){
      issues.push("A signed physical bale is missing from this Factory company");
    } else {
      for(const b of physical){
        if(["DELETED","SOLD"].includes(String(b.status))){
          issues.push("A signed physical bale was already sold or deleted before consolidation");
        }
        const c=String(b.totalCost??"");
        if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,7})?$/.test(c)){
          issues.push("A signed bale has an invalid or missing 7-decimal inventory cost");
        } else cost=cost.plus(c);
      }
    }
  }
  const previewDate="postingDate" in s && typeof s.postingDate==="string"
    ? s.postingDate : new Date().toISOString().slice(0,10);
  const postCOGS=await isPerpetualInventoryActive(tx,s.companyId,previewDate);
  return {
    bales,customerId,
    plan:{
      fingerprint:String(signed.fingerprint),
      ready:issues.length===0,blockingReasons:issues,
      tripCount:current.trips.length,postingIds:current.includedPostingIds,
      goodsSubtotal:current.summary.goodsSubtotal,
      tripBillableCharges:current.summary.billableChargesTotal,
      tripDiscounts:current.summary.discountTotal,
      tripCustomerTotal:current.summary.customerTotal,
      originalOrderCharges:originalTotal.toFixed(2),
      finalInvoiceTotal:finalTotal.toFixed(2),
      physicalBales:bales.length,totalCost:cost.toDecimalPlaces(2).toFixed(2),postCOGS,
      originalCharges,
      trips:current.trips.map(t=>({
        dispatchId:t.dispatchId,dispatchNumber:t.dispatchNumber,
        postedBales:t.postedBales,customerTotal:t.customerTotal,
      })),
    },
  };
}
async function invoiceNumberTx(tx:DbTransaction,companyId:number):Promise<string>{
  await tx.execute(sql`
    INSERT INTO customer_invoice_sequences(company_id,next_number)
    VALUES (${companyId},1) ON CONFLICT(company_id) DO NOTHING
  `);
  const [seq]=await arr(tx,sql`
    SELECT next_number AS "nextNumber"
     FROM customer_invoice_sequences WHERE company_id=${companyId} FOR UPDATE
  `);
  const n=numberId(seq?.nextNumber);
  const updated=await arr(tx,sql`
    UPDATE customer_invoice_sequences SET next_number=${n+1}
     WHERE company_id=${companyId} AND next_number=${n} RETURNING id
  `);
  if(updated.length!==1)raise("COMBINED_INVOICE_SEQUENCE_CHANGED","Invoice number sequence was modified concurrently");
  return "INV-"+String(n).padStart(6,"0");
}
async function rewriteCommercialLinesTx(tx:DbTransaction,s:OrderReconciliationScope,bales:PostedBale[]){
  const groups=new Map<string,{code:string;name:string;price:string;count:number;kg:InstanceType<typeof MoneyDecimal>}>();
  for(const b of bales){
    const code=b.articleCode.trim().toUpperCase();
    if(!code || !b.productName.trim())raise("COMBINED_INVOICE_ARTICLE_INVALID","A frozen bale has no article code or product name");
    const price=moneyText(b.lineTotal);
    const key=JSON.stringify([code,price,b.productName]);
    let group=groups.get(key);
    if(!group){group={code,name:b.productName,price,count:0,kg:new MoneyDecimal(0)};groups.set(key,group);}
    group.count++;group.kg=group.kg.plus(b.weightKg);
  }
  await tx.delete(customerOrderLines).where(eq(customerOrderLines.orderId,s.orderId));
  for(const g of [...groups.values()].sort((a,b)=>a.code.localeCompare(b.code)||a.price.localeCompare(b.price))){
    await tx.insert(customerOrderLines).values({
      orderId:s.orderId,articleCode:g.code,baleName:g.name,
      qty:g.count,weightPerBale:g.kg.div(g.count).toFixed(3),
      totalWeight:g.kg.toFixed(3),pricePerBale:g.price,
      totalPrice:money(g.price).mul(g.count).toFixed(2),
      pricingMode:"per_bale",pricePerKg:null,
    });
  }
}
async function writeFinanceEventTx(tx:DbTransaction,s:CombinedInvoiceScope,type:string,details:Record<string,unknown>){
  await tx.execute(sql`
    INSERT INTO factory_dispatch_financial_events
      (company_id,order_id,dispatch_id,financial_id,event_type,details,reason,actor_user_id,actor_username)
    VALUES (${s.companyId},${s.orderId},NULL,NULL,${type},
      ${JSON.stringify(details)}::jsonb,${s.reason},${s.userId},${s.username})
  `);
}
export interface CombinedInvoiceFinalResult {
  invoiceNumber:string;invoiceTotal:string;orderId:number;goodsSubtotal:string;
  voucherIds:number[];includedPostingIds:string[];tripCount:number;replayed:boolean;
  canonicalDocumentFrozen?:boolean;
}
export async function finalizeCombinedInvoiceTx(
  tx:DbTransaction,s:CombinedInvoiceScope,expectedFingerprint:string
):Promise<CombinedInvoiceFinalResult>{
  await assertFactoryDispatchReleaseReadyTx(tx,"FINAL_INVOICE");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE},${s.companyId})`);
  const [before]=await arr(tx,sql`
    SELECT id,proforma_id_used AS "proformaId"
    FROM customer_orders WHERE id=${s.orderId} AND company_id=${s.companyId}
  `);
  if(!before)raise("COMBINED_INVOICE_ORDER_NOT_FOUND","Loading order not found",404);
  if(before.proformaId){
    await acquireProformaCapacityTransactionLock(tx,{
      companyId:s.companyId,proformaId:Number(before.proformaId),
    });
  }
  const [order]=await arr(tx,sql`
    SELECT id,status,invoice_number AS "invoiceNumber",customer_id AS "customerId",
           deleted_at AS "deletedAt",previous_status AS "previousStatus"
    FROM customer_orders
    WHERE company_id=${s.companyId} AND id=${s.orderId} FOR UPDATE
  `);
  if(!order || order.deletedAt)raise("COMBINED_INVOICE_ORDER_INACTIVE","Original loading is unavailable");
  // Lock all physical trucks in deterministic order, exactly as in Phase 7.
  await tx.execute(sql`
    SELECT id FROM factory_loading_dispatches
    WHERE company_id=${s.companyId} AND order_id=${s.orderId}
    ORDER BY id FOR UPDATE
  `);
  const [consolidation]=await arr(tx,sql`
    SELECT id,status,reconciliation_fingerprint AS "fingerprint",
           invoice_number AS "invoiceNumber",finalization_details AS "details",
           customer_total::text AS "customerTotal"
    FROM factory_dispatch_order_consolidations
    WHERE company_id=${s.companyId} AND order_id=${s.orderId} FOR UPDATE
  `);
  if(consolidation?.status==="FINALIZED"){
    if(!order.invoiceNumber || order.status!=="FINALIZED" ||
       order.invoiceNumber!==consolidation.invoiceNumber ||
       consolidation.fingerprint!==expectedFingerprint ||
       !consolidation.details || typeof consolidation.details!=="object") {
      raise("COMBINED_INVOICE_REPLAY_CONFLICT","Existing invoice and signed consolidation do not match; accounting review required");
    }
    const detail=consolidation.details as Record<string,unknown>;
    return {
      invoiceNumber:String(consolidation.invoiceNumber),
      invoiceTotal:String(detail.finalInvoiceTotal),
      orderId:s.orderId,goodsSubtotal:String(detail.goodsSubtotal),
      voucherIds:Array.isArray(detail.voucherIds)?detail.voucherIds.map(numberId):[],
      includedPostingIds:Array.isArray(detail.includedPostingIds)?detail.includedPostingIds.map(String):[],
      tripCount:Number(detail.tripCount),replayed:true,
    };
  }
  if(!consolidation || consolidation.status!=="DRAFT" ||
     !consolidation.fingerprint || consolidation.fingerprint!==expectedFingerprint){
    raise("COMBINED_INVOICE_RECONCILIATION_CHANGED","Reconcile and approve all truck trips again before invoicing");
  }
  const {plan,bales,customerId}=await loadCombinedInvoicePlanTx(tx,s);
  if(!plan.ready)raise("COMBINED_INVOICE_BLOCKED",plan.blockingReasons.join("; "));
  if(plan.fingerprint!==expectedFingerprint)raise("COMBINED_INVOICE_SOURCE_CHANGED","Financial source changed since preview");
  if(s.postingDate.length!==10 || !/^\d{4}-\d{2}-\d{2}$/.test(s.postingDate) ||
     Number.isNaN(Date.parse(s.postingDate+"T00:00:00Z"))){
    raise("COMBINED_INVOICE_DATE_INVALID","Select a valid invoice posting date",400);
  }
  const actualInventoryCutover=await isPerpetualInventoryActive(tx,s.companyId,s.postingDate);
  // A prior invoice journal or receivable cache means a separate flow has
  // already billed the customer. Never silently overwrite it.
  const [prior]=await arr(tx,sql`
    SELECT 1 FROM customer_balances
    WHERE company_id=${s.companyId} AND reference_type='INVOICE'
      AND reference_id=${s.orderId} AND transaction_type='SALE' LIMIT 1
  `);
  const [priorLegacyJournal]=await arr(tx,sql`
    SELECT 1 FROM vouchers WHERE company_id=${s.companyId}
      AND voucher_number=${"INV-GL-"+s.companyId+"-"+s.orderId}
      AND deleted_at IS NULL AND COALESCE(optional,FALSE)=FALSE LIMIT 1
  `);
  if(prior || priorLegacyJournal){
    raise("COMBINED_INVOICE_ALREADY_BILLED","Existing invoice receivable or legacy journal found; resolve before consolidating");
  }
  // Lock actual bales and ensure no earlier SOLD/DELETED stock offload. Only
  // the exact frozen financially posted bales may move to SOLD.
  const baleIds=bales.map(b=>b.baleId);
  const locked=await arr(tx,sql`
    SELECT id,status,total_cost::text AS "totalCost" FROM factory_bales
    WHERE company_id=${s.companyId}
      AND id IN (${sql.join(baleIds.map(n=>sql`${n}`),sql`,`)})
    ORDER BY id FOR UPDATE
  `);
  if(locked.length!==baleIds.length || locked.some(b=>["SOLD","DELETED"].includes(String(b.status)))){
    raise("COMBINED_INVOICE_BALE_INVALID","One of the signed shipped bales was already sold or is missing");
  }
  const inventoryCost=sumMoney(locked.map(b=>costText(b.totalCost)))
    .toDecimalPlaces(2).toFixed(2);
  if(inventoryCost!==plan.totalCost){
    raise("COMBINED_INVOICE_COST_CHANGED","Shipped bale inventory costs changed; refresh the invoice preview");
  }
  // Original charges may already be posted as pre-invoice charges; do not post
  // them again. Missing ones get exactly one engine source identity per charge.
  // The final invoice must preserve ALL original charge voucher identities,
  // not only vouchers created during Phase 8. Pre-posted charge vouchers are
  // part of the same immutable combined invoice and must be guarded too.
  const originalChargesVoucherIds:number[]=plan.originalCharges
    .filter(c=>money(c.amount).gt(0) && c.alreadyPosted && c.voucherId!==null)
    .map(c=>c.voucherId!);
  if(new Set(originalChargesVoucherIds).size!==originalChargesVoucherIds.length){
    raise("COMBINED_INVOICE_DUPLICATE_ORIGINAL_CHARGE_VOUCHER",
      "Multiple original loading charges reference the same existing voucher; manual accounting reconciliation required");
  }
  if(plan.originalCharges.some(c=>money(c.amount).gt(0) && !c.alreadyPosted)){
    const customerLedger=await customerLedgerAccountTx(tx,s.companyId,customerId);
    for(const c of plan.originalCharges){
      if(money(c.amount).isZero()||c.alreadyPosted)continue;
      const {voucher}=await postFactoryVoucherTx(tx,{
        companyId:s.companyId,
        voucherNumber:`FDOC-${s.companyId}-${s.orderId}-${c.id}`,
        voucherDate:s.postingDate,
        description:`Original order charge: ${c.name}, consolidated loading ${s.orderId}`,
        source:{sourceType:"factory-dispatch-order-charge",
          sourceId:`${s.companyId}:${s.orderId}:${c.id}`,phase:"invoice"},
        actor:{userId:s.userId,username:s.username},
        lines:[
          {ledgerAccountId:customerLedger,customerId,debit:money(c.amount),narration:c.name},
          {ledgerAccountId:c.ledgerAccountId!,credit:money(c.amount),narration:c.name},
        ],
      });
      originalChargesVoucherIds.push(voucher.id);
      await tx.update(customerOrderCharges).set({voucherId:voucher.id})
        .where(and(eq(customerOrderCharges.id,c.id),eq(customerOrderCharges.orderId,s.orderId)));
    }
  }
  const invoiceNumber=await invoiceNumberTx(tx,s.companyId);
  const voucherIds:number[]=[];
  if(money(plan.goodsSubtotal).gt(0)){
    const clearing=await ledgerAccountByCodeTx(tx,s.companyId,
      "FACTORY_DISPATCH_CLEARING","Factory Dispatch Clearing","Liability");
    const revenue=await ledgerAccountByCodeTx(tx,s.companyId,
      "FACTORY_BALE_SALES_INCOME","Factory Bale Sales Income","Income");
    const {voucher}=await postFactoryVoucherTx(tx,{
      companyId:s.companyId,
      voucherNumber:`FDINV-${s.companyId}-${s.orderId}-CLEARING`,
      voucherDate:s.postingDate,
      description:`Combined invoice ${invoiceNumber}: move posted truck goods from clearing to sales`,
      source:{sourceType:"factory-dispatch-combined-invoice",sourceId:`${s.companyId}:${s.orderId}`,phase:"clearing"},
      actor:{userId:s.userId,username:s.username},
      lines:[
        {ledgerAccountId:clearing,debit:money(plan.goodsSubtotal),narration:"Recognize already-posted trip goods"},
        {ledgerAccountId:revenue,credit:money(plan.goodsSubtotal),narration:"Combined Factory goods sales"},
      ],
    });
    voucherIds.push(voucher.id);
  }
  if(actualInventoryCutover && money(inventoryCost).gt(0)){
    const accounts=await systemAccountIdsTx(tx,s.companyId,["COGS","FACTORY_FINISHED_GOODS"]);
    const {voucher}=await postFactoryVoucherTx(tx,{
      companyId:s.companyId,
      voucherNumber:`FDINV-${s.companyId}-${s.orderId}-COGS`,
      voucherDate:s.postingDate,
      description:`Combined invoice ${invoiceNumber}: cost of only shipped bales`,
      source:{sourceType:"factory-dispatch-combined-invoice",sourceId:`${s.companyId}:${s.orderId}`,phase:"cogs"},
      actor:{userId:s.userId,username:s.username},
      lines:[
        {ledgerAccountId:accounts.get("COGS")!,debit:money(inventoryCost),narration:"Signed sold bales COGS"},
        {ledgerAccountId:accounts.get("FACTORY_FINISHED_GOODS")!,credit:money(inventoryCost),narration:"Signed sold bales released"},
      ],
    });
    voucherIds.push(voucher.id);
  }
  voucherIds.push(...originalChargesVoucherIds);
  // The order's commercial lines are derived from immutable trip bale
  // prices, not an editable per-kg proforma recomputation after trip posting.
  await rewriteCommercialLinesTx(tx,s,bales);
  const changed=await tx.update(factoryBales).set({status:"SOLD",updatedAt:new Date()})
    .where(and(eq(factoryBales.companyId,s.companyId),inArray(factoryBales.id,baleIds)))
    .returning({id:factoryBales.id});
  if(changed.length!==baleIds.length)raise("COMBINED_INVOICE_BALE_UPDATE_FAILED","Could not finalize every shipped bale");
  // Metadata under the SAME order row; no duplicate SALE cache row is created.
  await tx.update(customerOrders).set({
    status:"FINALIZED",invoiceNumber,previousStatus:"LOADING",
    finalizedAt:new Date(),updatedAt:new Date(),
    subtotalBales:plan.goodsSubtotal,
    // Freight/Other from original loading remain charge aggregates;
    // posted trip fees/discounts live in signed trip charge rows, not as
    // duplicate customer_order_charges to be journaled by legacy paths.
    grandTotal:plan.finalInvoiceTotal,totalQtyBales:bales.length,
  }).where(and(eq(customerOrders.companyId,s.companyId),eq(customerOrders.id,s.orderId)));
  const [changedFinancials]=await arr(tx,sql`
    SELECT COUNT(*)::integer AS count FROM factory_dispatch_trip_financials
    WHERE company_id=${s.companyId} AND order_id=${s.orderId}
     AND status='POSTED'
  `);
  if(Number(changedFinancials?.count)!==plan.tripCount){
    raise("COMBINED_INVOICE_TRIPS_CHANGED","Truck financial status changed during finalization");
  }
  const changedRows=await arr(tx,sql`
    UPDATE factory_dispatch_trip_financials
      SET status='CONSOLIDATED',updated_at=NOW()
    WHERE company_id=${s.companyId} AND order_id=${s.orderId}
      AND status='POSTED'
    RETURNING id
  `);
  if(changedRows.length!==plan.tripCount)raise("COMBINED_INVOICE_TRIPS_CHANGED","Not all posted trips could be consolidated");
  const finalDetails={
    version:1,invoiceNumber,postedAt:new Date().toISOString(),postingDate:s.postingDate,
    finalInvoiceTotal:plan.finalInvoiceTotal,goodsSubtotal:plan.goodsSubtotal,
    tripCustomerTotal:plan.tripCustomerTotal,tripBillableCharges:plan.tripBillableCharges,
    tripDiscounts:plan.tripDiscounts,originalOrderCharges:plan.originalOrderCharges,
    includedPostingIds:plan.postingIds,tripCount:plan.tripCount,
    trips:plan.trips,shippedBales:baleIds.length,
    customerReceivableReposted:false,
    inventoryCost,perpetualCOGSPosted:actualInventoryCutover,
    voucherIds,originalChargeVoucherIds:originalChargesVoucherIds,
  };
  const finalized=await arr(tx,sql`
    UPDATE factory_dispatch_order_consolidations
      SET status='FINALIZED',invoice_number=${invoiceNumber},
          finalized_at=NOW(),finalized_by_user_id=${s.userId},
          finalization_details=${JSON.stringify(finalDetails)}::jsonb,
          updated_at=NOW()
    WHERE company_id=${s.companyId} AND order_id=${s.orderId}
      AND status='DRAFT' AND reconciled_at IS NOT NULL
      AND reconciliation_fingerprint=${expectedFingerprint}
    RETURNING id
  `);
  if(finalized.length!==1)raise("COMBINED_INVOICE_ALREADY_FINALIZED","Combined invoice was already finalized");
  // Daybook is operational history, NOT a second customer ledger journal.
  await writeDaybookEntry(tx,{
    companyId:s.companyId,txDate:s.postingDate,txType:"INVOICE",
    referenceId:s.orderId,referenceTable:"customer_orders",
    description:`Combined invoice ${invoiceNumber} — ${plan.tripCount} posted truck trips`,
    currencyCode:"USD",amountCurrency:money(plan.finalInvoiceTotal).toNumber(),
    amountUsd:money(plan.finalInvoiceTotal).toNumber(),createdBy:s.username,
    metaJson:JSON.stringify({
      consolidatedDispatch:true,tripCount:plan.tripCount,
      signedFingerprint:plan.fingerprint,alreadyPostedReceivable:true,
    }),
  });
  await writeFinanceEventTx(tx,s,"ORDER_DISPATCH_COMBINED_INVOICE_FINALIZED",{
    invoiceNumber,invoiceTotal:plan.finalInvoiceTotal,postedTrips:plan.tripCount,
    signedFingerprint:plan.fingerprint,existingTripPostingIds:plan.postingIds,
    finalVoucherIds:voucherIds,customerReceivableReposted:false,
    cogsPosted:actualInventoryCutover,
  });
  return {
    invoiceNumber,invoiceTotal:plan.finalInvoiceTotal,
    goodsSubtotal:plan.goodsSubtotal,orderId:s.orderId,
    voucherIds,includedPostingIds:plan.postingIds,tripCount:plan.tripCount,replayed:false,
  };
}
