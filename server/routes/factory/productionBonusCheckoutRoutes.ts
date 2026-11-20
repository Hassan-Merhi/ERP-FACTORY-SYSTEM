/**
 * Single Payroll-style Production Targets bonus checkout.
 * One company transaction freezes the calculation, approves it, posts the
 * voucher and creates the linked Daybook entry. No manual category target
 * allocation and no End Production prerequisite.
 */
import type { Express, Request, Response } from "express";
import { bonusServerText } from "../../i18n/productionBonusCheckoutMessages";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { logger } from "../../lib/logger";
import { errorStatus, translateDatabaseError } from "../../lib/httpHandlers";
import { targetBonusValidRange } from "../../services/factory/targetBonusReview";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import {
  parseManualBonusCommand,
  postManualProductionBonuses,
  reverseManualProductionBonus,
} from "../../services/factory/manualProductionBonusPaymentService";
import { isRealBonusDate } from "../../services/factory/targetBonusPaymentPolicy";
import { actor, allowed, company, guard, rows } from "./productionBonusCheckoutRoutesCreditedCategories";
import { calculateOffers } from "./productionBonusCheckoutRoutesCalculateOffers";
import { registerProductionBonusCheckoutRoutesPart1 } from "./registerProductionBonusCheckoutRoutesPart1";
import { z } from "zod";
import {
  emptyQuery,
  positiveIntParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";

// parseManualBonusCommand and the handlers keep
// their own checks and messages; these schemas fix the shape the Production
// Targets bonus panels send.
const amountLike = z.union([z.number(), z.string()]);
const paymentCommandFields = {
  confirm: z.boolean().optional(),
  currency: z.string().nullable().optional(),
  paymentDate: z.string().optional(),
  cashAccountId: z.number().optional(),
};
const manualPayInput = {
  query: emptyQuery,
  body: z.strictObject({
    ...paymentCommandFields,
    weekStart: z.string().optional(),
    rosterDate: z.string().optional(),
    requestKey: z.string().optional(),
    selections: z.array(z.strictObject({ workerId: z.number(), amount: amountLike })).optional(),
  }),
} satisfies RequestSchemas;
const manualReverseInput = {
  params: z.strictObject({ paymentId: positiveIntParam }),
  query: emptyQuery,
  body: z.strictObject({
    confirm: z.boolean().optional(),
    reversalDate: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

export function registerProductionBonusCheckoutRoutes(app: Express): void {
  // Manually entered payments are separate from calculated daily/weekly awards.
  // They are voucher-backed, company-scoped, audited and reversibly posted.
  app.get(
    "/api/factory/production-target-bonuses/checkout/manual-payments",
    requireAuth,
    guard,
    async (req: Request, res: Response) => {
      if (!allowed(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const id = company(req),
        weekStart = req.query.weekStart;
      if (!id) return res.status(400).json({ message: "Factory company required" });
      if (!isRealBonusDate(weekStart) || mondayOfProductionBonusWeek(weekStart) !== weekStart)
        return res.status(400).json({ message: "Valid Monday week start required" });
      try {
        const result = await db.execute(sql`
          SELECT p.id,p.worker_id AS "workerId",w.full_name AS "workerName",
            p.amount_usd::text AS amount,p.week_start::text AS "weekStart",
            p.payment_date::text AS "paymentDate",p.status,
            p.payment_voucher_id AS "voucherId",p.reversal_voucher_id AS "reversalVoucherId",
            a.name AS "cashAccountName",p.posted_at::text AS "postedAt"
          FROM factory_target_bonus_manual_payments p
          JOIN factory_workers w ON w.id=p.worker_id AND w.company_id=p.company_id
          JOIN ledger_accounts a ON a.id=p.cash_ledger_account_id AND a.company_id=p.company_id
          WHERE p.company_id=${id} AND p.week_start=${weekStart}::date
          ORDER BY p.id DESC LIMIT 500
        `);
        res.setHeader("Cache-Control", "private, no-store");
        return res.json({ payments: rows(result) });
      } catch (error) {
        logger.error("Manual production bonuses history unavailable", { error });
        return res.status(500).json({ message: "Could not load manual bonus payments" });
      }
    }
  );
  app.post(
    "/api/factory/production-target-bonuses/checkout/manual-pay",
    requireAuth,
    guard,
    validateRequest(manualPayInput),
    async (req: Request, res: Response) => {
      if (!allowed(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const id = company(req);
      if (!id) return res.status(400).json({ message: "Factory company required" });
      try {
        const command = parseManualBonusCommand(req.body);
        const result = await postManualProductionBonuses(id, command, actor(req));
        res.setHeader("Cache-Control", "private, no-store");
        if (result.posted === 0) res.setHeader("X-Idempotent-Replay", "true");
        return res.status(result.posted ? 201 : 200).json(result);
      } catch (error) {
        const translated = translateDatabaseError(error);
        const status =
          translated?.statusCode ??
          errorStatus(
            error,
            typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500
          );
        if (status >= 500) logger.error("Manual production bonus payout failed", { error });
        return res.status(status).json({
          message:
            status >= 500
              ? "Manual payment could not be posted"
              : (translated?.message ?? (error instanceof Error ? error.message : "Invalid manual bonus payment")),
        });
      }
    }
  );
  app.post(
    "/api/factory/production-target-bonuses/checkout/manual-payments/:paymentId/reverse",
    requireAuth,
    guard,
    validateRequest(manualReverseInput),
    async (req: Request, res: Response) => {
      if (!allowed(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const id = company(req),
        { paymentId } = validatedInput(req, manualReverseInput).params;
      if (!id) return res.status(400).json({ message: "Factory company required" });
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirm a valid manual bonus reversal" });
      try {
        const result = await reverseManualProductionBonus(
          id,
          paymentId,
          String(req.body.reversalDate ?? ""),
          String(req.body.reason ?? ""),
          actor(req)
        );
        return res.json(result);
      } catch (error) {
        const translated = translateDatabaseError(error);
        const status =
          translated?.statusCode ??
          errorStatus(
            error,
            typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500
          );
        if (status >= 500) logger.error("Manual bonus reversal failed", { error });
        return res.status(status).json({
          message:
            status >= 500
              ? "Manual reversal failed"
              : (translated?.message ?? (error instanceof Error ? error.message : "Invalid manual bonus reversal")),
        });
      }
    }
  );

  app.get(
    "/api/factory/production-target-bonuses/checkout",
    requireAuth,
    guard,
    async (req: Request, res: Response) => {
      if (!allowed(req))
        return res.status(403).json({ message: bonusServerText(req.headers["accept-language"], "adminOnly") });
      const id = company(req),
        from = req.query.from ?? req.query.date,
        to = req.query.to ?? req.query.date,
        method = req.query.method;
      if (!id)
        return res.status(400).json({ message: bonusServerText(req.headers["accept-language"], "checkoutCompany") });
      if (!targetBonusValidRange(from, to) || (method !== "standard" && method !== "category"))
        return res.status(400).json({ message: bonusServerText(req.headers["accept-language"], "checkoutMethod") });
      try {
        const offers = await calculateOffers(db, id, String(from), String(to), method);
        res.setHeader("Cache-Control", "private, no-store");
        return res.json({ from, to, method, currency: "USD", offers });
      } catch (error) {
        logger.error("Bonus checkout preview failed", { error });
        return res.status(500).json({ message: bonusServerText(req.headers["accept-language"], "checkoutFailed") });
      }
    }
  );
  registerProductionBonusCheckoutRoutesPart1(app);
}
