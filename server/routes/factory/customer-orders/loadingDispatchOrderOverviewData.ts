/**
 * Phase 9 — one read-only, company-scoped Factory dispatch order dashboard.
 * Physical scans, frozen POST amounts, order-level charges, export evidence,
 * and signed invoice are displayed as separate evidence (never double-counted).
 *
 * No migrations or startup DDL. Before the user's manual financial SQL, return
 * useful physical status plus a visible SCHEMA_PENDING warning, not fake $0.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { MoneyDecimal, sumMoney } from "../../../lib/money";

const rows=async (tx:DbTransaction,stmt:ReturnType<typeof sql>)=>
  resultRows(await tx.execute(stmt));
const txt=(v:unknown)=>v===null||v===undefined?null:String(v);
const str=(v:unknown)=>String(v??"");
const integer=(v:unknown)=>Number(v??0);
const amt=(v:unknown)=>new MoneyDecimal(str(v??"0"));
const amount=(v:unknown)=>amt(v).toDecimalPlaces(2).toFixed(2);
const stamp=(v:unknown)=>v===null||v===undefined?null:new Date(String(v)).toISOString();
const moneySum=(items:unknown[])=>sumMoney(items.map(amt)).toDecimalPlaces(2).toFixed(2);

export interface FactoryDispatchOrderOverview {
  generatedAt:string;
  schemaReady:boolean;
  companyId:number;
  order:{
    id:number;status:string;containerNumber:string|null;customerName:string|null;
    invoiceNumber:string|null;grandTotal:string;deleted:boolean;
  };
  summary:{
    tripCount:number;closedTrips:number;openTrips:number;
    originalLoadingBales:number;scannedBales:number;uniqueScannedBales:number;
    unshippedBales:number;unexpectedScannedBales:number;
    goodsSubtotal:string|null;billableCharges:string|null;
    discounts:string|null;tripCustomerTotal:string|null;
    originalOrderCharges:string|null;invoiceTotal:string|null;
    internalExpenses:string|null;generatedPoFiles:number;
    signed:boolean;finalized:boolean;invoiceConsistent:boolean;
  };
  invoice:{
    status:string;invoiceNumber:string|null;signedAt:string|null;
    signedBy:string|null;finalizedAt:string|null;
    includedPostingIds:string[];finalizationVoucherIds:string[];
  }|null;
  trips:Array<{
    id:string;dispatchNumber:number;status:string;notes:string|null;
    closedAt:string|null;scannedBales:number;scannedWeightKg:string;
    financialStatus:string;postingRevision:number;postingId:string|null;
    goodsSubtotal:string|null;billableCharges:string|null;discounts:string|null;
    customerTotal:string|null;postedAt:string|null;
    exportedAt:string|null;poNumber:string|null;
    erpContainerNumber:string|null;supplierCode:string|null;
    erpImportStatus:"NOT_TRACKED_MANUAL"|"NOT_EXPORTED";
  }>;
  charges:Array<{
    id:string;dispatchId:string|null;dispatchNumber:number|null;
    name:string;kind:"BILLABLE"|"DISCOUNT"|"INTERNAL"|"ORDER";
    amount:string;accountCode:string|null;accountName:string|null;
    offsetAccountCode:string|null;postedVoucherId:string|null;
    status:"POSTED"|"DRAFT"|"UNLINKED";
  }>;
  notices:string[];
}

export async function loadFactoryDispatchOrderOverviewTx(
  tx:DbTransaction,companyId:number,orderId:number
):Promise<FactoryDispatchOrderOverview|null>{
  const [order]=await rows(tx,sql`
    SELECT co.id,co.status,co.container_number AS "containerNumber",
       co.invoice_number AS "invoiceNumber",co.grand_total::text AS "grandTotal",
       co.deleted_at AS "deletedAt",c.legal_name AS "customerName"
      FROM customer_orders co
      LEFT JOIN customers c ON c.id=co.customer_id AND c.company_id=co.company_id
     WHERE co.company_id=${companyId} AND co.id=${orderId} LIMIT 1
  `);
  if(!order)return null;

  const [schema]=await rows(tx,sql`
    SELECT to_regclass('public.factory_dispatch_trip_financials') IS NOT NULL AS "financial",
           to_regclass('public.factory_dispatch_order_consolidations') IS NOT NULL AS "consolidations",
           to_regclass('public.factory_dispatch_trip_exports') IS NOT NULL AS "exports",
           to_regclass('public.factory_dispatch_trip_charges') IS NOT NULL AS "charges"
  `);
  const schemaReady=schema?.financial===true && schema?.consolidations===true &&
    schema?.exports===true && schema?.charges===true;

  const physical=await rows(tx,sql`
    SELECT d.id::text AS id,d.dispatch_number AS "dispatchNumber",
      d.status,d.notes,d.closed_at AS "closedAt",
      COALESCE(sc."scannedBales",0)::integer AS "scannedBales",
      COALESCE(sc."scannedWeightKg",0)::text AS "scannedWeightKg"
     FROM factory_loading_dispatches d
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::integer AS "scannedBales",
              COALESCE(SUM(s.weight_kg),0) AS "scannedWeightKg"
         FROM factory_loading_dispatch_scans s
        WHERE s.company_id=d.company_id AND s.order_id=d.order_id
          AND s.dispatch_id=d.id AND s.removed_at IS NULL
     ) sc ON TRUE
    WHERE d.company_id=${companyId} AND d.order_id=${orderId}
      AND d.status <> 'CANCELLED'
    ORDER BY d.dispatch_number ASC,d.id ASC
  `);
  const [scanStats]=await rows(tx,sql`
    SELECT
     (SELECT COUNT(*)::integer FROM customer_order_bales cob WHERE cob.order_id=${orderId}) AS "loadingBales",
     (SELECT COUNT(DISTINCT s.bale_id)::integer
        FROM factory_loading_dispatch_scans s WHERE s.company_id=${companyId}
        AND s.order_id=${orderId} AND s.removed_at IS NULL) AS "uniqueScannedBales",
     (SELECT COUNT(*)::integer FROM customer_order_bales cob
       WHERE cob.order_id=${orderId} AND NOT EXISTS (
         SELECT 1 FROM factory_loading_dispatch_scans s
          WHERE s.company_id=${companyId} AND s.order_id=${orderId}
            AND s.bale_id=cob.bale_id AND s.removed_at IS NULL)) AS "unshippedBales",
     (SELECT COUNT(*)::integer FROM factory_loading_dispatch_scans s
       WHERE s.company_id=${companyId} AND s.order_id=${orderId}
         AND s.removed_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM customer_order_bales cob
          WHERE cob.order_id=${orderId} AND cob.bale_id=s.bale_id)) AS "unexpectedScannedBales"
  `);
  const summary={
    tripCount:physical.length,
    closedTrips:physical.filter(t=>t.status==="CLOSED").length,
    openTrips:physical.filter(t=>t.status!=="CLOSED").length,
    originalLoadingBales:integer(scanStats?.loadingBales),
    scannedBales:physical.reduce((n,t)=>n+integer(t.scannedBales),0),
    uniqueScannedBales:integer(scanStats?.uniqueScannedBales),
    unshippedBales:integer(scanStats?.unshippedBales),
    unexpectedScannedBales:integer(scanStats?.unexpectedScannedBales),
    goodsSubtotal:null as string|null,
    billableCharges:null as string|null,
    discounts:null as string|null,
    tripCustomerTotal:null as string|null,
    originalOrderCharges:null as string|null,
    invoiceTotal:null as string|null,
    internalExpenses:null as string|null,
    generatedPoFiles:0,signed:false,finalized:false,invoiceConsistent:false,
  };
  const notices:string[]=[];
  const trips:FactoryDispatchOrderOverview["trips"]=physical.map(t=>({
    id:str(t.id),dispatchNumber:integer(t.dispatchNumber),status:str(t.status),
    notes:txt(t.notes),closedAt:stamp(t.closedAt),
    scannedBales:integer(t.scannedBales),scannedWeightKg:str(t.scannedWeightKg),
    financialStatus:"NOT_INSTALLED",postingRevision:0,postingId:null,
    goodsSubtotal:null,billableCharges:null,discounts:null,customerTotal:null,
    postedAt:null,exportedAt:null,poNumber:null,erpContainerNumber:null,supplierCode:null,
    erpImportStatus:"NOT_EXPORTED",
  }));
  let invoice:FactoryDispatchOrderOverview["invoice"]=null;
  const charges:FactoryDispatchOrderOverview["charges"]=[];
  if(!schemaReady){
    notices.push("Financial dashboard needs the final manually applied TablePlus SQL. Physical trip progress is shown; financial amounts are intentionally unavailable.");
    return {
      generatedAt:new Date().toISOString(),schemaReady,companyId,
      order:{id:orderId,status:str(order.status),containerNumber:txt(order.containerNumber),
        customerName:txt(order.customerName),invoiceNumber:txt(order.invoiceNumber),
        grandTotal:amount(order.grandTotal),deleted:Boolean(order.deletedAt)},
      summary,invoice,trips,charges,notices,
    };
  }
  // Phase 7/8 columns may be absent on an older partial migration. Check
  // separately to avoid breaking a physical-only dashboard.
  const [columns]=await rows(tx,sql`
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='factory_dispatch_order_consolidations'
         AND column_name='finalization_details'
    ) AS "invoiceReady",
    EXISTS(
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='factory_dispatch_order_consolidations'
         AND column_name='reconciled_at'
    ) AS "approvalReady"
  `);
  const consolidated=columns?.invoiceReady===true && columns?.approvalReady===true
    ? (await rows(tx,sql`
      SELECT status,invoice_number AS "invoiceNumber",
        reconciled_at AS "signedAt",reconciled_by_user_id AS "signedBy",
        finalized_at AS "finalizedAt",included_posting_ids AS "postingIds",
        finalization_details AS "details"
      FROM factory_dispatch_order_consolidations
      WHERE company_id=${companyId} AND order_id=${orderId} LIMIT 1
    `))[0]
    : null;
  if(columns?.approvalReady!==true || columns?.invoiceReady!==true){
    notices.push("The Phase 7/8 TablePlus sign-off columns are not installed yet. Approval and final invoice details are unavailable.");
  }
  if(consolidated){
    const details=consolidated.details && typeof consolidated.details==="object" &&
      !Array.isArray(consolidated.details)
      ? consolidated.details as Record<string,unknown> : {};
    const finalized=consolidated.status==="FINALIZED";
    summary.signed=Boolean(consolidated.signedAt);
    summary.finalized=finalized;
    summary.invoiceConsistent=finalized && order.status==="FINALIZED" &&
      str(consolidated.invoiceNumber)===str(order.invoiceNumber);
    invoice={
      status:str(consolidated.status),invoiceNumber:txt(consolidated.invoiceNumber),
      signedAt:stamp(consolidated.signedAt),signedBy:txt(consolidated.signedBy),
      finalizedAt:stamp(consolidated.finalizedAt),
      includedPostingIds:Array.isArray(consolidated.postingIds)?consolidated.postingIds.map(String):[],
      finalizationVoucherIds:Array.isArray(details.voucherIds)?details.voucherIds.map(String):[],
    };
    if(finalized && !summary.invoiceConsistent){
      notices.push("The signed combined invoice does not match the original order's invoice identity. Accounting review is required.");
    }
  }
  for(const trip of trips)trip.financialStatus="UNPOSTED";
  const financial=await rows(tx,sql`
    SELECT f.dispatch_id::text AS "dispatchId",f.status AS "financialStatus",
      f.posting_revision AS revision,
      f.goods_subtotal::text AS goods,
      f.billable_charges_total::text AS billable,
      f.discount_total::text AS discounts,f.customer_total::text AS total,
      f.posted_at AS "postedAt",p.id::text AS "postingId",
      e.exported_at AS "exportedAt",e.po_number AS "poNumber",
      e.erp_container_number AS "erpContainerNumber",e.supplier_code AS "supplierCode"
    FROM factory_dispatch_trip_financials f
    LEFT JOIN factory_dispatch_trip_postings p ON p.company_id=f.company_id
      AND p.order_id=f.order_id AND p.dispatch_id=f.dispatch_id
      AND p.financial_id=f.id AND p.posting_revision=f.posting_revision AND p.kind='POST'
    LEFT JOIN factory_dispatch_trip_exports e ON e.company_id=f.company_id
      AND e.order_id=f.order_id AND e.dispatch_id=f.dispatch_id AND e.financial_id=f.id
    WHERE f.company_id=${companyId} AND f.order_id=${orderId}
    ORDER BY f.dispatch_id ASC
  `);
  const postedRows:Record<string,unknown>[]=[];
  for(const row of financial){
    const trip=trips.find(t=>t.id===str(row.dispatchId));
    if(!trip){
      notices.push("A financial trip exists without a matching physical dispatch record.");
      continue;
    }
    trip.financialStatus=str(row.financialStatus);
    trip.postingRevision=integer(row.revision);
    trip.postingId=txt(row.postingId);
    trip.postedAt=stamp(row.postedAt);
    trip.exportedAt=stamp(row.exportedAt);
    trip.poNumber=txt(row.poNumber);trip.erpContainerNumber=txt(row.erpContainerNumber);
    trip.supplierCode=txt(row.supplierCode);
    trip.erpImportStatus=row.exportedAt?"NOT_TRACKED_MANUAL":"NOT_EXPORTED";
    if(["POSTED","CONSOLIDATED"].includes(trip.financialStatus)){
      postedRows.push(row);
      trip.goodsSubtotal=amount(row.goods);
      trip.billableCharges=amount(row.billable);
      trip.discounts=amount(row.discounts);
      trip.customerTotal=amount(row.total);
      if(!trip.postingId)notices.push("A financial trip has no signed POST record.");
    }
  }
  summary.generatedPoFiles=trips.filter(t=>t.exportedAt!==null).length;
  summary.goodsSubtotal=moneySum(postedRows.map(r=>r.goods));
  summary.billableCharges=moneySum(postedRows.map(r=>r.billable));
  summary.discounts=moneySum(postedRows.map(r=>r.discounts));
  summary.tripCustomerTotal=moneySum(postedRows.map(r=>r.total));
  const tripCharges=await rows(tx,sql`
    SELECT c.id::text AS id,c.dispatch_id::text AS "dispatchId",
      d.dispatch_number AS "dispatchNumber",c.name,c.kind,c.amount::text AS amount,
      la.code AS "accountCode",la.name AS "accountName",
      offset_account.code AS "offsetAccountCode",
      c.posted_voucher_id::text AS "postedVoucherId",
      CASE WHEN c.locked_at IS NOT NULL THEN 'POSTED' ELSE 'DRAFT' END AS "chargeStatus"
     FROM factory_dispatch_trip_charges c
     JOIN factory_dispatch_trip_financials f ON f.id=c.financial_id
       AND f.company_id=c.company_id AND f.order_id=c.order_id
       AND f.dispatch_id=c.dispatch_id
     JOIN factory_loading_dispatches d ON d.id=c.dispatch_id
       AND d.company_id=c.company_id AND d.order_id=c.order_id
     LEFT JOIN ledger_accounts la ON la.id=c.ledger_account_id AND la.company_id=c.company_id
     LEFT JOIN ledger_accounts offset_account ON offset_account.id=c.offset_ledger_account_id
       AND offset_account.company_id=c.company_id
    WHERE c.company_id=${companyId} AND c.order_id=${orderId}
      AND c.revision=CASE WHEN f.posting_revision>0 THEN f.posting_revision
                          WHEN f.snapshot_revision>0 THEN f.snapshot_revision ELSE 1 END
    ORDER BY d.dispatch_number,c.id
  `);
  for(const c of tripCharges){
    charges.push({
      id:str(c.id),dispatchId:str(c.dispatchId),dispatchNumber:integer(c.dispatchNumber),
      name:str(c.name),kind:str(c.kind) as "BILLABLE"|"DISCOUNT"|"INTERNAL",
      amount:amount(c.amount),accountCode:txt(c.accountCode),accountName:txt(c.accountName),
      offsetAccountCode:txt(c.offsetAccountCode),postedVoucherId:txt(c.postedVoucherId),
      status:c.chargeStatus==="POSTED"?"POSTED":"DRAFT",
    });
  }
  const original=await rows(tx,sql`
    SELECT c.id::text AS id,c.name,c.amount::text AS amount,
      la.code AS "accountCode",la.name AS "accountName",
      c.voucher_id::text AS "postedVoucherId"
    FROM customer_order_charges c
    JOIN customer_orders o ON o.id=c.order_id AND o.company_id=${companyId}
    LEFT JOIN ledger_accounts la ON la.id=c.ledger_account_id AND la.company_id=o.company_id
    WHERE c.order_id=${orderId} ORDER BY c.id
  `);
  for(const c of original){
    charges.push({
      id:"order-"+str(c.id),dispatchId:null,dispatchNumber:null,
      name:str(c.name),kind:"ORDER",amount:amount(c.amount),
      accountCode:txt(c.accountCode),accountName:txt(c.accountName),
      offsetAccountCode:null,postedVoucherId:txt(c.postedVoucherId),
      status:c.postedVoucherId?"POSTED":"UNLINKED",
    });
  }
  summary.originalOrderCharges=moneySum(original.map(r=>r.amount));
  summary.internalExpenses=moneySum(charges.filter(c=>c.kind==="INTERNAL" &&
    c.status==="POSTED").map(c=>c.amount));
  const signedFinal=consolidated?.details && typeof consolidated.details==="object" &&
    !Array.isArray(consolidated.details)
    ? (consolidated.details as Record<string,unknown>).finalInvoiceTotal : null;
  summary.invoiceTotal=summary.finalized && signedFinal!==null && signedFinal!==undefined
    ? amount(signedFinal) : null;
  if(summary.finalized && summary.invoiceTotal===null){
    notices.push("Finalized invoice is missing its signed total snapshot. Accounting review is required.");
  }
  if(summary.finalized && summary.invoiceTotal!==null){
    const calculated=amt(summary.tripCustomerTotal).plus(summary.originalOrderCharges);
    if(!calculated.eq(amt(summary.invoiceTotal))){
      notices.push("Stored final invoice total does not match currently reported posted trip totals and original charges.");
    }
  }
  if(trips.some(t=>t.exportedAt))notices.push(
    "ERP PO files were generated in Factory. This does NOT confirm manual import, purchase receipt or supplier balance in Normal ERP."
  );
  if(summary.signed && !summary.finalized){
    notices.push("The order is financially reconciled and signed, but the one combined customer invoice has not yet been finalized.");
  }
  if(summary.finalized)notices.push("The customer receivable was already posted on individual trucks. The final invoice must not debit that receivable twice.");
  return {
    generatedAt:new Date().toISOString(),schemaReady,companyId,
    order:{id:orderId,status:str(order.status),containerNumber:txt(order.containerNumber),
      customerName:txt(order.customerName),invoiceNumber:txt(order.invoiceNumber),
      grandTotal:amount(order.grandTotal),deleted:Boolean(order.deletedAt)},
    summary,invoice,trips,charges,notices,
  };
}
