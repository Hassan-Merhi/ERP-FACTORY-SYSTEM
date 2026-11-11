/**
 * Phase 7 — approved, all-truck reconciliation and atomic unshipped correction.
 * No vouchers, customer balances or final invoice are written here.
 * The signed DRAFT consolidation record is an immutable Phase 8 prerequisite.
 */
import type { Express, Request, Response } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getFactoryAccessState, requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { recalculateOrderTotals } from "../_helpers";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { reversePriorityAllocationForDeletedBaleTx } from "./priorityAutoAllocation";
import { PRIORITY_SCAN_LOCK_NAMESPACE, reactivateAutoCompletedPriorityLoadingsLockedTx } from "./priorityScanQueue";
import {
  customerOrderBales, customerOrderBaleRemovals, factoryBales,
} from "@shared/schema";
import { isPostedDispatchBaleTx } from "../../../services/factory/dispatchTripFinancialGuards";
import { assertFactoryDispatchReleaseReadyTx, DispatchReleaseNotReadyError } from "../../../services/factory/dispatchReleaseReadiness";
import {
  OrderReconciliationError,
} from "./loadingDispatchOrderReconciliationModel";
import {
  loadOrderDispatchReconciliationTx, readOrderDispatchApprovalTx,
  type OrderReconciliationScope,
} from "./loadingDispatchOrderReconciliationData";

const path="/api/factory/customer-orders/:id/loading-dispatches/order-reconciliation";
const access=requireFactoryTabAccess("factory/invoicing","hide_invoicing_loadings_tab");
const read = (v: unknown) => resultRows(v);
const refusal=(code:string,message:string,status=409):never=>{throw new OrderReconciliationError(code,message,status);};
function reason(body:unknown,min=10):string{
  const raw=(body as Record<string,unknown>|null)?.reason;
  if(typeof raw!=="string" || raw.trim().length<min || raw.trim().length>1000){
    return refusal("RECONCILIATION_REASON_REQUIRED","Enter an approval reason of 10–1,000 characters",400);
  }
  return raw.trim();
}
function expected(body:unknown):string{
  const value=(body as Record<string,unknown>|null)?.expectedFingerprint;
  if(typeof value!=="string" || !/^[0-9a-f]{64}$/.test(value)){
    return refusal("RECONCILIATION_PREVIEW_REQUIRED","Refresh the all-trucks reconciliation and confirm its exact fingerprint",400);
  }
  return value;
}
async function scope(req:Request):Promise<OrderReconciliationScope & {role:string}>{
  const state=await getFactoryAccessState(req);
  if(!state?.hasFactoryAccess) return refusal("FACTORY_ACCESS_REQUIRED","Factory access required",403);
  const orderId=parseId(req.params.id);
  if(orderId===null) return refusal("INVALID_ORDER_ID","Invalid Pending Loading",400);
  return {companyId:state.companyId,orderId,userId:String(state.userId),
    username:String(req.session.username||state.userId),role:state.role.toLowerCase()};
}
function supervisor(role:string):void{
  if(!["admin","owner","developer"].includes(role)){
    refusal("SUPERVISOR_REQUIRED","Only Admin, Owner and Developer can approve the final truck reconciliation",403);
  }
}
async function locks(tx:Parameters<Parameters<typeof db.transaction>[0]>[0],s:OrderReconciliationScope) {
  // Priority lock precedes order lock to match the existing loading correction
  // and prevent a priority auto-allocation from attaching new bales mid-review.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE},${s.companyId})`);
  const [order]=read(await tx.execute(sql`
    SELECT id,proforma_id_used AS "proformaIdUsed" FROM customer_orders
     WHERE company_id=${s.companyId} AND id=${s.orderId}
  `));
  if(!order) refusal("ORDER_NOT_FOUND","Pending Loading not found",404);
  if(order.proformaIdUsed){
    await acquireProformaCapacityTransactionLock(tx,{
      companyId:s.companyId,proformaId:Number(order.proformaIdUsed),
    });
  }
  const [locked]=read(await tx.execute(sql`
    SELECT id,status,deleted_at AS "deletedAt",invoice_number AS "invoiceNumber"
      FROM customer_orders
     WHERE company_id=${s.companyId} AND id=${s.orderId} FOR UPDATE
  `));
  if(!locked || locked.deletedAt || locked.invoiceNumber ||
     !["LOADING","PENDING_VERIFICATION"].includes(String(locked.status))){
    refusal("RECONCILIATION_ORDER_NOT_OPEN","Only unfinalized active Pending Loading orders can reconcile missing bales");
  }
  // All physical dispatches are locked in an unambiguous order. No closed trip
  // can reopen, scan or change closure between approval and transaction commit.
  await tx.execute(sql`
    SELECT id FROM factory_loading_dispatches
     WHERE company_id=${s.companyId} AND order_id=${s.orderId}
     ORDER BY id FOR UPDATE
  `);
}
async function writeEvent(
  tx:Parameters<Parameters<typeof db.transaction>[0]>[0],s:OrderReconciliationScope,
  eventType:string,reasonValue:string,details:Record<string,unknown>
){
  await tx.execute(sql`
    INSERT INTO factory_dispatch_financial_events
      (company_id,order_id,dispatch_id,financial_id,event_type,details,
       reason,actor_user_id,actor_username)
    VALUES (${s.companyId},${s.orderId},NULL,NULL,${eventType},
      ${JSON.stringify(details)}::jsonb,${reasonValue},${s.userId},${s.username})
  `);
}
function handle(res:Response,error:unknown) {
  if(error instanceof DispatchReleaseNotReadyError){
    return res.status(error.status).json({code:error.code,message:error.message,missing:error.report.missing});
  }
  if(error instanceof OrderReconciliationError){
    return res.status(error.status).json({code:error.code,message:error.message});
  }
  if(["42P01","42703"].includes(String((error as {code?:string}|null)?.code))){
    return res.status(503).json({
      code:"RECONCILIATION_SQL_PENDING",
      message:"Phase 7 financial reconciliation needs the saved TablePlus schema and approval fields. No SQL has been run.",
    });
  }
  logger.error("Factory all-truck reconciliation failed",{error});
  return res.status(500).json({code:"RECONCILIATION_ERROR",message:"Unable to process this all-truck reconciliation"});
}
export function registerFactoryDispatchOrderReconciliationRoutes(app:Express):void{
  app.get(path,requireAuth,access,async(req,res)=>{
    try{
      const s=await scope(req);
      const snapshot=await db.transaction(async tx=>{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const current=await loadOrderDispatchReconciliationTx(tx,s);
        const [invoice]=read(await tx.execute(sql`
          SELECT c.status,c.invoice_number AS "invoiceNumber",
                 c.finalization_details AS "finalization",
                 o.invoice_number AS "orderInvoice"
            FROM factory_dispatch_order_consolidations c
            JOIN customer_orders o ON o.id=c.order_id AND o.company_id=c.company_id
           WHERE c.company_id=${s.companyId} AND c.order_id=${s.orderId} LIMIT 1
        `));
        const details=invoice?.finalization;
        const finalized=Boolean(current.stored &&
          current.orderStatus==="FINALIZED" && invoice?.status==="FINALIZED" &&
          invoice?.invoiceNumber===invoice?.orderInvoice &&
          details && typeof details==="object" &&
          (details as Record<string,unknown>).customerReceivableReposted===false);
        return {...current,finalized};
      });
      res.set("Cache-Control","private, no-store");
      return res.json({
        orderId:s.orderId,loadingStatus:snapshot.orderStatus,
        ...snapshot.result,
        // The physical source's status becomes FINALIZED and each trip moves
        // POSTED -> CONSOLIDATED in Phase 8, intentionally changing the live
        // Phase 7 preview fingerprint. Its original signed fingerprint and
        // immutable finalization are the authority after finalizing.
        ...(snapshot.finalized?{blockingReasons:[],fingerprint:snapshot.stored!.fingerprint}:{ }),
        approval:snapshot.stored,
        approvalCurrent:Boolean(snapshot.stored &&
          (snapshot.finalized || snapshot.stored.fingerprint===snapshot.result.fingerprint)),
        canApprove:["admin","owner","developer"].includes(s.role) &&
          snapshot.result.ready && !snapshot.stored,
      });
    }catch(error){return handle(res,error);}
  });

  app.post(path+"/remove-unshipped",requireAuth,access,async(req,res)=>{
    try{
      const s=await scope(req);supervisor(s.role);
      const fp=expected(req.body);
      const why=reason(req.body);
      if(req.body?.confirm!==true || !Array.isArray(req.body?.orderBaleIds) ||
         req.body.orderBaleIds.length===0 || req.body.orderBaleIds.length>2000){
        refusal("RECONCILIATION_SELECTION_INVALID","Confirm one to 2,000 selected unshipped bales",400);
      }
      const ids=(req.body.orderBaleIds as unknown[]).map(Number);
      if(ids.some(n=>!Number.isSafeInteger(n)||n<1) || new Set(ids).size!==ids.length){
        refusal("RECONCILIATION_SELECTION_INVALID","Duplicate or invalid bale links were selected",400);
      }
      const output=await db.transaction(async tx=>{
        await assertFactoryDispatchReleaseReadyTx(tx,"RECONCILIATION");
        await locks(tx,s);
        if(await readOrderDispatchApprovalTx(tx,s)){
          refusal("RECONCILIATION_ALREADY_SIGNED","This order was already signed. A new reconciliation requires an authorized reversal.");
        }
        const before=(await loadOrderDispatchReconciliationTx(tx,s)).result;
        if(before.fingerprint!==fp) refusal("RECONCILIATION_CHANGED","Trucks, scans, prices or loading changed; refresh the comparison before removing bales");
        if(!before.trips.length || before.summary.openTrips>0 || before.unexpectedScans.length || before.duplicateScans.length){
          refusal("RECONCILIATION_TRIPS_UNRESOLVED","Finish and resolve all physical dispatches before adjusting unshipped Pending Loading");
        }
        const missing=new Map(before.missingBales.map(b=>[b.orderBaleId,b]));
        for(const id of ids){
          if(!missing.has(id)){
            refusal("RECONCILIATION_BALE_NOT_MISSING","One selected bale was scanned or is no longer an unshipped loading bale");
          }
          const b=missing.get(id)!;
          if(await isPostedDispatchBaleTx(tx,s.companyId,s.orderId,b.baleId)){
            refusal("RECONCILIATION_BALE_ALREADY_POSTED","A financially posted trip bale cannot be returned to stock");
          }
        }
        const links=await tx.select().from(customerOrderBales)
          .where(and(eq(customerOrderBales.orderId,s.orderId),inArray(customerOrderBales.id,ids)))
          .for("update");
        if(links.length!==ids.length) refusal("RECONCILIATION_CHANGED","Loading changed before approval; refresh");
        const physicalIds=links.map(l=>l.baleId);
        const active=read(await tx.execute(sql`
          SELECT bale_id FROM factory_loading_dispatch_scans
           WHERE company_id=${s.companyId} AND order_id=${s.orderId}
             AND bale_id IN (${sql.join(physicalIds.map(n=>sql`${n}`),sql`,`)})
             AND removed_at IS NULL LIMIT 1
        `));
        if(active.length) refusal("RECONCILIATION_BALE_ALREADY_SCANNED","A selected bale has a live physical scan and cannot be returned to stock");
        const bales=await tx.select().from(factoryBales)
          .where(and(eq(factoryBales.companyId,s.companyId),inArray(factoryBales.id,physicalIds)))
          .for("update");
        if(bales.length!==physicalIds.length) refusal("RECONCILIATION_BALE_STOCK_MISSING","One selected physical bale is missing or no longer in this Factory company");
        // Legacy loadings reserve their linked bales as RESERVED_FOR_ORDER,
        // but V5 deliberately leaves linked bales as IN_STOCK. Both are valid
        // for a currently linked, physically UNLOADED bale. Never revive a
        // SOLD/DELETED/other state or free a bale shared by an active loading.
        if(bales.some(b=>!["RESERVED_FOR_ORDER","IN_STOCK"].includes(b.status))){
          refusal("RECONCILIATION_STOCK_OWNERSHIP_CHANGED",
            "An unshipped bale has an unexpected stock status; inspect its original loading and inventory");
        }
        const [otherOwner]=read(await tx.execute(sql`
          SELECT 1 FROM customer_order_bales cob
          JOIN customer_orders co ON co.id=cob.order_id AND co.company_id=${s.companyId}
          WHERE cob.bale_id IN (${sql.join(physicalIds.map(n=>sql`${n}`),sql`,`)})
            AND cob.order_id<>${s.orderId}
            AND co.deleted_at IS NULL AND co.status NOT IN ('CANCELLED')
          LIMIT 1
        `));
        if(otherOwner){
          refusal("RECONCILIATION_BALE_SHARED_WITH_OTHER_LOADING",
            "The selected bale also belongs to another active loading; release requires inventory reconciliation");
        }
        const removed=await tx.delete(customerOrderBales)
          .where(and(eq(customerOrderBales.orderId,s.orderId),inArray(customerOrderBales.id,ids)))
          .returning({id:customerOrderBales.id,baleId:customerOrderBales.baleId});
        if(removed.length!==ids.length) refusal("RECONCILIATION_CHANGED","One selected bale was removed concurrently");
        const updated=await tx.update(factoryBales)
          .set({status:"IN_STOCK",updatedAt:new Date()})
          .where(and(eq(factoryBales.companyId,s.companyId),inArray(factoryBales.id,physicalIds)))
          .returning({id:factoryBales.id});
        if(updated.length!==physicalIds.length) refusal("RECONCILIATION_STOCK_UPDATE_FAILED","Could not restore every unshipped bale to stock");
        await tx.insert(customerOrderBaleRemovals).values(bales.map(b=>({
          orderId:s.orderId,baleId:b.id,referenceNumber:b.referenceNumber,
          articleCode:b.articleCode||null,productName:b.productName||null,
          weightKg:b.weightKg,removedByUserId:s.userId,removedByUsername:s.username,
        })));
        await recalculateOrderTotals(tx,s.orderId);
        // For active LOADING/PENDING_VERIFICATION there is no finalized invoice
        // or ORDER_VERIFIED daybook to rewrite. Do not call syncOrderTotalsTx,
        // which would invoke legacy full-invoice posting on a posted dispatch.
        for(const row of removed){
          await reversePriorityAllocationForDeletedBaleTx(tx,{
            companyId:s.companyId,baleId:row.baleId,detachedOrderId:s.orderId,
            actor:s.username,actorId:s.userId,
            reason:"Phase 7 approved unshipped dispatch reconciliation",
            deferQueueRecovery:true,
          });
        }
        await reactivateAutoCompletedPriorityLoadingsLockedTx(tx,s.companyId,[s.orderId]);
        const after=(await loadOrderDispatchReconciliationTx(tx,s)).result;
        await writeEvent(tx,s,"ORDER_UNSHIPPED_BALES_REMOVED",why,{
          orderBaleIds:ids,baleIds:physicalIds,references:bales.map(b=>b.referenceNumber),
          originalFingerprint:fp,newFingerprint:after.fingerprint,
          removedCount:removed.length,remainingUnshipped:after.summary.unshippedBales,
        });
        return {removed:removed.length,remainingUnshipped:after.summary.unshippedBales,
          fingerprint:after.fingerprint,ready:after.ready};
      });
      res.set("Cache-Control","private, no-store");
      return res.json(output);
    }catch(error){return handle(res,error);}
  });

  app.post(path+"/approve",requireAuth,access,async(req,res)=>{
    try{
      const s=await scope(req);supervisor(s.role);
      const fp=expected(req.body);const why=reason(req.body);
      if(req.body?.confirm!==true){
        refusal("RECONCILIATION_CONFIRM_REQUIRED","Confirm all signed trip totals and scanned barcodes before approval",400);
      }
      const result=await db.transaction(async tx=>{
        await assertFactoryDispatchReleaseReadyTx(tx,"RECONCILIATION");
        await locks(tx,s);
        const existing=await readOrderDispatchApprovalTx(tx,s,true);
        const evaluated=(await loadOrderDispatchReconciliationTx(tx,s)).result;
        if(fp!==evaluated.fingerprint){
          refusal("RECONCILIATION_CHANGED","The scanned or financial source changed; refresh before approval");
        }
        if(existing){
          if(existing.fingerprint!==fp) refusal("RECONCILIATION_ALREADY_SIGNED","Previously signed reconciliation no longer matches; escalate for accounting review");
          return {approved:true,replayed:true,approval:existing};
        }
        if(!evaluated.ready){
          refusal("RECONCILIATION_UNRESOLVED",evaluated.blockingReasons.join("; "));
        }
        const [existingConsolidation]=read(await tx.execute(sql`
          SELECT id,status,reconciled_at AS "reconciledAt"
            FROM factory_dispatch_order_consolidations
           WHERE company_id=${s.companyId} AND order_id=${s.orderId} FOR UPDATE
        `));
        if(existingConsolidation && (existingConsolidation.status!=="DRAFT" || existingConsolidation.reconciledAt)){
          refusal("RECONCILIATION_ALREADY_CONSOLIDATED","This order already has a finalized or signed consolidation");
        }
        const snap={
          version:1,summary:evaluated.summary,
          trips:evaluated.trips.map(t=>({
            dispatchId:t.dispatchId,dispatchNumber:t.dispatchNumber,
            financialId:t.financialId,postingId:t.postingId,revision:t.revision,
            goodsSubtotal:t.goodsSubtotal,billableChargesTotal:t.billableChargesTotal,
            discountTotal:t.discountTotal,customerTotal:t.customerTotal,
            postedBales:t.postedBales,
          })),
          approvedAt:new Date().toISOString(),reason:why,
          orderChargesExcludedFromPostedTrips:evaluated.summary.existingOrderChargeTotal,
          notes:evaluated.warnings,
        };
        const signedRows=read(await tx.execute(sql`
          INSERT INTO factory_dispatch_order_consolidations
            (company_id,order_id,status,reconciliation_fingerprint,
             reconciliation_snapshot,reconciled_at,reconciled_by_user_id,
             reconciliation_reason,included_posting_ids,goods_subtotal,
             billable_charges_total,discount_total,customer_total)
          VALUES (${s.companyId},${s.orderId},'DRAFT',${fp},
                  ${JSON.stringify(snap)}::jsonb,NOW(),${s.userId},
                  ${why},${JSON.stringify(evaluated.includedPostingIds)}::jsonb,
                  ${evaluated.summary.goodsSubtotal},${evaluated.summary.billableChargesTotal},
                  ${evaluated.summary.discountTotal},${evaluated.summary.customerTotal})
          ON CONFLICT (company_id,order_id) DO UPDATE
           SET reconciliation_fingerprint=EXCLUDED.reconciliation_fingerprint,
               reconciliation_snapshot=EXCLUDED.reconciliation_snapshot,
               reconciled_at=EXCLUDED.reconciled_at,
               reconciled_by_user_id=EXCLUDED.reconciled_by_user_id,
               reconciliation_reason=EXCLUDED.reconciliation_reason,
               included_posting_ids=EXCLUDED.included_posting_ids,
               goods_subtotal=EXCLUDED.goods_subtotal,
               billable_charges_total=EXCLUDED.billable_charges_total,
               discount_total=EXCLUDED.discount_total,customer_total=EXCLUDED.customer_total,
               updated_at=NOW()
           WHERE factory_dispatch_order_consolidations.status='DRAFT'
             AND factory_dispatch_order_consolidations.reconciled_at IS NULL
          RETURNING id
        `));
        if(signedRows.length!==1){
          refusal("RECONCILIATION_SIGNOFF_CONFLICT",
            "This loading has already been signed or its consolidation changed; no approval was committed");
        }
        await writeEvent(tx,s,"ORDER_DISPATCH_RECONCILIATION_APPROVED",why,{
          fingerprint:fp,summary:evaluated.summary,
          includedPostingIds:evaluated.includedPostingIds,
          tripIds:evaluated.trips.map(t=>t.dispatchId),
        });
        return {approved:true,replayed:false,approval:await readOrderDispatchApprovalTx(tx,s)};
      });
      res.set("Cache-Control","private, no-store");
      return res.json(result);
    }catch(error){return handle(res,error);}
  });
}
