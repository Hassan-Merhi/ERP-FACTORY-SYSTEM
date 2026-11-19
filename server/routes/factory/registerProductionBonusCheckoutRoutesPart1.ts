// Extracted from ./productionBonusCheckoutRoutes.ts
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
import { actor, allowed, company, fail, guard, rows, usd } from "./productionBonusCheckoutRoutesCreditedCategories";
import { calculateOffers } from "./productionBonusCheckoutRoutesCalculateOffers";

export function registerProductionBonusCheckoutRoutesPart1(app: Express) {
  app.post(
    "/api/factory/production-target-bonuses/checkout/pay",
    requireAuth,
    guard,
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
