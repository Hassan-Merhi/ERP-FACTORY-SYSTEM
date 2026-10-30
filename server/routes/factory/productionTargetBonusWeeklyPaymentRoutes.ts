import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { errorStatus, getErrorMessage, translateDatabaseError } from "../../lib/httpHandlers";
import { isRealBonusDate, TargetBonusPaymentPolicyError } from "../../services/factory/targetBonusPaymentPolicy";
import { parseWeeklyBonusPaymentCommand } from "../../services/factory/weeklyBonusPaymentPolicy";
import { postWeeklyBonusPayments, reverseWeeklyBonusPayment } from "../../services/factory/weeklyBonusPaymentService";

const guard = requireFactoryTabAccess("factory/stock-entry", "hide_tab_stockentry_production_targets");
const authorized = (req: Request) =>
  ["Admin", "Owner"].includes(String(req.session.currentRole || req.user?.role || ""));
const companyFor = (req: Request): number | null => {
  const companyId = Number(req.session.factoryCompanyId || req.session.currentCompanyId);
  return Number.isSafeInteger(companyId) && companyId > 0 ? companyId : null;
};
const actor = (req: Request) => ({
  userId: String(req.session.userId || ""),
  username: String(req.session.username || req.session.userId || ""),
});
function safeError(res: Response, error: unknown) {
  if (error instanceof TargetBonusPaymentPolicyError)
    return res.status(error.status).json({message:error.message});
  const database = translateDatabaseError(error);
  if (database) return res.status(database.statusCode).json({message: database.message});
  const status = errorStatus(error);
  if (status >= 500) logger.error("Weekly Production Targets payment failure", {error});
  return res.status(status).json({
    message: status >= 500 ? "Unable to complete weekly bonus payment" : getErrorMessage(error),
  });
}
function rangeQuery(req: Request): {start:string;end:string} | null {
  const start = req.query.start, end = req.query.end;
  if (!isRealBonusDate(start) || !isRealBonusDate(end) || start > end ||
      (Date.parse(end) - Date.parse(start)) / 86400000 > 366) return null;
  return {start,end};
}

/** Financial endpoints remain fully separate from immutable review decisions. */
export function registerProductionTargetBonusWeeklyPaymentRoutes(app: Express): void {
  app.get("/api/factory/production-target-bonuses/weekly-payments",
    requireAuth, guard, async(req:Request,res:Response)=>{
      if(!authorized(req))return res.status(403).json({message:"Admin or Owner required"});
      const companyId=companyFor(req);
      if(!companyId)return res.status(400).json({message:"Factory company required"});
      const query=rangeQuery(req);
      if(!query)return res.status(400).json({message:"Select up to 366 valid calendar days"});
      try{
        const result=await db.execute(sql`
          SELECT rv.id AS "reviewId", rv.week_start::text AS "weekStart",
            rv.week_end::text AS "weekEnd", rv.worker_id AS "workerId",
            rv.worker_name_snapshot AS "workerName",
            rv.target_bales::text AS "targetBales", rv.credited_bales AS "creditedBales",
            rv.extra_bales::text AS "extraBales", rv.bonus_amount::text AS "approvedAmount",
            rv.method_version_id AS "methodVersionId", rv.status AS "decisionStatus",
            rv.snapshot_hash AS "snapshotHash", rv.snapshot_json AS snapshot, rv.reviewed_at::text AS "reviewedAt",
            rv.reviewed_by AS "reviewedBy",
            p.id AS "paymentId", p.status AS "paymentStatus",
            p.payment_date::text AS "paymentDate",
            p.cash_ledger_account_id AS "cashAccountId",
            a.name AS "cashAccountName", p.payment_voucher_id AS "voucherId",
            p.reversal_voucher_id AS "reversalVoucherId",
            p.posted_at::text AS "postedAt", p.posted_by AS "postedBy"
          FROM factory_target_bonus_weekly_reviews rv
          JOIN factory_workers w ON w.id=rv.worker_id AND w.company_id=rv.company_id
          LEFT JOIN factory_target_bonus_weekly_payments p
            ON p.company_id=rv.company_id AND p.review_id=rv.id
          LEFT JOIN ledger_accounts a ON a.id=p.cash_ledger_account_id AND a.company_id=rv.company_id
          WHERE rv.company_id=${companyId}
            AND rv.week_start BETWEEN ${query.start}::date AND ${query.end}::date
          ORDER BY rv.week_start DESC, rv.worker_name_snapshot, rv.worker_id
          LIMIT 20000
        `);
        res.setHeader("Cache-Control","private, no-store");
        return res.json({
          start:query.start,end:query.end,currency:"USD",
          payments:resultRows(result),paymentClassification:"Payroll Deposit Expense",
        });
      }catch(error){return safeError(res,error);}
    },
  );
  app.post("/api/factory/production-target-bonuses/weekly-payments/post",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!authorized(req))return res.status(403).json({message:"Admin or Owner required"});
      const companyId=companyFor(req);
      if(!companyId)return res.status(400).json({message:"Factory company required"});
      try{
        const command=parseWeeklyBonusPaymentCommand(req.body);
        const result=await postWeeklyBonusPayments(companyId,command,actor(req));
        if(result.posted===0)res.setHeader("X-Idempotent-Replay","true");
        return res.status(result.posted?201:200).json(result);
      }catch(error){return safeError(res,error);}
    },
  );
  app.post("/api/factory/production-target-bonuses/weekly-payments/:id/reverse",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!authorized(req))return res.status(403).json({message:"Admin or Owner required"});
      const companyId=companyFor(req);
      if(!companyId)return res.status(400).json({message:"Factory company required"});
      const paymentId=Number(req.params.id);
      if(!Number.isSafeInteger(paymentId)||paymentId<=0)
        return res.status(400).json({message:"Invalid weekly payment ID"});
      if(req.body?.confirm!==true)
        return res.status(400).json({message:"Review and confirm reversal"});
      try{
        const result=await reverseWeeklyBonusPayment(
          companyId,paymentId,String(req.body?.reversalDate || ""),
          String(req.body?.reason || ""),actor(req),
        );
        if(result.replayed)res.setHeader("X-Idempotent-Replay","true");
        return res.json(result);
      }catch(error){return safeError(res,error);}
    },
  );
}
