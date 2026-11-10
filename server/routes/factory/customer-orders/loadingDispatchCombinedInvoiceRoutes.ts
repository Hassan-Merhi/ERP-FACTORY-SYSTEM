/** Phase 8 routes — ONE manually approved consolidated Factory customer invoice. */
import type { Express,Request,Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getClientDate } from "../../../lib/dateUtils";
import { getFactoryAccessState,requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { closedPeriodErrorResponse } from "../../../lib/closedPeriodError";
import { freezeCanonicalInvoiceDocument } from "../../../services/factoryInvoiceDocumentService";
import { dispatchNotification } from "../../../lib/notificationService";
import { OrderReconciliationError } from "./loadingDispatchOrderReconciliationModel";
import {
  loadCombinedInvoicePlanTx,finalizeCombinedInvoiceTx,
  type CombinedInvoiceScope,
} from "./loadingDispatchCombinedInvoiceService";

const base="/api/factory/customer-orders/:id/loading-dispatches/combined-invoice";
const access=requireFactoryTabAccess("factory/invoicing","hide_invoicing_loadings_tab");
async function scope(req:Request):Promise<CombinedInvoiceScope & {role:string}>{
  const state=await getFactoryAccessState(req);
  if(!state?.hasFactoryAccess){
    throw new OrderReconciliationError("COMBINED_INVOICE_ACCESS_REQUIRED","Factory access required",403);
  }
  const orderId=parseId(req.params.id);
  if(orderId===null)throw new OrderReconciliationError("COMBINED_INVOICE_ID_INVALID","Invalid Factory loading",400);
  return {
    companyId:state.companyId,orderId,
    userId:String(state.userId),username:String(req.session.username||state.userId),
    role:state.role.toLowerCase(),reason:"",postingDate:getClientDate(req),
  };
}
function errorResult(res:Response,e:unknown){
  if(e instanceof OrderReconciliationError){
    return res.status(e.status).json({code:e.code,message:e.message});
  }
  const closed=closedPeriodErrorResponse(e);
  if(closed)return res.status(closed.status).json(closed.body);
  if(["42P01","42703"].includes(String((e as {code?:string}|null)?.code))){
    return res.status(503).json({
      code:"COMBINED_INVOICE_SQL_PENDING",
      message:"The final TablePlus financial/consolidation SQL is not installed. No invoice was posted.",
    });
  }
  logger.error("Combined Factory dispatch invoice failed",{error:e});
  return res.status(500).json({
    code:"COMBINED_INVOICE_FAILED",message:"Combined invoice could not be completed. No successful finalization is confirmed.",
  });
}
export function registerFactoryDispatchCombinedInvoiceRoutes(app:Express):void{
  app.get(base+"/preview",requireAuth,access,async(req,res)=>{
    try{
      const s=await scope(req);
      const result=await db.transaction(async tx=>{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const [final]=resultRows(await tx.execute(sql`
          SELECT c.status,c.invoice_number AS "invoiceNumber",
                 c.reconciliation_fingerprint AS "fingerprint",
                 c.finalization_details AS "details",
                 o.status AS "orderStatus",o.invoice_number AS "orderInvoiceNumber"
            FROM factory_dispatch_order_consolidations c
            JOIN customer_orders o ON o.id=c.order_id AND o.company_id=c.company_id
           WHERE c.company_id=${s.companyId} AND c.order_id=${s.orderId} LIMIT 1
        `));
        if(final?.status==="FINALIZED"){
          const detail=final.details && typeof final.details==="object" ? final.details : {};
          return {
            finalized:true,ready:false,blockingReasons:[],
            fingerprint:String(final.fingerprint),
            invoiceNumber:String(final.invoiceNumber),
            finalization:detail,
            orderConsistent:final.orderStatus==="FINALIZED" &&
              final.orderInvoiceNumber===final.invoiceNumber,
          };
        }
        const {plan}=await loadCombinedInvoicePlanTx(tx,s);
        return {finalized:false,invoiceNumber:null,finalization:null,...plan};
      });
      res.setHeader("Cache-Control","private, no-store");
      return res.json(result);
    }catch(error){return errorResult(res,error);}
  });

  app.post(base+"/finalize",requireAuth,access,async(req,res)=>{
    try{
      const s=await scope(req);
      if(!["admin","owner","developer"].includes(s.role)){
        return res.status(403).json({
          code:"COMBINED_INVOICE_SUPERVISOR_ONLY",
          message:"Only Admin, Owner or Developer can finalize a combined invoice",
        });
      }
      const data=req.body;
      if(!data || typeof data!=="object" || Array.isArray(data) ||
         data.confirm!==true || data.confirmNoDuplicateReceivable!==true ||
         data.confirmTripChargesReviewed!==true ||
         typeof data.expectedFingerprint!=="string" ||
         !/^[0-9a-f]{64}$/.test(data.expectedFingerprint) ||
         typeof data.reason!=="string" ||
         data.reason.trim().length<10 || data.reason.trim().length>1000){
        return res.status(400).json({
          code:"COMBINED_INVOICE_CONFIRMATION_REQUIRED",
          message:"Review the signed trip totals, original charges and the one-invoice/no-double-billing confirmations. Enter a reason (10–1,000 characters).",
        });
      }
      s.reason=data.reason.trim();
      // Document date is derived from established Factory company-local client
      // date logic; a browser must not directly override historical ledgers.
      s.postingDate=getClientDate(req);
      const out=await db.transaction(tx=>finalizeCombinedInvoiceTx(tx,s,data.expectedFingerprint));
      let frozen=false;
      try{
        // Freeze the existing invoice engine's canonical Excel/PDF document
        // using the FINALIZED order and immutable signed trip data.
        const doc=await freezeCanonicalInvoiceDocument(s.orderId,s.companyId,!out.replayed);
        frozen=Boolean(doc && doc.status==="FINALIZED");
      }catch(error){
        // Transaction already committed. Snapshot can retry on first invoice
        // export; NEVER tell the operator the accounting failed or replay it.
        logger.error("Combined dispatch invoice document freezing pending",{
          error,orderId:s.orderId,invoiceNumber:out.invoiceNumber,
        });
      }
      if(!out.replayed){
        void dispatchNotification({
          eventType:"INVOICE_FINALIZED",title:"Combined Factory Invoice Finalized",
          message:`Invoice ${out.invoiceNumber} finalized for ${out.tripCount} dispatch trips`,
          entityType:"customer_order",entityId:s.orderId,
          triggeredByUserId:req.session.userId??null,companyId:s.companyId,
        }).catch(()=>{});
      }
      res.setHeader("Cache-Control","private, no-store");
      return res.json({...out,canonicalDocumentFrozen:frozen,
        message:frozen
          ?"One combined Factory invoice finalized. Original trip customer receivables were NOT reposted."
          :"Combined invoice finalized in accounting. Invoice document snapshot will be retried on export.",
      });
    }catch(error){return errorResult(res,error);}
  });
}
