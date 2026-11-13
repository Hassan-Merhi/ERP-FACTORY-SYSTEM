import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../../../auth";
import { db } from "../../../../db";
import { logger } from "../../../../lib/logger";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { closedPeriodErrorResponse } from "../../../../lib/closedPeriodError";
import { toMoney } from "../../../../lib/money";
import { customerBalances, customerOrderBales, customerOrderBalesHistory,
  customerOrderBaleRemovals, customerOrders, factoryBales } from "@shared/schema";
import { recalculateOrderTotals } from "../../_helpers";
import { lockCustomerOrderTx, syncOrderTotalsTx } from "../orderChargeLedger";
import { hasAnyPhysicalDispatchTx, hasLiveFinancialTripTx } from "../../../../services/factory/dispatchTripFinancialGuards";
import { reversePriorityAllocationForDeletedBaleTx } from "../priorityAutoAllocation";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../priorityScanQueue";
import { freezeCanonicalInvoiceDocument } from "../../../../services/factoryInvoiceDocumentService";
import { writeAuditEvent } from "../../../../services/audit/auditService";

/** Finalized customer loading returns, NOT Factory POS. Only Admin/Developer. */
const gate = [requireAuth, requireRole("Admin", "Developer")] as const;
const company = (req: Request) => req.session.factoryCompanyId || req.session.currentCompanyId;
const id = (v: unknown) => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
class ReturnBlocked extends Error {}
const fail = (reason: string): never => { throw new ReturnBlocked(reason); };

export function registerFinalizedLoadingReturnRoutes(app: Express): void {
  app.get("/api/factory/finalized-sale-returns/orders", ...gate, async (req: Request, res: Response) => {
    try {
      const cid = company(req);
      if (!cid) return res.status(400).json({ message: "Select a Factory company" });
      const term = "%" + String(req.query.search ?? "").trim().slice(0, 100) + "%";
      const result = await db.execute(sql`
        SELECT o.id, o.invoice_number AS "invoiceNumber", o.container_number AS "containerNumber",
          o.grand_total::text AS "grandTotal", o.total_qty_bales AS "quantity",
          c.legal_name AS "customerName"
        FROM customer_orders o LEFT JOIN customers c
          ON c.id=o.customer_id AND c.company_id=o.company_id
        WHERE o.company_id=${cid} AND o.deleted_at IS NULL AND o.status='FINALIZED'
          AND (o.previous_status='LOADING' OR o.loading_started_at IS NOT NULL OR o.loading_finalized_at IS NOT NULL)
          AND (o.invoice_number ILIKE ${term} OR COALESCE(o.container_number,'') ILIKE ${term}
            OR COALESCE(c.legal_name,'') ILIKE ${term})
        ORDER BY o.finalized_at DESC NULLS LAST, o.id DESC LIMIT 100
      `);
      return res.json(result.rows);
    } catch (error) {
      logger.error("finalized loading returns search", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/finalized-sale-returns/orders/:id", ...gate, async (req: Request, res: Response) => {
    try {
      const cid = company(req), oid = id(req.params.id);
      if (!cid || !oid) return res.status(400).json({ message: "Invalid company or invoice" });
      const [order] = await db.select().from(customerOrders)
        .where(and(eq(customerOrders.companyId,cid),eq(customerOrders.id,oid)));
      if (!order || order.status !== "FINALIZED" || order.deletedAt)
        return res.status(404).json({ message: "Finalized invoice not found" });
      const rows = await db.execute(sql`
        SELECT ob.bale_id AS "baleId", ob.bale_reference AS "referenceNumber",
          ob.article_code AS "articleCode", ob.bale_name AS "productName",
          ob.weight::text AS "weightKg", ob.price_used::text AS "priceUsed",
          b.status, b.total_cost::text AS "costUsd",
          b.erp_location_id AS "currentLocationId", ob.location_id AS "soldLocationId"
        FROM customer_order_bales ob JOIN factory_bales b
          ON b.id=ob.bale_id AND b.company_id=${cid}
        WHERE ob.order_id=${oid}
        ORDER BY ob.article_code, ob.bale_reference
      `);
      const dispatch = await db.transaction(async tx =>
        !!order.dispatchBatchId || await hasAnyPhysicalDispatchTx(tx,cid,oid) ||
        await hasLiveFinancialTripTx(tx,cid,oid));
      return res.json({
        order: { id:order.id, invoiceNumber:order.invoiceNumber,
          containerNumber:order.containerNumber, grandTotal:order.grandTotal,
          totalQtyBales:order.totalQtyBales },
        bales:rows.rows,
        blockedReason:dispatch ? "This invoice has dispatch-trip accounting; use the posted-trip credit/reversal workflow." : null
      });
    } catch (error) {
      logger.error("finalized loading returns invoice", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/finalized-sale-returns/history", ...gate, async (req: Request, res: Response) => {
    try {
      const cid = company(req);
      if (!cid) return res.status(400).json({ message: "Select a Factory company" });
      const rows = await db.execute(sql`
        SELECT return_batch AS "returnBatch", order_id AS "orderId",
          invoice_number AS "invoiceNumber", container_number AS "containerNumber",
          product_name AS "productName", article_code AS "articleCode",
          COUNT(*)::integer AS "quantity",
          STRING_AGG(bale_reference, ', ' ORDER BY bale_reference) AS "baleReferences",
          MAX(original_total)::text AS "originalTotal", MAX(revised_total)::text AS "revisedTotal",
          MIN(returned_at) AS "returnedAt", MAX(returned_by) AS "returnedBy",
          MAX(reason) AS reason
        FROM factory_finalized_sale_returns WHERE company_id=${cid}
        GROUP BY return_batch, order_id, invoice_number, container_number, product_name, article_code
        ORDER BY MIN(returned_at) DESC LIMIT 500
      `);
      return res.json(rows.rows);
    } catch (error) {
      logger.error("finalized loading returns history", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/finalized-sale-returns/apply", ...gate, async (req: Request, res: Response) => {
    try {
      const cid=company(req), oid=id(req.body?.orderId);
      const raw: unknown=req.body?.baleIds;
      const reason=String(req.body?.reason ?? "").trim();
      const expected=String(req.body?.expectedTotal ?? "").trim();
      if (!cid || !oid) return res.status(400).json({ message:"Select a finalized invoice" });
      if (!Array.isArray(raw) || raw.length<1 || raw.length>200 || raw.some(x=>id(x)===null))
        return res.status(400).json({ message:"Select 1–200 valid physical bale references" });
      const baleIds=raw.map(Number) as number[];
      if (new Set(baleIds).size !== baleIds.length)
        return res.status(400).json({ message:"A bale was selected twice" });
      if (reason.length<5 || reason.length>500)
        return res.status(400).json({ message:"Return reason must be 5–500 characters" });
      if (req.body?.confirmReturn !== true)
        return res.status(400).json({ message:"Confirm selected bales are physically returned" });
      if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(expected))
        return res.status(400).json({ message:"Refresh invoice before returning its bales" });

      const applied=await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${cid})`);
        const order=await lockCustomerOrderTx(tx,cid,oid);
        if (!order || order.deletedAt || order.status!=="FINALIZED" || !order.invoiceNumber)
          fail("This invoice is no longer finalized");
        if (!(order.previousStatus==="LOADING" || order.loadingStartedAt || order.loadingFinalizedAt))
          fail("This page is for finalized container loadings only");
        if (order.dispatchBatchId || await hasAnyPhysicalDispatchTx(tx,cid,oid) ||
            await hasLiveFinancialTripTx(tx,cid,oid))
          fail("Dispatch-trip financial postings cannot be rewritten through ordinary invoice returns");
        const original=toMoney(order.grandTotal).toDecimalPlaces(2);
        if (!original.eq(toMoney(expected))) fail("Invoice total changed. Refresh the invoice");

        // Only an unallocated SALE row is safe to reprice without altering
        // separately settled customer payments and cash vouchers.
        const balances=await tx.select().from(customerBalances).where(and(
          eq(customerBalances.companyId,cid), eq(customerBalances.referenceType,"INVOICE"),
          eq(customerBalances.referenceId,oid))).for("update");
        if (balances.length!==1 || balances[0].transactionType!=="SALE")
          fail("Invoice has payment/settlement history; review credit allocation before returning");

        const assignments=await tx.select().from(customerOrderBales)
          .where(and(eq(customerOrderBales.orderId,oid),inArray(customerOrderBales.baleId,baleIds))).for("update");
        if (assignments.length!==baleIds.length)
          fail("A selected bale is no longer linked to the original finalized invoice");
        const physical=await tx.select().from(factoryBales).where(and(
          eq(factoryBales.companyId,cid),inArray(factoryBales.id,baleIds))).for("update");
        if (physical.length!==baleIds.length) fail("Physical bale not found");
        const byId=new Map(physical.map(b=>[b.id,b]));
        const duplicate=await tx.execute(sql`
          SELECT 1 FROM factory_finalized_sale_returns WHERE company_id=${cid} AND order_id=${oid}
           AND bale_id IN (${sql.join(baleIds.map(x=>sql`${x}`),sql`,`)}) LIMIT 1
        `);
        if (duplicate.rows.length) fail("Selected bale already has a recorded return");
        const other=await tx.execute(sql`
          SELECT 1 FROM customer_order_bales WHERE order_id<>${oid}
            AND bale_id IN (${sql.join(baleIds.map(x=>sql`${x}`),sql`,`)}) LIMIT 1
        `);
        if (other.rows.length) fail("Bale is also assigned to a different loading");
        for(const a of assignments){
          const b=byId.get(a.baleId);
          if (!b) fail("Bale " + a.baleReference + " is missing");
          if (b.deletedAt || !["SOLD","IN_STOCK"].includes(b.status))
            fail("Bale " + a.baleReference + " has an incompatible stock status");
          if (b.erpLocationId!==a.locationId)
            fail("Bale "+a.baleReference+" moved locations; reconcile stock before return");
        }
        // Keep original scan evidence before removing the active sale link.
        for(const a of assignments){
          await tx.insert(customerOrderBalesHistory).values({
            originalId:a.id,orderId:oid,baleId:a.baleId,baleReference:a.baleReference,
            locationId:a.locationId,weight:a.weight,articleCode:a.articleCode,
            baleName:a.baleName,priceUsed:a.priceUsed,scannedBy:a.scannedBy
          });
        }
        await tx.delete(customerOrderBales).where(and(
          eq(customerOrderBales.orderId,oid),inArray(customerOrderBales.baleId,baleIds)));
        await tx.update(factoryBales).set({status:"IN_STOCK",updatedAt:new Date()})
          .where(and(eq(factoryBales.companyId,cid),inArray(factoryBales.id,baleIds),
            eq(factoryBales.status,"SOLD")));
        for(const a of assignments){
          await tx.insert(customerOrderBaleRemovals).values({
            orderId:oid,baleId:a.baleId,referenceNumber:a.baleReference,
            articleCode:a.articleCode,productName:a.baleName,weightKg:a.weight,
            removedByUserId:req.session.userId==null?null:String(req.session.userId),
            removedByUsername:req.session.username ?? null
          });
          await reversePriorityAllocationForDeletedBaleTx(tx,{
            companyId:cid,baleId:a.baleId,detachedOrderId:oid,
            actor:String(req.session.username || req.session.userId || "admin"),
            actorId:req.session.userId==null?null:String(req.session.userId),
            reason:"Returned bale from finalized customer invoice"
          });
        }
        await recalculateOrderTotals(tx,oid);
        await syncOrderTotalsTx(tx,cid,oid);
        const [updated]=await tx.select().from(customerOrders)
          .where(and(eq(customerOrders.companyId,cid),eq(customerOrders.id,oid)));
        if(!updated) fail("Invoice disappeared during correction");
        const revised=toMoney(updated.grandTotal).toDecimalPlaces(2);
        if(revised.gt(original)) fail("A return unexpectedly increased the invoice value");
        const batch=randomUUID();
        for(const a of assignments){
          const b=byId.get(a.baleId)!;
          await tx.execute(sql`
            INSERT INTO factory_finalized_sale_returns
            (return_batch,company_id,order_id,customer_id,invoice_number,container_number,
             bale_id,bale_reference,article_code,product_name,weight_kg,sale_price,cost_usd,
             original_total,revised_total,reason,returned_by)
            VALUES (${batch},${cid},${oid},${order.customerId},${order.invoiceNumber},
              ${order.containerNumber},${a.baleId},${a.baleReference},${a.articleCode},
              ${a.baleName},${a.weight},${a.priceUsed},${b.totalCost},
              ${original.toFixed(2)},${revised.toFixed(2)},${reason},
              ${req.session.username || String(req.session.userId || "admin")})
          `);
        }
        await writeAuditEvent({
          userId:req.session.userId ?? undefined,username:req.session.username ?? undefined,
          companyId:cid,action:"update",
          tableName:"factory_finalized_sale_returns",recordId:oid,
          recordIdentifier:"Invoice "+order.invoiceNumber,
          changes:{
            returnBatch:{old:null,new:batch},
            baleReferences:{old:null,new:assignments.map(a=>a.baleReference)},
            total:{old:original.toFixed(2),new:revised.toFixed(2)}
          }
        },tx);
        return {returnBatch:batch,orderId:oid,invoiceNumber:order.invoiceNumber,
          quantity:assignments.length,originalTotal:original.toFixed(2),
          revisedTotal:revised.toFixed(2),customerCredit:original.minus(revised).toFixed(2)};
      });
      let snapshotUpdated=false;
      try { snapshotUpdated=!!await freezeCanonicalInvoiceDocument(oid,cid,true); }
      catch(error){logger.error("Return posted but invoice snapshot refresh failed",{error,oid,cid});}
      return res.json({...applied,snapshotUpdated,warning:snapshotUpdated?null:
        "Return posted to stock and accounting, but invoice print snapshot needs repair."});
    } catch(error){
      if(error instanceof ReturnBlocked)return res.status(409).json({message:error.message});
      const closed=closedPeriodErrorResponse(error);
      if(closed)return res.status(closed.status).json(closed.body);
      logger.error("Finalized customer loading return failed",{error});
      return res.status(500).json({message:getErrorMessage(error)});
    }
  });
}
