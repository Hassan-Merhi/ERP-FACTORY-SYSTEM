/** Phase 10: read-only Factory dispatch release gate and TablePlus readiness. */
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState, requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { factoryDispatchReleaseReadinessTx } from "../../../services/factory/dispatchReleaseReadiness";

const gate=requireFactoryTabAccess("factory/invoicing","hide_invoicing_loadings_tab");
export function registerFactoryDispatchReleaseReadinessRoutes(app:Express):void{
  app.get("/api/factory/customer-orders/:id/loading-dispatches/release-readiness",
    requireAuth,gate,async(req,res)=>{
      try{
        const access=await getFactoryAccessState(req);
        if(!access?.hasFactoryAccess || !["admin","owner","developer"].includes(access.role.toLowerCase())){
          return res.status(403).json({code:"FACTORY_RELEASE_ACCESS_REQUIRED",
            message:"Only Admin, Owner or Developer can inspect dispatch accounting release safeguards"});
        }
        const orderId=parseId(req.params.id);
        if(orderId===null)return res.status(400).json({code:"INVALID_LOADING",message:"Invalid loading order"});
        const out=await db.transaction(async tx=>{
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
          const [original]=resultRows(await tx.execute(sql`
            SELECT id FROM customer_orders WHERE id=${orderId}
              AND company_id=${access.companyId} LIMIT 1
          `));
          if(!original)return null;
          const reconciliation=await factoryDispatchReleaseReadinessTx(tx,"RECONCILIATION");
          const invoice=await factoryDispatchReleaseReadinessTx(tx,"FINAL_INVOICE");
          return {
            orderId,companyId:access.companyId,
            reconciliation,invoice,
            readOnly:true,
            sqlExecutedByAssistant:false,
            note:"This is a live, read-only prerequisite check. It does not run TablePlus SQL, CI checks, financial postings or production deployment.",
          };
        });
        if(!out)return res.status(404).json({code:"LOADING_NOT_FOUND",message:"Loading not found in selected Factory company"});
        res.setHeader("Cache-Control","private, no-store");
        return res.json(out);
      }catch(error){
        logger.error("Factory dispatch release readiness probe failed",{error});
        return res.status(500).json({code:"RELEASE_READINESS_ERROR",
          message:"Could not verify the Factory dispatch release safeguards"});
      }
    });
}
