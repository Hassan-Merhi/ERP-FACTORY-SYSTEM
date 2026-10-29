import type { Express, Request, Response, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { errorStatus, getErrorMessage, translateDatabaseError } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { parseId } from "../../lib/parseId";
import { resultRows } from "../../lib/queryResult";
import { checkFactoryAdmin } from "../factory/_helpers";
import {
  postProductionTargetBonusPayment,
  reverseProductionTargetBonusPayment,
} from "../../services/payroll/productionTargetBonusPaymentService";

function factoryCompany(req: Request): number | null {
  const raw = req.session.factoryCompanyId || req.session.currentCompanyId;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function dateParam(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}
function handleError(res: Response, error: unknown) {
  const translated = translateDatabaseError(error);
  if (translated) return res.status(translated.statusCode).json({ message: translated.message });
  const status = errorStatus(error);
  if (status >= 500) logger.error("Production target bonus payment failed", { error });
  return res.status(status).json({ message: status >= 500 ? "Unable to process bonus payment" : getErrorMessage(error) });
}

/** Phase 5+6: read/review approved bonuses and post them independently of salary payroll. */
export function registerProductionTargetBonusPaymentRoutes(
  app: Express, requireAuth: RequestHandler,
): void {
  app.get("/api/factory/production-target-bonuses/payment-accounts", requireAuth, async (req: Request, res: Response) => {
    if (!checkFactoryAdmin(req, res)) return;
    const companyId = factoryCompany(req);
    if (!companyId) return res.status(400).json({ message: "Choose a company" });
    try {
      const result = await db.execute(sql`
        SELECT id, code, name, account_type AS "accountType"
        FROM ledger_accounts
        WHERE company_id = ${companyId} AND deleted_at IS NULL AND active = TRUE
          AND account_type IN ('Cash','Bank')
        ORDER BY account_type, name, id
      `);
      return res.json(resultRows(result));
    } catch (error) { return handleError(res, error); }
  });

  app.get("/api/factory/production-target-bonuses/payments", requireAuth, async (req: Request, res: Response) => {
    if (!checkFactoryAdmin(req, res)) return;
    const companyId = factoryCompany(req);
    if (!companyId) return res.status(400).json({ message: "Choose a company" });
    const startDate = dateParam(req.query.startDate);
    const endDate = dateParam(req.query.endDate);
    if (!startDate || !endDate || startDate > endDate) return res.status(400).json({ message: "Valid startDate and endDate are required" });
    try {
      const results = await db.execute(sql`
        SELECT a.id AS "allocationId", a.worker_id AS "workerId",
          a.worker_name_snapshot AS "workerName", a.amount::text AS amount,
          a.decision_status AS "decisionStatus", a.payroll_id AS "payrollId",
          r.production_date::text AS "productionDate", r.target_bales AS "targetBales",
          r.actual_bales AS "actualBales", r.extra_bales AS "extraBales",
          p.id AS "paymentId", p.status AS "paymentStatus",
          p.payment_date::text AS "paymentDate", p.cash_ledger_account_id AS "cashAccountId",
          p.voucher_id AS "voucherId", p.reversal_voucher_id AS "reversalVoucherId",
          EXISTS (
            SELECT 1 FROM factory_staff_tracking_period_closures c
            WHERE c.company_id = ${companyId} AND c.page_type = 'production'
              AND c.period_type = 'daily' AND c.period_start = r.production_date
              AND c.period_end = r.production_date
          ) AS finalized,
          (SELECT COUNT(*)::integer FROM factory_payrolls fp
           WHERE fp.company_id = ${companyId} AND fp.worker_id = a.worker_id
             AND r.production_date BETWEEN fp.period_start AND fp.period_end
             AND fp.status IN ('APPROVED','PAID')) AS "relatedFinalPayrollCount"
        FROM factory_production_bonus_allocations a
        JOIN factory_production_bonus_runs r ON r.id = a.run_id AND r.company_id = a.company_id
        LEFT JOIN factory_production_target_bonus_payments p
          ON p.allocation_id = a.id AND p.company_id = a.company_id
        WHERE a.company_id = ${companyId}
          AND r.production_date BETWEEN ${startDate}::date AND ${endDate}::date
        ORDER BY r.production_date DESC, a.worker_name_snapshot, a.id
      `);
      return res.json(resultRows(results));
    } catch (error) { return handleError(res, error); }
  });

  app.post("/api/factory/production-target-bonuses/payments", requireAuth, async (req: Request, res: Response) => {
    if (!checkFactoryAdmin(req, res)) return;
    const companyId = factoryCompany(req);
    if (!companyId) return res.status(400).json({ message: "Choose a company" });
    if (req.body?.confirm !== true) return res.status(400).json({ message: "Review and confirm the bonus payment before posting" });
    const allocationId = parseId(req.body?.allocationId);
    const cashAccountId = parseId(req.body?.cashAccountId);
    if (allocationId === null || cashAccountId === null) return res.status(400).json({ message: "Select an allocation and paying account" });
    try {
      const result = await postProductionTargetBonusPayment({
        companyId, allocationId, cashAccountId,
        paymentDate: String(req.body?.paymentDate ?? ""),
        currency: String(req.body?.currency ?? "USD").toUpperCase(),
        actorId: String(req.session.userId || "unknown"),
        actorName: String(req.session.username || req.session.userId || "unknown"),
      });
      if (result.replayed) res.setHeader("X-Idempotent-Replay", "true");
      return res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) { return handleError(res, error); }
  });

  app.post("/api/factory/production-target-bonuses/payments/:id/reverse", requireAuth, async (req: Request, res: Response) => {
    if (!checkFactoryAdmin(req, res)) return;
    const companyId = factoryCompany(req);
    if (!companyId) return res.status(400).json({ message: "Choose a company" });
    if (req.body?.confirm !== true) return res.status(400).json({ message: "Review and confirm the reversal before posting" });
    const paymentId = parseId(req.params.id);
    if (paymentId === null) return res.status(400).json({ message: "Invalid bonus payment ID" });
    try {
      const result = await reverseProductionTargetBonusPayment({
        companyId, paymentId,
        reason: String(req.body?.reason ?? ""),
        reversalDate: String(req.body?.reversalDate ?? ""),
        actorId: String(req.session.userId || "unknown"),
        actorName: String(req.session.username || req.session.userId || "unknown"),
      });
      if (result.replayed) res.setHeader("X-Idempotent-Replay", "true");
      return res.json(result);
    } catch (error) { return handleError(res, error); }
  });
}
