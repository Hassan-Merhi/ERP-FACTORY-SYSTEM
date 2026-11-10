/**
 * Phase 9 read-only order-level dashboard, audit history & full Excel export.
 * All reads run under one active Factory company scope and a consistent
 * database snapshot. Finance visibility requires Admin/Owner/Developer.
 *
 * NO automated ERP PO import; "exported" never means "imported".
 */
import type { Express,Request,Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState,requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { buildSafeFilename } from "../../../lib/contentDisposition";
import { writeWorkbookToResponse } from "../../../excelHelper";
import { logger } from "../../../lib/logger";
import { loadFactoryDispatchOrderOverviewTx } from "./loadingDispatchOrderOverviewData";
import {
  loadDispatchOrderHistoryPageTx,type DispatchHistorySource,
} from "./loadingDispatchOrderHistoryData";
import { buildFactoryDispatchOrderDashboardWorkbook } from "./loadingDispatchOrderOverviewWorkbook";

const prefix="/api/factory/customer-orders/:id/loading-dispatches/order-overview";
const access=requireFactoryTabAccess("factory/invoicing","hide_invoicing_loadings_tab");
class OverviewError extends Error {
  constructor(readonly status:number,readonly code:string,message:string){super(message);}
}
async function scope(req:Request):Promise<{companyId:number;orderId:number}>{
  const state=await getFactoryAccessState(req);
  if(!state?.hasFactoryAccess)throw new OverviewError(403,"FACTORY_ACCESS_REQUIRED","Factory company access required");
  if(!["admin","owner","developer"].includes(state.role.toLowerCase())){
    throw new OverviewError(403,"DISPATCH_REPORT_FINANCE_ROLE_REQUIRED",
      "Only Admin, Owner and Developer can view customer and accounting dispatch reports");
  }
  const orderId=parseId(req.params.id);
  if(orderId===null)throw new OverviewError(400,"DISPATCH_ORDER_ID_INVALID","Invalid Factory loading order");
  return {companyId:state.companyId,orderId};
}
function parseHistory(req:Request){
  const source=String(req.query.source??"ALL").toUpperCase();
  if(!["ALL","PHYSICAL","FINANCIAL","CLOSURE"].includes(source)){
    throw new OverviewError(400,"DISPATCH_HISTORY_FILTER_INVALID","Invalid activity source filter");
  }
  const size=req.query.limit===undefined?25:Number(req.query.limit);
  if(!Number.isSafeInteger(size)||size<1||size>100){
    throw new OverviewError(400,"DISPATCH_HISTORY_LIMIT_INVALID","Choose 1–100 audit events per page");
  }
  let dispatchId:number|undefined;
  if(req.query.dispatchId!==undefined){
    if(typeof req.query.dispatchId!=="string")throw new OverviewError(400,"DISPATCH_HISTORY_TRIP_INVALID","Invalid dispatch ID");
    const parsed=parseId(req.query.dispatchId);
    if(parsed===null)throw new OverviewError(400,"DISPATCH_HISTORY_TRIP_INVALID","Invalid dispatch ID");
    dispatchId=parsed;
  }
  const cursor=req.query.cursor;
  if(cursor!==undefined && (typeof cursor!=="string"||cursor.length>256)){
    throw new OverviewError(400,"DISPATCH_HISTORY_CURSOR_INVALID","Invalid history page cursor");
  }
  return {source:source as DispatchHistorySource,limit:size,
    ...(dispatchId?{dispatchId}:{}),cursor:cursor??null};
}
function fail(res:Response,error:unknown){
  if(error instanceof OverviewError)return res.status(error.status).json({code:error.code,message:error.message});
  if(error instanceof Error && ["HISTORY_CURSOR_INVALID","HISTORY_LIMIT_INVALID"].includes(error.message)){
    return res.status(400).json({code:error.message,message:"Invalid pagination cursor or page limit"});
  }
  if(["42P01","42703"].includes(String((error as {code?:string}|null)?.code))){
    return res.status(503).json({code:"DISPATCH_REPORT_SQL_PENDING",
      message:"One or more dispatch report schema migrations are not installed; run the final TablePlus SQL before using financial reports."});
  }
  logger.error("Factory dispatch order reporting failed",{error});
  return res.status(500).json({code:"DISPATCH_ORDER_REPORT_ERROR",
    message:"The dispatch report could not be generated"});
}
export function registerFactoryDispatchOrderOverviewRoutes(app:Express):void{
  app.get(prefix,requireAuth,access,async(req,res)=>{
    try{
      const s=await scope(req);
      const overview=await db.transaction(async tx=>{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        return loadFactoryDispatchOrderOverviewTx(tx,s.companyId,s.orderId);
      });
      if(!overview)throw new OverviewError(404,"FACTORY_ORDER_NOT_FOUND","Loading order not found in selected Factory company");
      res.setHeader("Cache-Control","private, no-store");
      return res.json(overview);
    }catch(error){return fail(res,error);}
  });
  app.get(prefix+"/history",requireAuth,access,async(req,res)=>{
    try{
      const s=await scope(req);const opts=parseHistory(req);
      const result=await db.transaction(async tx=>{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const [found]=await tx.execute(sql`
          SELECT id FROM customer_orders WHERE company_id=${s.companyId} AND id=${s.orderId}
        `).then(x=>x.rows);
        if(!found)throw new OverviewError(404,"FACTORY_ORDER_NOT_FOUND","Loading order not found");
        return loadDispatchOrderHistoryPageTx(tx,{...s,...opts});
      });
      res.setHeader("Cache-Control","private, no-store");
      return res.json(result);
    }catch(error){return fail(res,error);}
  });
  app.get(prefix+"/report.xlsx",requireAuth,access,async(req,res)=>{
    try{
      const s=await scope(req);
      const payload=await db.transaction(async tx=>{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const overview=await loadFactoryDispatchOrderOverviewTx(tx,s.companyId,s.orderId);
        if(!overview)throw new OverviewError(404,"FACTORY_ORDER_NOT_FOUND","Loading order not found");
        const history=[];
        let cursor:string|null=null;
        let hasMore=false;
        // Cap Excel audit at 1,000 events to prevent large memory exports.
        // The in-app activity timeline remains unlimited and cursor-paginated.
        for(let page=0;page<10;page++){
          const result=await loadDispatchOrderHistoryPageTx(tx,{
            ...s,source:"ALL",cursor,limit:100,
          });
          history.push(...result.entries);
          hasMore=result.hasMore;
          cursor=result.nextCursor;
          if(!hasMore||!cursor)break;
        }
        return {overview,history,hasMore};
      });
      const filename=buildSafeFilename([
        "Factory_Dispatch_Overview",
        payload.overview.order.containerNumber??"loading_"+s.orderId,
        payload.overview.order.invoiceNumber??"not_finalized",
      ],"xlsx");
      const workbook=buildFactoryDispatchOrderDashboardWorkbook(
        payload.overview,payload.history,payload.hasMore,
      );
      res.setHeader("X-Content-Type-Options","nosniff");
      await writeWorkbookToResponse(workbook,res,filename);
      return;
    }catch(error){
      if(res.headersSent||res.writableEnded||res.destroyed){
        logger.error("Dispatch overview Excel response failed after headers",{error});
        return;
      }
      return fail(res,error);
    }
  });
}
