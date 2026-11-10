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
import { resultRows } from "../../../lib/queryResult";
import { buildSafeFilename } from "../../../lib/contentDisposition";
import { createWorkbook,writeWorkbookToResponse } from "../../../excelHelper";
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
  // Read-only, posted-revision bale pricing for an individual trip invoice.
  // Never use mutable order lines or unposted scan estimates as invoice prices.
  app.get(prefix+"/trips/:dispatchId/invoice-lines",requireAuth,access,async(req,res)=>{
    try{
      const context=await scope(req);
      const dispatchId=parseId(req.params.dispatchId);
      if(dispatchId===null)throw new OverviewError(400,"DISPATCH_TRIP_ID_INVALID","Invalid trip ID");
      const lines=await db.transaction(async tx=>{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const [financial]=resultRows(await tx.execute(sql`
          SELECT id,snapshot_revision,goods_subtotal::text AS "goodsSubtotal"
          FROM factory_dispatch_trip_financials
          WHERE company_id=${context.companyId} AND order_id=${context.orderId}
            AND dispatch_id=${dispatchId} AND status IN ('POSTED','CONSOLIDATED')
          LIMIT 1
        `));
        if(!financial)throw new OverviewError(409,"DISPATCH_TRIP_NOT_POSTED","Trip must be financially posted before invoice export");
        const records=resultRows(await tx.execute(sql`
          SELECT article_code AS "articleCode",product_name AS "productName",
            pricing_mode AS "pricingMode",unit_price::text AS "unitPrice",
            weight_kg::text AS "weightKg",line_total::text AS "lineTotal"
          FROM factory_dispatch_trip_financial_bales
          WHERE company_id=${context.companyId} AND order_id=${context.orderId}
            AND dispatch_id=${dispatchId} AND financial_id=${Number(financial.id)}
            AND snapshot_revision=${Number(financial.snapshot_revision)}
          ORDER BY article_code,product_name,bale_id
        `));
        if(!records.length)throw new OverviewError(409,"DISPATCH_TRIP_LINES_MISSING","Posted trip has no frozen bale pricing");
        return {goodsSubtotal:String(financial.goodsSubtotal),lines:records};
      });
      res.setHeader("Cache-Control","private, no-store");
      return res.json(lines);
    }catch(error){return fail(res,error);}
  });
  app.get(prefix+"/trips/:dispatchId/invoice.xlsx",requireAuth,access,async(req,res)=>{
    try{
      const context=await scope(req);
      const dispatchId=parseId(req.params.dispatchId);
      if(dispatchId===null)throw new OverviewError(400,"DISPATCH_TRIP_ID_INVALID","Invalid trip ID");
      const data=await db.transaction(async tx=>{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const [header]=resultRows(await tx.execute(sql`
          SELECT f.id AS "financialId",f.snapshot_revision AS revision,
            f.goods_subtotal::text AS goods,f.billable_charges_total::text AS billable,
            f.discount_total::text AS discounts,f.customer_total::text AS total,
            d.dispatch_number AS "tripNumber",d.closed_at AS "closedAt",
            co.container_number AS container,c.legal_name AS customer,
            cmp.name AS company
          FROM factory_dispatch_trip_financials f
          JOIN factory_loading_dispatches d ON d.id=f.dispatch_id AND d.company_id=f.company_id AND d.order_id=f.order_id
          JOIN customer_orders co ON co.id=f.order_id AND co.company_id=f.company_id
          LEFT JOIN customers c ON c.id=co.customer_id AND c.company_id=co.company_id
          LEFT JOIN companies cmp ON cmp.id=f.company_id
          WHERE f.company_id=${context.companyId} AND f.order_id=${context.orderId}
            AND f.dispatch_id=${dispatchId} AND f.status IN ('POSTED','CONSOLIDATED')
          LIMIT 1
        `));
        if(!header)throw new OverviewError(409,"DISPATCH_TRIP_NOT_POSTED","Financially finalize this trip before exporting an invoice");
        const lines=resultRows(await tx.execute(sql`
          SELECT article_code AS "articleCode",product_name AS "productName",
            pricing_mode AS "pricingMode",unit_price::text AS "unitPrice",
            weight_kg::text AS "weightKg",line_total::text AS "lineTotal"
          FROM factory_dispatch_trip_financial_bales
          WHERE company_id=${context.companyId} AND order_id=${context.orderId}
            AND dispatch_id=${dispatchId} AND financial_id=${Number(header.financialId)}
            AND snapshot_revision=${Number(header.revision)}
          ORDER BY article_code,product_name,bale_id
        `));
        const charges=resultRows(await tx.execute(sql`
          SELECT name,kind,amount::text AS amount
          FROM factory_dispatch_trip_charges
          WHERE company_id=${context.companyId} AND order_id=${context.orderId}
            AND dispatch_id=${dispatchId} AND financial_id=${Number(header.financialId)}
            AND revision=${Number(header.revision)} AND locked_at IS NOT NULL
            AND kind IN ('BILLABLE','DISCOUNT')
          ORDER BY id
        `));
        return {header,lines,charges};
      });
      const h=data.header;
      const cents=(value:unknown)=>Math.round(Number(value??0)*100);
      if(!data.lines.length || data.lines.reduce((n,l)=>n+cents(l.lineTotal),0)!==cents(h.goods))
        throw new OverviewError(409,"DISPATCH_INVOICE_GOODS_MISMATCH","Frozen article totals do not match posted trip goods");
      if(cents(h.goods)+cents(h.billable)-cents(h.discounts)!==cents(h.total))
        throw new OverviewError(409,"DISPATCH_INVOICE_TOTAL_MISMATCH","Posted trip totals are inconsistent");
      const safe=(value:unknown)=>{const v=String(value??"");return /^[\\s]*[=+@-]/.test(v)?"'"+v:v;};
      const wb=createWorkbook();
      wb.creator="Factory Dispatch";
      wb.title="Trip "+h.tripNumber+" invoice";
      const ws=wb.addWorksheet("Trip Invoice",{views:[{state:"frozen",ySplit:9}]});
      ws.columns=[{width:19},{width:37},{width:12},{width:16},{width:17},{width:17},{width:19}];
      ws.mergeCells("A1:G2");ws.getCell("A1").value=safe(h.company||"FACTORY");
      ws.getCell("A1").font={size:19,bold:true,color:{argb:"FFFFFFFF"}};
      ws.getCell("A1").fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF173F76"}};
      ws.getCell("A1").alignment={vertical:"middle"};
      ws.mergeCells("A3:G3");ws.getCell("A3").value="CUSTOMER TRIP INVOICE — POSTED FINANCIAL RECORD";
      ws.getCell("A3").font={bold:true,size:14,color:{argb:"FF173F76"}};
      ws.getCell("A5").value="Customer";ws.getCell("B5").value=safe(h.customer);
      ws.getCell("D5").value="Trip #";ws.getCell("E5").value=Number(h.tripNumber);
      ws.getCell("A6").value="Order #";ws.getCell("B6").value=context.orderId;
      ws.getCell("D6").value="Container";ws.getCell("E6").value=safe(h.container);
      ws.getCell("A7").value="Closed at";ws.getCell("B7").value=h.closedAt?String(h.closedAt):"—";
      ws.getRow(8).values=["Article code","Product description","Bales","Weight KG","Price basis","Unit price USD","Line total USD"];
      const headerRow=ws.getRow(8);headerRow.font={bold:true,color:{argb:"FFFFFFFF"}};
      headerRow.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF173F76"}};
      const groups=new Map<string,{article:string;product:string;basis:string;price:number;qty:number;weight:number;total:number}>();
      for(const l of data.lines){
        const key=JSON.stringify([l.articleCode,l.productName,l.pricingMode,l.unitPrice]);
        const g=groups.get(key)||{article:String(l.articleCode),product:String(l.productName),basis:String(l.pricingMode),price:Number(l.unitPrice),qty:0,weight:0,total:0};
        g.qty++;g.weight+=Number(l.weightKg);g.total+=cents(l.lineTotal);groups.set(key,g);
      }
      for(const g of groups.values())ws.addRow([safe(g.article),safe(g.product),g.qty,g.weight,g.basis,g.price,g.total/100]);
      ws.addRow([]);
      ws.addRow(["","GOODS SUBTOTAL","","","","",Number(h.goods)]);
      ws.addRow(["","ADDITIONAL CHARGES / DISCOUNTS"]);
      for(const c of data.charges)ws.addRow(["",safe(c.name),c.kind,"","","",Number(c.amount)*(c.kind==="DISCOUNT"?-1:1)]);
      ws.addRow(["","BILLABLE CHARGES","","","","",Number(h.billable)]);
      ws.addRow(["","DISCOUNTS","","","","",-Number(h.discounts)]);
      const totalRow=ws.addRow(["","TOTAL CUSTOMER RECEIVABLE (USD)","","","","",Number(h.total)]);
      totalRow.font={bold:true,size:13,color:{argb:"FFFFFFFF"}};
      totalRow.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF173F76"}};
      ws.getColumn(6).numFmt="#,##0.0000";
      ws.getColumn(7).numFmt="#,##0.00;[Red](#,##0.00)";
      ws.getColumn(4).numFmt="#,##0.00";
      ws.pageSetup={paperSize:9,orientation:"landscape",fitToPage:true,fitToWidth:1,fitToHeight:0};
      const file=buildSafeFilename(["Factory_Trip_Invoice",String(h.tripNumber),"Order",String(context.orderId)],"xlsx");
      res.setHeader("X-Content-Type-Options","nosniff");
      await writeWorkbookToResponse(wb,res,file);
    }catch(error){
      if(res.headersSent||res.writableEnded||res.destroyed){logger.error("Trip invoice Excel failed after headers",{error});return;}
      return fail(res,error);
    }
  });
  app.get(prefix+"/history",requireAuth,access,async(req,res)=>{
    try{
      const s=await scope(req);const opts=parseHistory(req);
      const result=await db.transaction(async tx=>{
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const [found]=resultRows(await tx.execute(sql`
          SELECT id FROM customer_orders WHERE company_id=${s.companyId} AND id=${s.orderId}
        `));
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
