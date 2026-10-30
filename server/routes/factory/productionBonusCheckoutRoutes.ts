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
import { loadTargetBonusRows, targetBonusValidRange } from "../../services/factory/targetBonusReview";
import { postTargetBonusPaymentsInTransaction } from "../../services/factory/targetBonusPaymentService";
import { parseTargetBonusPaymentCommand } from "../../services/factory/targetBonusPaymentPolicy";
import { normalizeBonusCategory } from "@shared/productionTargetBonusCategoryRates";
import { splitExtraBalesByCategory, workerCategoryCredits } from "@shared/productionBonusCheckoutMath";
import { latestUnpaidWorkerRate, rateChangeMayRepriceReview } from "@shared/productionBonusUnpaidRatePolicy";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";

const guard = requireFactoryTabAccess("factory/stock-entry", "hide_tab_stockentry_production_targets");
type Method = "standard" | "category";
type BonusLine = { category: string; produced: number; extra: number; rate: string; bonus: string };
type Offer = {
  date: string; workerId: number; workerName: string; target: number; produced: number;
  extra: number; method: Method; lines: BonusLine[]; amount: string; token: string;
  status: "pending" | "approved" | "paid" | "reversed" | "no_bonus" | "needs_setup" | "blocked" | "rejected" | "weekly";
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
  tx: DatabaseOrTransaction, companyId: number, from: string, to: string, method: Method,
): Promise<Offer[]> {
  // One range read for closed and open days; each worker/day remains an individual
  // frozen accounting entitlement even when displayed as a range total.
  const [daily, claimsResult, methodsResult, weeklyReviewsResult, categoryReviewsResult, standardRatesResult] = await Promise.all([
    loadTargetBonusRows(tx, companyId, from, to),
    tx.execute(sql`
      SELECT rv.production_date::text AS date, rv.worker_id AS "workerId",
        rv.status, rv.bonus_amount::text AS amount,
        rv.rate_per_bale::text AS "ratePerBale",
        p.status AS "paymentStatus", details.method AS "checkoutMethod",
        details.breakdown AS breakdown, details.calculation_hash AS "calculationHash"
      FROM factory_target_bonus_reviews rv
      LEFT JOIN factory_target_bonus_payments p
        ON p.company_id=rv.company_id AND p.review_id=rv.id
      LEFT JOIN factory_target_bonus_checkout_details details
        ON details.company_id=rv.company_id AND details.review_id=rv.id
      WHERE rv.company_id=${companyId}
        AND rv.production_date BETWEEN ${from}::date AND ${to}::date
    `),
    tx.execute(sql`
      SELECT effective_week::text AS week, method
      FROM factory_production_target_bonus_weekly_methods
      WHERE company_id=${companyId} AND effective_week<=${to}::date
      ORDER BY effective_week DESC,id DESC
    `),
    tx.execute(sql`
      SELECT worker_id AS id, week_start::text AS start, week_end::text AS "end"
      FROM factory_target_bonus_weekly_reviews
      WHERE company_id=${companyId}
        AND week_start<=${to}::date AND week_end>=${from}::date
    `),
    tx.execute(sql`
      SELECT worker_id AS id, production_date::text AS date
      FROM factory_target_bonus_category_reviews
      WHERE company_id=${companyId}
        AND production_date BETWEEN ${from}::date AND ${to}::date
    `),
    // The most recently SAVED rate applies to all unpaid worker-days, even
    // older weeks. Do not filter by production_date: that was the original bug.
    tx.execute(sql`
      SELECT DISTINCT ON (scope,worker_id)
        scope,worker_id AS "workerId",enabled,
        rate_per_extra_bale::text AS rate
      FROM factory_production_target_bonus_rates
      WHERE company_id=${companyId}
      ORDER BY scope,worker_id,id DESC
    `),
  ]);
  const claimsByDay = new Map(rows(claimsResult).map(row => [String(row.date).slice(0,10)+":"+Number(row.workerId),row]));
  const weeklyMethods=rows(methodsResult);
  const weeklyReviews=rows(weeklyReviewsResult);
  const categoryClaims=new Set(rows(categoryReviewsResult).map(row=>String(row.date).slice(0,10)+":"+Number(row.id)));
  const activeStandardRates=rows(standardRatesResult);
  const rateForWorker=(workerId:number)=>{
    const rate=latestUnpaidWorkerRate(activeStandardRates,workerId);
    return rate===null?null:new Decimal(rate);
  };
  const categoryRates=new Map<string,Decimal|null>();
  const rateForCategory=async(key:string)=>{
    if(categoryRates.has(key))return categoryRates.get(key)!;
    const version=rows(await tx.execute(sql`
      SELECT enabled,rate_per_extra_bale::text AS rate
      FROM factory_production_target_bonus_category_rates
      WHERE company_id=${companyId} AND category_key=${key}
      ORDER BY id DESC LIMIT 1
    `))[0];
    const rate=version?.enabled===true&&Number(version.rate)>0
      ? new Decimal(String(version.rate)):null;
    categoryRates.set(key,rate);
    return rate;
  };
  const result: Offer[] = [];
  for(const item of daily) {
    const date=item.date;
    const key=date+":"+item.workerId;
    const claim=claimsByDay.get(key);
    const weekStart=mondayOfProductionBonusWeek(date)!;
    const weeklyFlat=weeklyMethods.find(row=>String(row.week).slice(0,10)<=weekStart)?.method==="weekly_flat";
    const weeklyClaim=weeklyReviews.some(row=>Number(row.id)===item.workerId &&
      String(row.start).slice(0,10)<=date && String(row.end).slice(0,10)>=date);
    const lines: BonusLine[] = [];
    let issue: string | null = null;
    let handledByWeekly = false;
    let amount = "0.00";
    if (claim) {
      if (claim.checkoutMethod && claim.checkoutMethod !== method) issue="Already reviewed using another bonus method";
      if (!claim.checkoutMethod && method === "category") issue="Already reviewed with standard per-bale bonus";
      const savedLines=claim.breakdown;
      if (Array.isArray(savedLines)) for(const line of savedLines) {
        if(line && typeof line==="object") lines.push(line as unknown as BonusLine);
      }
      amount=usd(String(claim.amount));
      if (!rateChangeMayRepriceReview(claim.status,claim.paymentStatus)) {
        // Once a payment claim exists, neither reversal nor later edits can
        // rewrite its originally reviewed amount and category breakdown.
        if(method==="standard" && lines.length===0 && item.extraBales>0)
          lines.push({category:"All categories",produced:item.producedBales,extra:item.extraBales,
            rate:new Decimal(String(claim.ratePerBale??item.ratePerBale??0)).toFixed(4),bonus:amount});
      } else if(!issue && method==="standard") {
        const rate=rateForWorker(item.workerId);
        if(!rate)issue="Set the worker/company per-bale rate first";
        else {
          amount=usd(rate.times(item.extraBales));
          lines.splice(0,lines.length,{category:"All categories",produced:item.producedBales,
            extra:item.extraBales,rate:rate.toFixed(4),bonus:amount});
        }
      } else if(!issue && method==="category") {
        if(!lines.length)issue="Missing approved category breakdown; reconcile before paying";
        else {
          let total=new Decimal(0);
          const priced: BonusLine[]=[];
          for(const line of lines) {
            if(!Number.isSafeInteger(line.extra)||line.extra<0){issue="Invalid approved category breakdown";break;}
            if(line.extra===0){priced.push({...line,rate:"0.0000",bonus:"0.00"});continue;}
            const category=normalizeBonusCategory(line.category);
            const rate=category?await rateForCategory(category.key):null;
            if(!rate){issue="Set a positive category rate for "+line.category;break;}
            const subtotal=usd(rate.times(line.extra));
            total=total.plus(subtotal);
            priced.push({...line,rate:rate.toFixed(4),bonus:subtotal});
          }
          if(!issue){amount=usd(total);lines.splice(0,lines.length,...priced);}
        }
      }
    } else if (weeklyFlat || weeklyClaim) {
      // Weekly-flat is a separate payment workflow, not missing production
      // evidence. Keep this day non-payable without presenting a false warning.
      handledByWeekly=true;
      issue=weeklyClaim
        ? "Already covered by a weekly bonus review"
        : "This week uses the weekly flat bonus; pay through Weekly Bonus Payroll";
    } else if (categoryClaims.has(key)) {
      issue="An older category-bonus review already exists; reconcile before paying";
    } else if (!item.targetConfigured || item.targetBales <= 0 ||
               !Number.isFinite(item.targetBales)) {
      // Zero production with no target is not a payable claim and not a
      // configuration error needing a warning for that day.
      issue=item.producedBales>0
        ? "Save a positive Production Targets target first" : "Target not exceeded";
    } else if (item.extraBales <= 0) {
      issue="Target not exceeded";
    } else if (method==="standard") {
      const rate=rateForWorker(item.workerId);
      if(!rate)issue="Set the worker/company per-bale rate first";
      else {
        amount=usd(rate.times(item.extraBales));
        lines.push({category:"All categories",produced:item.producedBales,
          extra:item.extraBales,rate:rate.toFixed(4),bonus:amount});
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
          // Categories with no extra bales remain visible but add no charge.
          if (part.extra === 0) {
            lines.push({category:part.category,produced:part.count,extra:0,
              rate:"0.0000",bonus:"0.00"});
            continue;
          }
          const normalized=normalizeBonusCategory(part.category)!;
          const rate=await rateForCategory(normalized.key);
          if(!rate) {
            issue="Set a positive category rate for "+part.category;
            break;
          }
          const partial=usd(rate.times(part.extra));
          // Line-level cent rounding ensures the displayed category subtotals
          // add up exactly to the worker's posted accounting amount.
          total=total.plus(new Decimal(partial));
          lines.push({category:part.category,produced:part.count,extra:part.extra,
            rate:rate.toFixed(4),bonus:partial});
        }
        if(!issue)amount=usd(total);
      }
    }
    const status: Offer["status"] = claim?.paymentStatus === "POSTED" ? "paid" :
      claim?.paymentStatus === "REVERSED" ? "reversed" :
      claim?.status === "rejected" ? "rejected" :
      handledByWeekly ? "weekly" :
      issue === "Target not exceeded" || (item.targetBales <= 0 && item.producedBales === 0 && !claim)
        ? "no_bonus" :
      issue?.startsWith("Save a positive") || issue?.startsWith("Set the worker") ||
      issue?.startsWith("Set a positive category") ? "needs_setup" :
      issue ? "blocked" : claim ? "approved" :
      item.extraBales>0 && Number(amount)>0 ? "pending" : "no_bonus";
    const offerCore={date,workerId:item.workerId,workerName:item.workerName,
      target:item.targetBales,produced:item.producedBales,extra:item.extraBales,
      method,lines,amount};
    result.push({...offerCore,
      token:claim?.paymentStatus && typeof claim.calculationHash==="string"
        ? claim.calculationHash : hash(offerCore),
      status,issue});
  }
  return result;
}

export function registerProductionBonusCheckoutRoutes(app:Express):void {
  app.get("/api/factory/production-target-bonuses/checkout",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!allowed(req))return res.status(403).json({message:bonusServerText(req.headers["accept-language"],"adminOnly")});
      const id=company(req),from=req.query.from??req.query.date,to=req.query.to??req.query.date,method=req.query.method;
      if(!id)return res.status(400).json({message:bonusServerText(req.headers["accept-language"],"checkoutCompany")});
      if(!targetBonusValidRange(from,to) || (method!=="standard" && method!=="category"))
        return res.status(400).json({message:bonusServerText(req.headers["accept-language"],"checkoutMethod")});
      try {
        const offers=await calculateOffers(db,id,from,to,method);
        res.setHeader("Cache-Control","private, no-store");
        return res.json({from,to,method,currency:"USD",offers});
      } catch(error) {
        logger.error("Bonus checkout preview failed",{error});
        return res.status(500).json({message:bonusServerText(req.headers["accept-language"],"checkoutFailed")});
      }
    });
  app.post("/api/factory/production-target-bonuses/checkout/pay",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!allowed(req))return res.status(403).json({message:bonusServerText(req.headers["accept-language"],"adminOnly")});
      const id=company(req),method=req.body?.method;
      if(!id)return res.status(400).json({message:bonusServerText(req.headers["accept-language"],"checkoutCompany")});
      if(method!=="standard" && method!=="category")
        return res.status(400).json({message:bonusServerText(req.headers["accept-language"],"chooseBonusMethod")});
      try {
        const command=parseTargetBonusPaymentCommand(req.body);
        const input=req.body.selections as Array<Record<string,unknown>>;
        if(input.some(row=>typeof row.token!=="string" || !/^[a-f0-9]{64}$/.test(row.token)))
          fail(400,"Refresh the bonus calculation before paying");
        const firstDate=command.selections[0].date;
        const lastDate=command.selections[command.selections.length-1].date;
        if(!targetBonusValidRange(firstDate,lastDate))
          fail(400,"Select production dates within a 32-day window");
        const result=await db.transaction(async tx=>{
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023,${id})`);
          const quotes=await calculateOffers(tx,id,firstDate,lastDate,method);
          const quotedByDay=new Map(quotes.map(quote=>[quote.date+":"+quote.workerId,quote]));
          for(const selection of command.selections) {
            const date=selection.date;
            const quote=quotedByDay.get(date+":"+selection.workerId);
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
            } else if (quote.status==="approved") {
              // The payment has not been posted. Reprice only in the SAME
              // atomic approval/payment transaction; save the old reviewed
              // amount to an append-only audit table before changing it.
              const original=rows(await tx.execute(sql`
                SELECT rv.id,rv.bonus_amount::text AS amount,
                  rv.rate_per_bale::text AS rate,
                  details.breakdown AS breakdown
                FROM factory_target_bonus_reviews rv
                LEFT JOIN factory_target_bonus_checkout_details details
                  ON details.company_id=rv.company_id AND details.review_id=rv.id
                WHERE rv.company_id=${id} AND rv.production_date=${date}::date
                  AND rv.worker_id=${quote.workerId} AND rv.status='approved'
                  AND NOT EXISTS (
                    SELECT 1 FROM factory_target_bonus_payments p
                    WHERE p.company_id=rv.company_id AND p.review_id=rv.id
                  )
                FOR UPDATE OF rv
              `))[0];
              if(!original)fail(409,"Previously approved bonus was paid or changed; refresh");
              const oldAmount=usd(String(original.amount));
              const oldLines=Array.isArray(original.breakdown)?original.breakdown:null;
              const newLines=JSON.stringify(quote.lines);
              const oldLinesJson=oldLines===null?null:JSON.stringify(oldLines);
              const repricedRate=quote.extra>0 ?
                new Decimal(quote.amount).div(quote.extra)
                  .toDecimalPlaces(4,Decimal.ROUND_HALF_UP).toFixed(4):"0.0000";
              if(oldAmount!==quote.amount ||
                 (oldLinesJson!==null && oldLinesJson!==newLines)) {
                await tx.execute(sql`
                  INSERT INTO factory_target_bonus_unpaid_rate_revisions
                    (company_id,review_id,worker_id,production_date,method,
                     old_amount,new_amount,old_rate,new_rate,old_breakdown,
                     new_breakdown,repriced_by)
                  VALUES (${id},${Number(original.id)},${quote.workerId},
                    ${date}::date,${method},${oldAmount},${quote.amount},
                    ${String(original.rate)},${repricedRate},
                    ${oldLinesJson}::jsonb,${newLines}::jsonb,${actor(req).userId})
                `);
                await tx.execute(sql`
                  UPDATE factory_target_bonus_reviews
                  SET bonus_amount=${quote.amount}::numeric,rate_per_bale=${repricedRate}::numeric
                  WHERE id=${Number(original.id)} AND company_id=${id}
                `);
              }
              await tx.execute(sql`
                INSERT INTO factory_target_bonus_checkout_details
                  (company_id,review_id,method,breakdown,calculation_hash,created_by)
                VALUES (${id},${Number(original.id)},${method},
                  ${newLines}::jsonb,${quote.token},${actor(req).userId})
                ON CONFLICT (company_id,review_id) DO UPDATE
                  SET breakdown=EXCLUDED.breakdown,calculation_hash=EXCLUDED.calculation_hash
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
          translated?.message ?? (error instanceof Error?error.message:bonusServerText(req.headers["accept-language"],"invalidBonusPayment"))});
      }
    });
}
