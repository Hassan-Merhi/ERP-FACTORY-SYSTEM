/**
 * Single Payroll-style Production Targets bonus checkout.
 * One company transaction freezes the calculation, approves it, posts the
 * voucher and creates the linked Daybook entry. No manual category target
 * allocation and no End Production prerequisite.
 */
import type { Express, Request, Response } from "express";
import { bonusServerText } from "../../i18n/productionBonusCheckoutMessages";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { logger } from "../../lib/logger";
import { errorStatus, translateDatabaseError } from "../../lib/httpHandlers";
import { targetBonusValidRange } from "../../services/factory/targetBonusReview";
import { postTargetBonusPaymentsInTransaction } from "../../services/factory/targetBonusPaymentService";
import { parseTargetBonusPaymentCommand } from "../../services/factory/targetBonusPaymentPolicy";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import {
  parseManualBonusCommand,
  postManualProductionBonuses,
  reverseManualProductionBonus,
} from "../../services/factory/manualProductionBonusPaymentService";
import { isRealBonusDate } from "../../services/factory/targetBonusPaymentPolicy";
import { actor, allowed, company, fail, guard, rows, usd } from "./productionBonusCheckoutRoutesCreditedCategories";
import { calculateOffers } from "./productionBonusCheckoutRoutesCalculateOffers";
import { z } from "zod";
import {
  emptyQuery,
  positiveIntParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";

// parseManualBonusCommand, parseTargetBonusPaymentCommand and the handlers keep
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
const checkoutPayInput = {
  query: emptyQuery,
  body: z.strictObject({
    ...paymentCommandFields,
    method: z.string().optional(),
    rosterDate: z.string().nullable().optional(),
    selections: z
      .array(
        z.strictObject({
          date: z.string(),
          workerId: z.number(),
          expectedAmount: amountLike,
          token: z.string().optional(),
        })
      )
      .optional(),
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
  app.post(
    "/api/factory/production-target-bonuses/checkout/pay",
    requireAuth,
    guard,
    validateRequest(checkoutPayInput),
    async (req: Request, res: Response) => {
      if (!allowed(req))
        return res.status(403).json({ message: bonusServerText(req.headers["accept-language"], "adminOnly") });
      const id = company(req),
        method = req.body?.method;
      if (!id)
        return res.status(400).json({ message: bonusServerText(req.headers["accept-language"], "checkoutCompany") });
      if (method !== "standard" && method !== "category")
        return res.status(400).json({ message: bonusServerText(req.headers["accept-language"], "chooseBonusMethod") });
      try {
        const command = parseTargetBonusPaymentCommand(req.body);
        const input = req.body.selections as Array<Record<string, unknown>>;
        if (input.some((row) => typeof row.token !== "string" || !/^[a-f0-9]{64}$/.test(row.token)))
          fail(400, "Refresh the bonus calculation before paying");
        const firstDate = command.selections[0].date;
        const lastDate = command.selections[command.selections.length - 1].date;
        const rosterDate = req.body?.rosterDate ?? lastDate;
        // The exact as-of date used for the preview must also be used during
        // the locked payment recheck, even if only an earlier day is selected.
        if (
          !targetBonusValidRange(firstDate, lastDate) ||
          !targetBonusValidRange(firstDate, rosterDate) ||
          rosterDate < lastDate
        )
          fail(400, "Select production dates within a 32-day window");
        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(84023,${id})`);
          const quotes = await calculateOffers(tx, id, firstDate, lastDate, method, rosterDate);
          const quotedByDay = new Map(quotes.map((quote) => [quote.date + ":" + quote.workerId, quote]));
          for (const selection of command.selections) {
            const date = selection.date;
            const quote = quotedByDay.get(date + ":" + selection.workerId);
            const received = input.find((q) => Number(q.workerId) === selection.workerId && q.date === date);
            if (
              !quote ||
              !received ||
              quote.token !== received.token ||
              quote.amount !== selection.expectedAmount ||
              (quote.status !== "pending" &&
                quote.status !== "approved" &&
                !(quote.status === "paid" && quote.issue === null && quote.method === method))
            )
              fail(409, "Bonus amount or eligibility changed; refresh before paying");
            if (quote.status === "pending") {
              const rate =
                quote.extra > 0
                  ? new Decimal(quote.amount).div(quote.extra).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4)
                  : "0.0000";
              const inserted = rows(
                await tx.execute(sql`
                INSERT INTO factory_target_bonus_reviews
                  (company_id,production_date,worker_id,target_bales,produced_bales,
                   extra_bales,rate_per_bale,bonus_amount,status,reviewed_by)
                VALUES (${id},${date}::date,${quote.workerId},${quote.target},${quote.produced},
                  ${quote.extra},${rate},${quote.amount},'approved',${actor(req).userId})
                ON CONFLICT (company_id,production_date,worker_id) DO NOTHING RETURNING id
              `)
              );
              if (inserted.length !== 1) fail(409, "Bonus was reviewed concurrently; refresh");
              await tx.execute(sql`
                INSERT INTO factory_target_bonus_checkout_details
                  (company_id,review_id,method,breakdown,calculation_hash,created_by)
                VALUES (${id},${Number(inserted[0].id)},${method},
                        ${JSON.stringify(quote.lines)}::jsonb,${quote.token},${actor(req).userId})
              `);
            } else if (quote.status === "approved") {
              // The payment has not been posted. Reprice only in the SAME
              // atomic approval/payment transaction; save the old reviewed
              // amount to an append-only audit table before changing it.
              const original = rows(
                await tx.execute(sql`
                SELECT rv.id,rv.bonus_amount::text AS amount,
                  rv.extra_bales::text AS "extraBales",
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
              `)
              )[0];
              if (!original) fail(409, "Previously approved bonus was paid or changed; refresh");
              const oldAmount = usd(String(original.amount));
              const oldLines = Array.isArray(original.breakdown) ? original.breakdown : null;
              const newLines = JSON.stringify(quote.lines);
              const oldLinesJson = oldLines === null ? null : JSON.stringify(oldLines);
              const repricedRate =
                quote.extra > 0
                  ? new Decimal(quote.amount).div(quote.extra).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4)
                  : "0.0000";
              if (
                oldAmount !== quote.amount ||
                Number(original.extraBales) !== quote.extra ||
                (oldLinesJson !== null && oldLinesJson !== newLines)
              ) {
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
                  SET target_bales=${quote.target}::numeric,
                    produced_bales=${quote.produced}::integer,extra_bales=${quote.extra}::numeric,
                    bonus_amount=${quote.amount}::numeric,rate_per_bale=${repricedRate}::numeric
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
          return postTargetBonusPaymentsInTransaction(tx, id, command, actor(req));
        });
        res.setHeader("Cache-Control", "private, no-store");
        return res.status(result.posted ? 201 : 200).json(result);
      } catch (error) {
        const translated = translateDatabaseError(error);
        const status = translated
          ? translated.statusCode
          : errorStatus(
              error,
              typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500
            );
        if (status === 500) logger.error("Production bonus checkout payment failed", { error });
        return res.status(status).json({
          message:
            status === 500
              ? bonusServerText(req.headers["accept-language"], "paymentFailed")
              : (translated?.message ??
                (error instanceof Error
                  ? error.message
                  : bonusServerText(req.headers["accept-language"], "invalidBonusPayment"))),
        });
      }
    }
  );
}
