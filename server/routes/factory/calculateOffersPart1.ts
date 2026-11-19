// Extracted from ./productionBonusCheckoutRoutesCalculateOffers.ts
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { loadTargetBonusRows } from "../../services/factory/targetBonusReview";
import { loadProductionTargetsRosterIds } from "../../services/factory/productionTargetsRoster";
import { allocateWeeklyExtraBales } from "@shared/productionBonusCheckoutMath";
import { latestUnpaidWorkerRate } from "@shared/productionBonusUnpaidRatePolicy";
import { isProductionWorkday, mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import { rows, usd } from "./productionBonusCheckoutRoutesCreditedCategories";

export async function calculateOffersPart1(
  tx: DatabaseOrTransaction,
  companyId: number,
  from: string,
  to: string,
  rosterDate: string
) {
  // Always fetch COMPLETE Mon-Sun weeks, even when the selected range is
  // shorter. This includes live production with no End Production requirement.
  // Show the exact worker roster from Production Targets on the selected
  // date, rather than everyone seen during the historical checkout range.
  const rosterWorkerIds = await loadProductionTargetsRosterIds(tx, companyId, rosterDate);
  const weekFrom = mondayOfProductionBonusWeek(from)!;
  const endMonday = mondayOfProductionBonusWeek(to)!;
  const sunday = new Date(endMonday + "T12:00:00.000Z");
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const weekTo = sunday.toISOString().slice(0, 10);
  const [dailyRows, claimsResult, methodsResult, weeklyReviewsResult, categoryReviewsResult, standardRatesResult] =
    await Promise.all([
      loadTargetBonusRows(tx, companyId, weekFrom, weekTo),
      tx.execute(sql`
      SELECT rv.production_date::text AS date, rv.worker_id AS "workerId",
        rv.status, rv.bonus_amount::text AS amount,
        rv.extra_bales::text AS "extraBales",
        rv.rate_per_bale::text AS "ratePerBale",
        p.status AS "paymentStatus", details.method AS "checkoutMethod",
        details.breakdown AS breakdown, details.calculation_hash AS "calculationHash"
      FROM factory_target_bonus_reviews rv
      LEFT JOIN factory_target_bonus_payments p
        ON p.company_id=rv.company_id AND p.review_id=rv.id
      LEFT JOIN factory_target_bonus_checkout_details details
        ON details.company_id=rv.company_id AND details.review_id=rv.id
      WHERE rv.company_id=${companyId}
        AND rv.production_date BETWEEN ${weekFrom}::date AND ${weekTo}::date
    `),
      tx.execute(sql`
      SELECT effective_week::text AS week, method, flat_bonus_usd::text AS "flatBonusUsd"
      FROM factory_production_target_bonus_weekly_methods
      WHERE company_id=${companyId} AND effective_week<=${weekTo}::date
      ORDER BY effective_week DESC,id DESC
    `),
      tx.execute(sql`
      SELECT worker_id AS id, week_start::text AS start, week_end::text AS "end",
        status, bonus_amount::text AS amount
      FROM factory_target_bonus_weekly_reviews
      WHERE company_id=${companyId}
        AND week_start<=${weekTo}::date AND week_end>=${weekFrom}::date
    `),
      tx.execute(sql`
      SELECT worker_id AS id, production_date::text AS date
      FROM factory_target_bonus_category_reviews
      WHERE company_id=${companyId}
        AND production_date BETWEEN ${weekFrom}::date AND ${weekTo}::date
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
  // Never count Sunday production or targets in new bonus previews and payments.
  // Previously posted financial history is left untouched in its own ledger.
  const daily = dailyRows.filter((day) => isProductionWorkday(day.date));
  const claimsByDay = new Map(
    rows(claimsResult).map((row) => [String(row.date).slice(0, 10) + ":" + Number(row.workerId), row])
  );
  const weeklyMethods = rows(methodsResult);
  const weeklyReviews = rows(weeklyReviewsResult);
  const categoryClaims = new Set(
    rows(categoryReviewsResult).map((row) => String(row.date).slice(0, 10) + ":" + Number(row.id))
  );
  const activeStandardRates = rows(standardRatesResult);
  const weeklyExtras = allocateWeeklyExtraBales(
    daily.map((day) => {
      const claim = claimsByDay.get(day.date + ":" + day.workerId);
      const frozen = claim?.paymentStatus === "POSTED" || claim?.paymentStatus === "REVERSED";
      return {
        date: day.date,
        workerId: day.workerId,
        target: day.targetBales,
        produced: day.producedBales,
        targetConfigured: day.targetConfigured === true,
        frozenExtra: frozen ? Number(claim?.extraBales ?? 0) : undefined,
      };
    })
  );
  // A worker earns at most one flat fee per complete Monday-Sunday total,
  // regardless of the number of surplus bales or production days displayed.
  // The in-progress figure below is a read-only projection; actual approval
  // remains exclusively in the frozen weekly review and payroll workflows.
  type WeeklyDisplay = { weekStart: string; amount: string; state: "projected" | "approved" };
  const weeklyDisplays = new Map<string, WeeklyDisplay>();
  const summaries = new Map<string, { extra: number; dailyClaim: boolean }>();
  for (const row of daily) {
    const monday = mondayOfProductionBonusWeek(row.date)!;
    const key = monday + ":" + row.workerId;
    const previous = summaries.get(key) ?? { extra: 0, dailyClaim: false };
    previous.extra += weeklyExtras.get(row.date + ":" + row.workerId) ?? 0;
    previous.dailyClaim ||=
      claimsByDay.has(row.date + ":" + row.workerId) || categoryClaims.has(row.date + ":" + row.workerId);
    summaries.set(key, previous);
  }
  for (const [key, summary] of summaries) {
    const weekStart = key.slice(0, 10);
    const workerId = Number(key.slice(11));
    const review = weeklyReviews.find(
      (row) => Number(row.id) === workerId && String(row.start).slice(0, 10) === weekStart
    );
    if (review) {
      // A rejected or already reviewed week must never be recalculated.
      if (review.status === "approved" && Number(review.amount) > 0)
        weeklyDisplays.set(key, { weekStart, amount: usd(String(review.amount)), state: "approved" });
      continue;
    }
    const version = weeklyMethods.find((row) => String(row.week).slice(0, 10) <= weekStart);
    if (version?.method !== "weekly_flat" || summary.extra <= 0 || summary.dailyClaim) continue;
    const fee = Number(version.flatBonusUsd);
    if (!Number.isFinite(fee) || fee <= 0) continue;
    weeklyDisplays.set(key, { weekStart, amount: usd(String(version.flatBonusUsd)), state: "projected" });
  }
  const shownWeekly = new Set<string>();
  const rateForWorker = (workerId: number) => {
    const rate = latestUnpaidWorkerRate(activeStandardRates, workerId);
    return rate === null ? null : new Decimal(rate);
  };
  const categoryRates = new Map<string, Decimal | null>();
  const rateForCategory = async (key: string) => {
    if (categoryRates.has(key)) return categoryRates.get(key)!;
    const version = rows(
      await tx.execute(sql`
      SELECT enabled,rate_per_extra_bale::text AS rate
      FROM factory_production_target_bonus_category_rates
      WHERE company_id=${companyId} AND category_key=${key}
      ORDER BY id DESC LIMIT 1
    `)
    )[0];
    const rate = version?.enabled === true && Number(version.rate) > 0 ? new Decimal(String(version.rate)) : null;
    categoryRates.set(key, rate);
    return rate;
  };
  return {
    rosterWorkerIds,
    daily,
    claimsByDay,
    weeklyMethods,
    weeklyReviews,
    categoryClaims,
    weeklyExtras,
    weeklyDisplays,
    shownWeekly,
    rateForWorker,
    rateForCategory,
  };
}
