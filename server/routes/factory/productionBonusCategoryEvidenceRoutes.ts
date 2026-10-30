import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { logger } from "../../lib/logger";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";
import { validateCategoryTargetSplit } from "@shared/productionTargetBonusCategoryAttribution";
import { loadProductionBonusCategoryEvidence } from "../../services/factory/productionBonusCategoryEvidenceService";
import { previewProductionBonusCategories } from "../../services/factory/productionBonusCategoryCalculator";

const guard=requireFactoryTabAccess("factory/stock-entry","hide_tab_stockentry_production_targets");
const authorized=(req:Request)=>["Admin","Owner"].includes(String(req.session.currentRole || req.user?.role || ""));
const companyFor=(req:Request)=>Number(req.session.factoryCompanyId || req.session.currentCompanyId)||null;

function safeError(res:Response,error:unknown) {
  const status = error && typeof error === "object" && "status" in error &&
    typeof error.status === "number" ? error.status : 500;
  if (status >= 500) logger.error("Production bonus category attribution error", { error });
  return res.status(status).json({
    message:status>=500?"Category production evidence request failed":
      error instanceof Error?error.message:"Invalid category allocation",
  });
}
function fail(status:number,message:string):never {
  throw Object.assign(new Error(message),{status});
}

export function registerProductionBonusCategoryEvidenceRoutes(app:Express):void {
  // Phase 10: company-scoped, no-store, read-only category-weighted proposal.
  // Never approve, post or mutate accounting from this endpoint.
  app.get("/api/factory/production-target-bonuses/category-preview",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!authorized(req))return res.status(403).json({message:"Admin or Owner required"});
      const companyId=companyFor(req);
      if(!companyId)return res.status(400).json({message:"Factory company required"});
      const date=req.query.date;
      if(!isBonusCategoryDate(date))return res.status(400).json({message:"Valid production date required"});
      try {
        res.setHeader("Cache-Control","private, no-store");
        return res.json(await previewProductionBonusCategories(companyId,date));
      }catch(error){return safeError(res,error);}
    },
  );

  app.get("/api/factory/production-target-bonuses/category-evidence",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!authorized(req))return res.status(403).json({message:"Admin or Owner required"});
      const companyId=companyFor(req);
      if(!companyId)return res.status(400).json({message:"Factory company required"});
      const date=req.query.date;
      if(!isBonusCategoryDate(date))return res.status(400).json({message:"Valid production date required"});
      try {
        res.setHeader("Cache-Control","private, no-store");
        return res.json(await loadProductionBonusCategoryEvidence(db,companyId,date));
      }catch(error){return safeError(res,error);}
    },
  );

  app.post("/api/factory/production-target-bonuses/category-targets",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!authorized(req))return res.status(403).json({message:"Admin or Owner required"});
      const companyId=companyFor(req);
      if(!companyId)return res.status(400).json({message:"Factory company required"});
      const date=req.body?.date;
      const workerId=Number(req.body?.workerId);
      const raw=req.body?.allocations;
      if(!isBonusCategoryDate(date)||!Number.isSafeInteger(workerId)||workerId<=0||
         !Array.isArray(raw)||raw.length<1||raw.length>100||req.body?.confirm!==true) {
        return res.status(400).json({message:"Confirm one worker/day and 1–100 category target allocations"});
      }
      const allocations: Array<{categoryKey:string;targetBales:number}>=[];
      for(const item of raw as unknown[]) {
        if(!item||typeof item!=="object")return res.status(400).json({message:"Invalid category allocation"});
        const value=item as Record<string,unknown>;
        if(typeof value.categoryKey!=="string"||typeof value.targetBales!=="number"||
           !Number.isFinite(value.targetBales))return res.status(400).json({message:"Invalid category or target"});
        allocations.push({categoryKey:value.categoryKey,targetBales:value.targetBales});
      }
      try {
        const result=await db.transaction(async(tx)=>{
          // Serializes target allocations with Phase 4 approvals and Phase 5 payments.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023,${companyId})`);
          const evidence=await loadProductionBonusCategoryEvidence(tx,companyId,date);
          if(!evidence.finalized)fail(409,"Production day is not finalized");
          if(!evidence.readyForTargetAllocation)fail(409,
            "Category bale evidence is incomplete or differs from finalized production");
          const worker=evidence.workers.find(w=>w.workerId===workerId);
          if(!worker)fail(404,"Worker not found in finalized production");
          if(worker.dailyTargetBales===null)fail(409,"Worker has no saved daily target");
          if(worker.status==="Absent")fail(409,"Absent worker cannot claim category production");
          const issue=validateCategoryTargetSplit(worker.dailyTargetBales,worker.categories,allocations);
          if(issue)fail(400,issue);
          const existing=resultRows(await tx.execute(sql`
            SELECT id, daily_target_bales::text AS target
            FROM factory_target_bonus_category_allocation_sets
            WHERE company_id=${companyId} AND production_date=${date}::date
              AND worker_id=${workerId} LIMIT 1 FOR UPDATE
          `)) as Array<{id:number|string;target:string}>;
          if(existing.length) {
            const existingAllocation=evidence.allocations.filter(a=>a.workerId===workerId);
            const same=Number(existing[0].target)===worker.dailyTargetBales &&
              existingAllocation.length===allocations.length &&
              allocations.every(a=>existingAllocation.some(old=>
                old.categoryKey===a.categoryKey && old.targetBales===a.targetBales &&
                old.creditedBales===worker.categories.find(c=>c.categoryKey===a.categoryKey)?.creditedBales));
            if(!same)fail(409,"Worker/day category targets already saved; historical snapshots are immutable");
            return {replayed:true,allocationSetId:Number(existing[0].id)};
          }
          // A prior review/payment cannot be retrospectively reclassified.
          const reviewed=resultRows(await tx.execute(sql`
            SELECT 1 FROM factory_target_bonus_reviews
            WHERE company_id=${companyId} AND production_date=${date}::date
              AND worker_id=${workerId} LIMIT 1
          `));
          if(reviewed.length)fail(409,"Existing approved/rejected bonus prevents category-target amendments");
          const set=resultRows(await tx.execute(sql`
            INSERT INTO factory_target_bonus_category_allocation_sets
              (company_id,production_date,worker_id,daily_target_bales,allocated_by)
            VALUES (${companyId},${date}::date,${workerId},
                    ${worker.dailyTargetBales},${String(req.session.userId||"")})
            RETURNING id
          `)) as Array<{id:number|string}>;
          const allocationSetId=Number(set[0].id);
          for(const value of allocations) {
            const source=worker.categories.find(c=>c.categoryKey===value.categoryKey);
            if(!source)fail(409,"Category evidence changed during review");
            await tx.execute(sql`
              INSERT INTO factory_target_bonus_category_allocations
                (allocation_set_id,category_key,category_label,credited_bales,target_bales)
              VALUES (${allocationSetId},${source.categoryKey},${source.categoryLabel},
                      ${source.creditedBales},${value.targetBales})
            `);
          }
          return {replayed:false,allocationSetId};
        });
        return res.status(result.replayed?200:201).json({
          ...result,workerId,date,categoryCount:allocations.length,
          payoutCalculated:false,accountingPosted:false,
        });
      }catch(error){return safeError(res,error);}
    },
  );
}
