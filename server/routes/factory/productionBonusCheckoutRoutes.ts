/**
 * Single Payroll-style Production Targets bonus checkout.
 * One company transaction freezes the calculation, approves it, posts the
 * voucher and creates the linked Daybook entry. No manual category target
 * allocation and no End Production prerequisite.
 */
import type { Express, Request, Response } from "express";
import { bonusServerText } from "../../i18n/productionBonusCheckoutMessages";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import type { DatabaseOrTransaction } from "../../db";
import { requireAuth } from "../../auth";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { resultRows } from "../../lib/queryResult";
import { logger } from "../../lib/logger";
import { errorStatus, translateDatabaseError } from "../../lib/httpHandlers";
import { loadTargetBonusRows, targetBonusIsValidDate } from "../../services/factory/targetBonusReview";
import { postTargetBonusPaymentsInTransaction } from "../../services/factory/targetBonusPaymentService";
import { parseTargetBonusPaymentCommand } from "../../services/factory/targetBonusPaymentPolicy";
import { normalizeBonusCategory } from "@shared/productionTargetBonusCategoryRates";
import { splitExtraBalesByCategory, workerCategoryCredits } from "@shared/productionBonusCheckoutMath";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";

const guard = requireFactoryTabAccess("factory/stock-entry", "hide_tab_stockentry_production_targets");
type Method = "standard" | "category";
type BonusLine = { category: string; produced: number; extra: number; rate: string; bonus: string };
type Offer = {
  date: string; workerId: number; workerName: string; target: number; produced: number;
  extra: number; method: Method; lines: BonusLine[]; amount: string; token: string;
  status: "pending" | "approved" | "paid" | "reversed" | "blocked" | "rejected";
  issue: string | null;
};
type RecordRow = Record<string, unknown>;
const rows = (x: unknown): RecordRow[] => resultRows(x) as RecordRow[];
const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
const usd = (value: Decimal.Value) => new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const allowed = (req: Request) => ["Admin", "Owner"].includes(String(req.session.currentRole || req.user?.role || ""));
const company = (req: Request) => Number(req.session.factoryCompanyId || req.session.currentCompanyId) || null;
const actor = (req: Request) => ({
  userId: String(req.session.userId || ""), username: String(req.session.username || req.session.userId || ""),
});

async function creditedCategories(
  tx: DatabaseOrTransaction, companyId: number, date: string,
  workerId: number, groupId: number | null,
): Promise<Array<{ category: string; count: number }>> {
  const members = groupId == null ? [workerId] :
    rows(await tx.execute(sql`
      SELECT worker_id AS id FROM factory_worker_production_link_members
      WHERE company_id=${companyId} AND link_id=${groupId}
      ORDER BY worker_id
    `)).map(item => Number(item.id));
  if (!members.includes(workerId) || !members.length) fail(409, "Worker link assignment changed");
  const memberSql = sql.join(members.map(id => sql`${id}`), sql`,`);
  const closed = rows(await tx.execute(sql`
    SELECT 1 FROM factory_staff_tracking_period_closures
    WHERE company_id=${companyId} AND page_type='production'
      AND period_type='daily' AND period_start=${date}::date
      AND period_end=${date}::date LIMIT 1
  `)).length > 0;
  // Historical closed days always use their immutable per-bale category capture.
  // Open days use the same stock status and carry convention as Production Targets.
  const found = closed ? rows(await tx.execute(sql`
    SELECT bale_id AS id, worker_id AS worker, category_label AS category
    FROM factory_target_bonus_category_bale_snapshots
    WHERE company_id=${companyId} AND production_date=${date}::date
      AND worker_id IN (${memberSql})
    ORDER BY bale_id
  `)) : rows(await tx.execute(sql`
    SELECT fb.id, fb.finalized_by AS worker, fb.category
    FROM factory_bales fb
    WHERE fb.company_id=${companyId}
      AND fb.finalized_by IN (${memberSql})
      AND fb.status IN ('IN_STOCK','SOLD','RESERVED_FOR_ORDER','DISPATCHED','FINALIZED')
      AND (
        fb.stock_entry_date=${date}::date OR
        (fb.stock_entry_date=${date}::date - 1 AND
         COALESCE(fb.finalized_at,fb.created_at) >
          (SELECT c.ended_at FROM factory_staff_tracking_period_closures c
           WHERE c.company_id=${companyId} AND c.page_type='production'
            AND c.period_type='daily' AND c.period_start=${date}::date - 1
            AND c.period_end=${date}::date - 1 LIMIT 1))
      )
    ORDER BY fb.id
    FOR SHARE OF fb
  `));
  if (!found.length) return [];
  // Frozen or live bales are ordered by their physical ID before splitting.
  return workerCategoryCredits(found.map(bale=>({
    id:Number(bale.id), worker:bale.worker==null?null:Number(bale.worker),
    category:typeof bale.category==="string"?bale.category:null,
  })),members,workerId);
}

async function calculateOffers(
  tx: DatabaseOrTransaction, companyId: number, date: string, method: Method,
): Promise<Offer[]> {
  const [daily, claims, weekly] = await Promise.all([
    loadTargetBonusRows(tx, companyId, date, date),
    tx.execute(sql`
      SELECT rv.worker_id AS "workerId", rv.status, rv.bonus_amount::text AS amount,
        p.status AS "paymentStatus", details.method AS "checkoutMethod",
        details.breakdown AS breakdown, details.calculation_hash AS "calculationHash"
      FROM factory_target_bonus_reviews rv
      LEFT JOIN factory_target_bonus_payments p
        ON p.company_id=rv.company_id AND p.review_id=rv.id
      LEFT JOIN factory_target_bonus_checkout_details details
        ON details.company_id=rv.company_id AND details.review_id=rv.id
      WHERE rv.company_id=${companyId} AND rv.production_date=${date}::date
    `),
    tx.execute(sql`
      SELECT method FROM factory_production_target_bonus_weekly_methods
      WHERE company_id=${companyId}
        AND effective_week <= ${mondayOfProductionBonusWeek(date)!}::date
      ORDER BY effective_week DESC,id DESC LIMIT 1
    `),
  ]);
  const claimsByWorker = new Map(rows(claims).map(row => [Number(row.workerId),row]));
  const weeklyFlat = rows(weekly)[0]?.method === "weekly_flat";
  const weeklyClaims = new Set(rows(await tx.execute(sql`
    SELECT worker_id AS id FROM factory_target_bonus_weekly_reviews
    WHERE company_id=${companyId} AND ${date}::date BETWEEN week_start AND week_end
  `)).map(row=>Number(row.id)));
  const categoryClaims = new Set(rows(await tx.execute(sql`
    SELECT worker_id AS id FROM factory_target_bonus_category_reviews
    WHERE company_id=${companyId} AND production_date=${date}::date
  `)).map(row=>Number(row.id)));
  const result: Offer[] = [];
  for(const item of daily) {
    const claim = claimsByWorker.get(item.workerId);
    const lines: BonusLine[] = [];
    let issue: string | null = null;
    let amount = "0.00";
    if (claim) {
      if (claim.checkoutMethod && claim.checkoutMethod !== method) issue="Already reviewed using another bonus method";
      if (!claim.checkoutMethod && method === "category") issue="Already reviewed with standard per-bale bonus";
      const savedLines=claim.breakdown;
      if (Array.isArray(savedLines)) for(const line of savedLines) {
        if(line && typeof line==="object") lines.push(line as unknown as BonusLine);
      }
      amount=usd(String(claim.amount));
      if (method === "standard" && lines.length === 0 && item.extraBales > 0 &&
          item.ratePerBale != null) {
        lines.push({category:"All categories", produced:item.producedBales,
          extra:item.extraBales, rate:new Decimal(item.ratePerBale).toFixed(4),bonus:amount});
      }
    } else if (weeklyFlat || weeklyClaims.has(item.workerId)) {
      issue="A weekly flat-bonus method/review already covers this worker";
    } else if (categoryClaims.has(item.workerId)) {
      issue="An older category-bonus review already exists; reconcile before paying";
    } else if (!item.targetConfigured || item.targetBales <= 0 ||
               !Number.isFinite(item.targetBales)) {
      issue="Save a positive Production Targets target first";
    } else if (item.extraBales <= 0) {
      issue="Target not exceeded";
    } else if (method==="standard") {
      if (!item.ratePerBale || item.ratePerBale <= 0) issue="Set the worker/company per-bale rate first";
      else {
        amount=usd(item.proposedAmount);
        lines.push({category:"All categories",produced:item.producedBales,
          extra:item.extraBales,rate:new Decimal(item.ratePerBale).toFixed(4),bonus:amount});
      }
    } else {
      if (!Number.isSafeInteger(item.extraBales)) {
        issue="Category bonus needs a whole number of extra bales; verify the daily target";
      }
      const counts = issue ? [] : await creditedCategories(tx,companyId,date,item.workerId,item.linkGroupId);
      const credited = counts.reduce((sum,c)=>sum+c.count,0);
      if (!issue && (credited !== item.producedBales || credited===0))
        issue="Bale category evidence does not match worker production; reconcile stock entry";
      else if (!issue) {
        // Divide excess bales proportionally across the actual categories made.
        // Stable largest-remainder allocation prevents double-counting one bale.
        const portions=splitExtraBalesByCategory(item.extraBales,counts);
        let total = new Decimal(0);
        for (const part of portions) {
          const normalized=normalizeBonusCategory(part.category)!;
          const rateRow=rows(await tx.execute(sql`
            SELECT enabled,rate_per_extra_bale::text AS rate
            FROM factory_production_target_bonus_category_rates
            WHERE company_id=${companyId} AND category_key=${normalized.key}
              AND effective_from <= ${date}::date
            ORDER BY effective_from DESC,id DESC LIMIT 1
          `))[0];
          if(!rateRow || rateRow.enabled !== true || Number(rateRow.rate)<=0) {
            issue="Set a positive category rate for "+part.category;
            break;
          }
          const rate=new Decimal(String(rateRow.rate));
          const partial=rate.times(part.extra);
          total=total.plus(partial);
          lines.push({category:part.category,produced:part.count,extra:part.extra,
            rate:rate.toFixed(4),bonus:usd(partial)});
        }
        if(!issue)amount=usd(total);
      }
    }
    const status: Offer["status"] = claim?.paymentStatus === "POSTED" ? "paid" :
      claim?.paymentStatus === "REVERSED" ? "reversed" :
      claim?.status === "rejected" ? "rejected" :
      issue ? "blocked" : claim ? "approved" :
      item.extraBales>0 && Number(amount)>0 ? "pending" : "blocked";
    const offerCore={date,workerId:item.workerId,workerName:item.workerName,
      target:item.targetBales,produced:item.producedBales,extra:item.extraBales,
      method,lines,amount};
    result.push({...offerCore,
      token:typeof claim?.calculationHash === "string" ? claim.calculationHash : hash(offerCore),
      status,issue});
  }
  return result;
}

export function registerProductionBonusCheckoutRoutes(app:Express):void {
  app.get("/api/factory/production-target-bonuses/checkout",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!allowed(req))return res.status(403).json({message:"Admin or Owner required"});
      const id=company(req),date=req.query.date,method=req.query.method;
      if(!id)return res.status(400).json({message:bonusServerText(req.headers["accept-language"],"checkoutCompany")});
      if(!targetBonusIsValidDate(date) || (method!=="standard" && method!=="category"))
        return res.status(400).json({message:bonusServerText(req.headers["accept-language"],"checkoutMethod")});
      try {
        const offers=await calculateOffers(db,id,date,method);
        res.setHeader("Cache-Control","private, no-store");
        return res.json({date,method,currency:"USD",offers});
      } catch(error) {
        logger.error("Bonus checkout preview failed",{error});
        return res.status(500).json({message:bonusServerText(req.headers["accept-language"],"checkoutFailed")});
      }
    });
  app.post("/api/factory/production-target-bonuses/checkout/pay",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!allowed(req))return res.status(403).json({message:"Admin or Owner required"});
      const id=company(req),method=req.body?.method;
      if(!id)return res.status(400).json({message:bonusServerText(req.headers["accept-language"],"checkoutCompany")});
      if(method!=="standard" && method!=="category")
        return res.status(400).json({message:"Choose standard or category per-bale bonus"});
      try {
        const command=parseTargetBonusPaymentCommand(req.body);
        const input=req.body.selections as Array<Record<string,unknown>>;
        if(input.some(row=>typeof row.token!=="string" || !/^[a-f0-9]{64}$/.test(row.token)))
          fail(400,"Refresh the bonus calculation before paying");
        if(command.selections.some(row=>row.date!==command.selections[0].date))
          fail(400,"Select one Production Targets date per payment");
        const result=await db.transaction(async tx=>{
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023,${id})`);
          const date=command.selections[0].date;
          const quotes=await calculateOffers(tx,id,date,method);
          for(const selection of command.selections) {
            const quote=quotes.find(q=>q.workerId===selection.workerId);
            const received=input.find(q=>Number(q.workerId)===selection.workerId&&q.date===date);
            if(!quote || !received || quote.token!==received.token ||
               quote.amount!==selection.expectedAmount ||
               (quote.status!=="pending" && quote.status!=="approved" &&
                !(quote.status==="paid" && quote.issue===null && quote.method===method)))
              fail(409,"Bonus amount or eligibility changed; refresh before paying");
            if(quote.status==="pending") {
              const rate=quote.extra>0 ?
                new Decimal(quote.amount).div(quote.extra).toDecimalPlaces(4,Decimal.ROUND_HALF_UP).toFixed(4) : "0.0000";
              const inserted=rows(await tx.execute(sql`
                INSERT INTO factory_target_bonus_reviews
                  (company_id,production_date,worker_id,target_bales,produced_bales,
                   extra_bales,rate_per_bale,bonus_amount,status,reviewed_by)
                VALUES (${id},${date}::date,${quote.workerId},${quote.target},${quote.produced},
                  ${quote.extra},${rate},${quote.amount},'approved',${actor(req).userId})
                ON CONFLICT (company_id,production_date,worker_id) DO NOTHING RETURNING id
              `));
              if(inserted.length!==1)fail(409,"Bonus was reviewed concurrently; refresh");
              await tx.execute(sql`
                INSERT INTO factory_target_bonus_checkout_details
                  (company_id,review_id,method,breakdown,calculation_hash,created_by)
                VALUES (${id},${Number(inserted[0].id)},${method},
                        ${JSON.stringify(quote.lines)}::jsonb,${quote.token},${actor(req).userId})
              `);
            }
          }
          return postTargetBonusPaymentsInTransaction(tx,id,command,actor(req));
        });
        res.setHeader("Cache-Control","private, no-store");
        return res.status(result.posted?201:200).json(result);
      }catch(error){
        const translated=translateDatabaseError(error);
        const status=translated ? translated.statusCode : errorStatus(error,
          typeof (error as {status?:unknown})?.status==="number"
            ? (error as {status:number}).status : 500);
        if(status===500)logger.error("Production bonus checkout payment failed",{error});
        return res.status(status).json({message:status===500?
          bonusServerText(req.headers["accept-language"],"paymentFailed"):
          translated?.message ?? (error instanceof Error?error.message:"Invalid bonus payment")});
      }
    });
}
