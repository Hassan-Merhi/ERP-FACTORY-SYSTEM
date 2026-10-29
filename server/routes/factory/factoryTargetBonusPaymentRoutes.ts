import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { errorStatus, getErrorMessage, translateDatabaseError } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import {
  isRealBonusDate,
  parseTargetBonusPaymentCommand,
  TargetBonusPaymentPolicyError,
} from "../../services/factory/targetBonusPaymentPolicy";
import {
  postTargetBonusPayments,
  reverseTargetBonusPayment,
} from "../../services/factory/targetBonusPaymentService";

const requireProductionTargets = requireFactoryTabAccess(
  "factory/stock-entry", "hide_tab_stockentry_production_targets"
);
function company(req: Request): number | null {
  const id = Number(req.session.factoryCompanyId || req.session.currentCompanyId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function canPost(req: Request): boolean {
  return ["Admin", "Owner"].includes(String(req.session.currentRole || req.user?.role || ""));
}
function actor(req: Request) {
  return {
    userId: String(req.session.userId || ""),
    username: String(req.session.username || req.session.userId || ""),
  };
}
function respondError(res: Response, error: unknown) {
  if (error instanceof TargetBonusPaymentPolicyError)
    return res.status(error.status).json({ message: error.message });
  const translated = translateDatabaseError(error);
  if (translated) return res.status(translated.statusCode).json({ message: translated.message });
  const status = errorStatus(error);
  if (status >= 500) logger.error("Production Targets bonus payment failed", { error });
  return res.status(status).json({
    message: status >= 500 ? "Unable to complete production bonus payment" : getErrorMessage(error),
  });
}

/** Separate from legacy position-based payroll bonus: these are Phase 4 reviewed worker/date snapshots. */
export function registerFactoryTargetBonusPaymentRoutes(app: Express): void {
  app.get(
    "/api/factory/staff-tracking/production-bonuses/payment-accounts",
    requireAuth, requireProductionTargets,
    async (req: Request, res: Response) => {
      if (!canPost(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = company(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      try {
        const accounts = await db.execute(sql`
          SELECT id, code, name, account_type AS "accountType",
                 opening_balance_currency AS "openingCurrency"
          FROM ledger_accounts
          WHERE company_id = ${companyId} AND deleted_at IS NULL AND active = TRUE
            AND account_type IN ('Cash','Bank')
          ORDER BY account_type, name, id
        `);
        return res.json({ accounts: resultRows(accounts), currency: "USD" });
      } catch (error) { return respondError(res, error); }
    },
  );

  app.get(
    "/api/factory/staff-tracking/production-bonuses/payments",
    requireAuth, requireProductionTargets,
    async (req: Request, res: Response) => {
      if (!canPost(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = company(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      const start = req.query.start;
      const end = req.query.end;
      if (!isRealBonusDate(start) || !isRealBonusDate(end) || start > end ||
          (Date.parse(end) - Date.parse(start)) / 86400000 > 366)
        return res.status(400).json({ message: "Choose a valid date range of up to one year" });
      try {
        const result = await db.execute(sql`
          SELECT rv.id AS "reviewId", rv.production_date::text AS date,
                 rv.worker_id AS "workerId", w.full_name AS "workerName",
                 rv.status AS "decisionStatus", rv.bonus_amount::text AS "approvedAmount",
                 p.id AS "paymentId", p.status AS "paymentStatus",
                 p.bonus_amount::text AS "paidAmount", p.payment_date::text AS "paymentDate",
                 p.cash_ledger_account_id AS "cashAccountId", a.name AS "cashAccountName",
                 p.currency_code AS currency, p.payment_voucher_id AS "voucherId",
                 p.reversal_voucher_id AS "reversalVoucherId",
                 p.posted_at::text AS "postedAt", p.posted_by AS "postedBy"
          FROM factory_target_bonus_reviews rv
          JOIN factory_workers w ON w.id = rv.worker_id AND w.company_id = rv.company_id
          LEFT JOIN factory_target_bonus_payments p
            ON p.review_id = rv.id AND p.company_id = rv.company_id
          LEFT JOIN ledger_accounts a ON a.id = p.cash_ledger_account_id
          WHERE rv.company_id = ${companyId}
            AND rv.production_date BETWEEN ${start}::date AND ${end}::date
          ORDER BY rv.production_date DESC, w.full_name, rv.worker_id
          LIMIT 20000
        `);
        return res.json({ start, end, payments: resultRows(result) });
      } catch (error) { return respondError(res, error); }
    },
  );

  app.post(
    "/api/factory/staff-tracking/production-bonuses/pay",
    requireAuth, requireProductionTargets,
    async (req: Request, res: Response) => {
      if (!canPost(req)) return res.status(403).json({ message: "Admin or Owner approval required" });
      const companyId = company(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      try {
        const command = parseTargetBonusPaymentCommand(req.body);
        const result = await postTargetBonusPayments(companyId, command, actor(req));
        if (result.posted === 0) res.setHeader("X-Idempotent-Replay", "true");
        return res.status(result.posted === 0 ? 200 : 201).json(result);
      } catch (error) { return respondError(res, error); }
    },
  );

  app.post(
    "/api/factory/staff-tracking/production-bonuses/payments/:id/reverse",
    requireAuth, requireProductionTargets,
    async (req: Request, res: Response) => {
      if (!canPost(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = company(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      const paymentId = Number(req.params.id);
      if (!Number.isSafeInteger(paymentId) || paymentId <= 0)
        return res.status(400).json({ message: "Invalid payment ID" });
      if (req.body?.confirm !== true)
        return res.status(400).json({ message: "Review and confirm the reversal" });
      try {
        const result = await reverseTargetBonusPayment(
          companyId, paymentId, String(req.body?.reversalDate || ""),
          String(req.body?.reason || ""), actor(req),
        );
        if (result.replayed) res.setHeader("X-Idempotent-Replay", "true");
        return res.json(result);
      } catch (error) { return respondError(res, error); }
    },
  );
}
