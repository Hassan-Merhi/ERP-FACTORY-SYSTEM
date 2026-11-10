/**
 * Phase 10 read-only ledger integrity audit.
 * This is separate from the mutation guard: it makes customer/clearing/
 * inventory double-posting checks visible after a combined invoice exists.
 * Never inserts/updates postings, adjusts balances or introspects other
 * company records (Normal ERP PO import is intentionally out of scope).
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal, sumMoney } from "../../lib/money";

export type DispatchIntegrityState="PASS"|"BLOCK"|"INFO"|"NOT_APPLICABLE";
export interface DispatchIntegrityCheck {
  code:string;state:DispatchIntegrityState;message:string;
  expected?:string;observed?:string;
}
export interface DispatchInvoiceIntegrityReport {
  orderId:number;companyId:number;
  finalized:boolean;passed:boolean;
  expectedInvoiceTotal:string|null;originalTruckReceivable:string|null;
  checks:DispatchIntegrityCheck[];
  verifiedAt:string;
}
const str=(x:unknown)=>String(x??"");
const amount=(x:unknown)=>new MoneyDecimal(str(x??"0"));
const fixed=(x:unknown)=>amount(x).toDecimalPlaces(2).toFixed(2);
const num=(x:unknown)=>Number(x??0);
const list=(v:unknown)=>Array.isArray(v)?v.map(str):[];
const json=(v:unknown)=>v && typeof v==="object" && !Array.isArray(v) ? v as Record<string,unknown>:{};
const query=async(tx:DbTransaction,q:ReturnType<typeof sql>)=>resultRows(await tx.execute(q));

export async function auditFactoryDispatchInvoiceTx(
  tx:DbTransaction,companyId:number,orderId:number,
):Promise<DispatchInvoiceIntegrityReport>{
  const checks:DispatchIntegrityCheck[]=[];
  const pass=(code:string,message:string,ok:boolean,expected?:unknown,observed?:unknown)=>{
    checks.push({
      code,message,state:ok?"PASS":"BLOCK",
      ...(expected===undefined?{}:{expected:str(expected)}),
      ...(observed===undefined?{}:{observed:str(observed)}),
    });
  };
  const [order]=await query(tx,sql`
    SELECT o.id,o.customer_id AS "customerId",o.status,
      o.invoice_number AS "invoiceNumber",o.grand_total::text AS "grandTotal",
      c.status AS "combinedStatus",c.invoice_number AS "combinedInvoiceNumber",
      c.goods_subtotal::text AS "signedGoods",
      c.billable_charges_total::text AS "signedBillable",
      c.discount_total::text AS "signedDiscounts",
      c.customer_total::text AS "signedCustomerTotal",
      c.included_posting_ids AS "postingIds",
      c.finalization_details AS "finalDetails"
    FROM customer_orders o
    LEFT JOIN factory_dispatch_order_consolidations c
      ON c.company_id=o.company_id AND c.order_id=o.id
    WHERE o.company_id=${companyId} AND o.id=${orderId} LIMIT 1
  `);
  if(!order)throw new Error("LOADING_NOT_FOUND");
  const finalized=order.combinedStatus==="FINALIZED";
  const details=json(order.finalDetails);
  const trips=await query(tx,sql`
    SELECT f.id::text AS id,f.dispatch_id::text AS "dispatchId",
      f.status,f.goods_subtotal::text AS goods,
      f.billable_charges_total::text AS billable,
      f.discount_total::text AS discounts,
      f.customer_total::text AS total,
      f.posting_revision AS revision,
      p.id::text AS "postingId",p.voucher_ids AS "voucherIds"
    FROM factory_dispatch_trip_financials f
    LEFT JOIN factory_dispatch_trip_postings p
      ON p.company_id=f.company_id AND p.order_id=f.order_id
     AND p.dispatch_id=f.dispatch_id AND p.financial_id=f.id
     AND p.posting_revision=f.posting_revision AND p.kind='POST'
    WHERE f.company_id=${companyId} AND f.order_id=${orderId}
    ORDER BY f.dispatch_id
  `);
  const posted=trips.filter(t=>t.status==="POSTED"||t.status==="CONSOLIDATED");
  const expectedPosts=list(order.postingIds).sort();
  const actualPosts=posted.map(p=>str(p.postingId)).sort();
  const goods=sumMoney(posted.map(t=>str(t.goods))).toFixed(2);
  const billable=sumMoney(posted.map(t=>str(t.billable))).toFixed(2);
  const discounts=sumMoney(posted.map(t=>str(t.discounts))).toFixed(2);
  const receivable=sumMoney(posted.map(t=>str(t.total))).toFixed(2);
  pass("TRIP_POST_IDENTITIES","Every included truck has one original POST identity",
    posted.length>0 && posted.every(x=>x.postingId!=null) &&
      new Set(actualPosts).size===actualPosts.length &&
      JSON.stringify(actualPosts)===JSON.stringify(expectedPosts),
    expectedPosts.join(","),actualPosts.join(","));
  pass("SIGNED_TRIP_GOODS","Combined goods equal the sum of posted truck goods",
    goods===fixed(order.signedGoods),fixed(order.signedGoods),goods);
  pass("SIGNED_TRIP_CHARGES","Combined charges equal original truck billable fees",
    billable===fixed(order.signedBillable) && discounts===fixed(order.signedDiscounts),
    fixed(order.signedBillable)+" / "+fixed(order.signedDiscounts),billable+" / "+discounts);
  pass("SIGNED_TRIP_RECEIVABLE","Truck receivable is goods + billable fees - discounts",
    receivable===fixed(order.signedCustomerTotal) &&
      amount(goods).plus(billable).minus(discounts).eq(receivable),
    fixed(order.signedCustomerTotal),receivable);
  const [legacy]=await query(tx,sql`
    SELECT
      (SELECT COUNT(*)::integer FROM customer_balances b
       WHERE b.company_id=${companyId} AND b.reference_type='INVOICE'
         AND b.reference_id=${orderId} AND b.transaction_type='SALE') AS "legacySales",
      (SELECT COUNT(*)::integer FROM vouchers v
       WHERE v.company_id=${companyId}
         AND v.voucher_number=${"INV-GL-"+companyId+"-"+orderId}
         AND v.deleted_at IS NULL AND COALESCE(v.optional,FALSE)=FALSE) AS "legacyJournals"
  `);
  pass("NO_DUPLICATE_LEGACY_INVOICE","Do not create the legacy full-invoice customer debit",
    num(legacy?.legacySales)===0 && num(legacy?.legacyJournals)===0,
    "0 invoice cache rows, 0 legacy journals",
    num(legacy?.legacySales)+" cache rows, "+num(legacy?.legacyJournals)+" journals");
  const signedBales=await query(tx,sql`
    SELECT b.bale_id AS "baleId",fb.status,fb.total_cost::text AS "cost"
    FROM factory_dispatch_trip_financial_bales b
    JOIN factory_dispatch_trip_financials f ON f.id=b.financial_id
     AND f.company_id=b.company_id AND f.order_id=b.order_id
     AND f.dispatch_id=b.dispatch_id AND f.snapshot_revision=b.snapshot_revision
    LEFT JOIN factory_bales fb ON fb.id=b.bale_id AND fb.company_id=b.company_id
    WHERE b.company_id=${companyId} AND b.order_id=${orderId}
      AND f.status IN ('POSTED','CONSOLIDATED')
  `);
  const distinct=new Set(signedBales.map(b=>str(b.baleId)));
  pass("SIGNED_BALES_UNIQUE","Every financially posted bale appears in only one truck",
    distinct.size===signedBales.length,distinct.size,signedBales.length);
  if(finalized){
    pass("ONE_FINAL_INVOICE_IDENTITY","Parent order and final combined invoice are identical",
      order.status==="FINALIZED" &&
      order.invoiceNumber!=null &&
      order.invoiceNumber===order.combinedInvoiceNumber &&
      order.invoiceNumber===details.invoiceNumber,
      str(order.invoiceNumber),str(order.combinedInvoiceNumber));
    const origTotal=amount(details.originalOrderCharges);
    const invoiceTotal=amount(receivable).plus(origTotal).toFixed(2);
    pass("FINAL_INVOICE_TOTAL","One final commercial invoice equals original truck receivables plus order charges",
      amount(order.grandTotal).eq(invoiceTotal) &&
        amount(details.finalInvoiceTotal).eq(invoiceTotal),
      invoiceTotal,str(order.grandTotal));
    pass("NO_SECOND_TRIP_CUSTOMER_DEBIT","Invoice explicitly records no re-posting of original truck customer receivable",
      details.customerReceivableReposted===false,"false",String(details.customerReceivableReposted));
    pass("FINAL_INVOICE_TRIP_STATES","Every included truck becomes consolidated",
      trips.length===posted.length && posted.every(t=>t.status==="CONSOLIDATED"),
      str(trips.length),str(posted.filter(t=>t.status==="CONSOLIDATED").length));
    pass("SIGNED_BALES_SOLD_ONCE","Only signed bales are counted as delivered and each is SOLD",
      signedBales.length>0 && signedBales.every(b=>b.status==="SOLD") &&
        num(details.shippedBales)===signedBales.length,
      str(signedBales.length),str(signedBales.filter(b=>b.status==="SOLD").length));
    const [clearance]=await query(tx,sql`
      SELECT
        COALESCE(SUM(CASE WHEN la.code='FACTORY_DISPATCH_CLEARING'
          THEN ve.debit_amount-ve.credit_amount ELSE 0 END),0)::text AS "goodsClearingDebit",
        COALESCE(SUM(CASE WHEN la.code='FACTORY_BALE_SALES_INCOME'
          THEN ve.credit_amount-ve.debit_amount ELSE 0 END),0)::text AS "goodsSalesCredit",
        COALESCE(SUM(CASE WHEN ve.customer_id IS NOT NULL
          THEN ve.debit_amount-ve.credit_amount ELSE 0 END),0)::text AS "customerImpact"
      FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id=v.id
       LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=v.company_id
      WHERE v.company_id=${companyId}
        AND v.voucher_number=${"FDINV-"+companyId+"-"+orderId+"-CLEARING"}
        AND v.deleted_at IS NULL AND COALESCE(v.optional,FALSE)=FALSE
    `);
    pass("GOODS_CLEARING_TO_SALES","Single goods reclassification debits clearing, credits sales, and never touches customer",
      amount(clearance?.goodsClearingDebit).eq(goods) &&
      amount(clearance?.goodsSalesCredit).eq(goods) &&
      amount(clearance?.customerImpact).isZero(),
      goods+" clearing and sales, 0 customer",
      fixed(clearance?.goodsClearingDebit)+" / "+fixed(clearance?.goodsSalesCredit)+" / "+fixed(clearance?.customerImpact));
    const voucherIds=list(details.voucherIds);
    const vouchers=voucherIds.length ? await query(tx,sql`
      SELECT id::text AS id FROM vouchers
      WHERE company_id=${companyId}
        AND id IN (${sql.join(voucherIds.map(v=>sql`${v}`),sql`,`)})
        AND deleted_at IS NULL AND COALESCE(optional,FALSE)=FALSE
    `) : [];
    pass("FINAL_VOUCHERS_ACTIVE","All combined invoice clearing, cost and original order-charge vouchers exist",
      voucherIds.length===new Set(voucherIds).size &&
      voucherIds.length===vouchers.length,
      str(voucherIds.length),str(vouchers.length));
  }else{
    checks.push({
      code:"NOT_FINALIZED",state:"INFO",
      message:"This order has not yet finalized the single customer invoice. Full clearing/inventory audit becomes available afterwards.",
    });
  }
  return {
    orderId,companyId,finalized,
    passed:checks.every(c=>c.state!=="BLOCK"),
    expectedInvoiceTotal:finalized?str(details.finalInvoiceTotal):null,
    originalTruckReceivable:receivable,checks,
    verifiedAt:new Date().toISOString(),
  };
}
