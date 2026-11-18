// Extracted from ./productionBonusCheckoutRoutes.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { loadTargetBonusRows } from "../../services/factory/targetBonusReview";
import { loadProductionTargetsRosterIds } from "../../services/factory/productionTargetsRoster";
import { normalizeBonusCategory } from "@shared/productionTargetBonusCategoryRates";
import { allocateWeeklyExtraBales, splitExtraBalesByCategory } from "@shared/productionBonusCheckoutMath";
import { latestUnpaidWorkerRate, rateChangeMayRepriceReview } from "@shared/productionBonusUnpaidRatePolicy";
import { isProductionWorkday, mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import {
  creditedCategories,
  hash,
  rows,
  usd,
  type BonusLine,
  type Method,
  type Offer,
} from "./productionBonusCheckoutRoutesCreditedCategories";

export async function calculateOffers(
  tx: DatabaseOrTransaction,
  companyId: number,
  from: string,
  to: string,
  method: Method,
  rosterDate: string = to
): Promise<Offer[]> {
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
  const result: Offer[] = [];
  for (const source of daily) {
    if (source.date < from || source.date > to || !rosterWorkerIds.has(source.workerId)) continue;
    const date = source.date;
    const key = date + ":" + source.workerId;
    const claim = claimsByDay.get(key);
    const frozen = claim?.paymentStatus === "POSTED" || claim?.paymentStatus === "REVERSED";
    const item = {
      ...source,
      extraBales: frozen ? Number(claim?.extraBales ?? source.extraBales) : (weeklyExtras.get(key) ?? 0),
    };
    const weekStart = mondayOfProductionBonusWeek(date)!;
    const weeklyFlat =
      weeklyMethods.find((row) => String(row.week).slice(0, 10) <= weekStart)?.method === "weekly_flat";
    const weeklyClaim = weeklyReviews.some(
      (row) =>
        Number(row.id) === item.workerId &&
        String(row.start).slice(0, 10) <= date &&
        String(row.end).slice(0, 10) >= date
    );
    const lines: BonusLine[] = [];
    let issue: string | null = null;
    let handledByWeekly = false;
    let amount = "0.00";
    if (claim) {
      if (claim.checkoutMethod && claim.checkoutMethod !== method)
        issue = "Already reviewed using another bonus method";
      if (!claim.checkoutMethod && method === "category") issue = "Already reviewed with standard per-bale bonus";
      const savedLines = claim.breakdown;
      if (Array.isArray(savedLines))
        for (const line of savedLines) {
          if (line && typeof line === "object") lines.push(line as unknown as BonusLine);
        }
      amount = usd(String(claim.amount));
      const canReprice = rateChangeMayRepriceReview(claim.status, claim.paymentStatus);
      if (canReprice) {
        if (method === "standard") lines.length = 0;
        if (item.extraBales <= 0) {
          issue = "Weekly target not exceeded";
          amount = "0.00";
          lines.length = 0;
        }
      }
      if (!canReprice) {
        // Once a payment claim exists, neither reversal nor later edits can
        // rewrite its originally reviewed amount and category breakdown.
        if (method === "standard" && lines.length === 0 && item.extraBales > 0)
          lines.push({
            category: "All categories",
            produced: item.producedBales,
            extra: item.extraBales,
            rate: new Decimal(String(claim.ratePerBale ?? item.ratePerBale ?? 0)).toFixed(4),
            bonus: amount,
          });
      } else if (!issue && method === "standard") {
        const rate = rateForWorker(item.workerId);
        if (!rate) issue = "Set the worker/company per-bale rate first";
        else {
          amount = usd(rate.times(item.extraBales));
          lines.splice(0, lines.length, {
            category: "All categories",
            produced: item.producedBales,
            extra: item.extraBales,
            rate: rate.toFixed(4),
            bonus: amount,
          });
        }
      } else if (!issue && method === "category") {
        if (!lines.length) issue = "Missing approved category breakdown; reconcile before paying";
        else if (!Number.isSafeInteger(item.extraBales))
          issue = "Category bonus needs a whole number of weekly extra bales";
        else {
          // Previously approved but unpaid category records are repriced using
          // this week's NET surplus, never the obsolete individual-day extras.
          const counts = lines.map((line) => ({ category: line.category, count: line.produced }));
          if (
            counts.some((row) => !Number.isSafeInteger(row.count) || row.count < 0) ||
            counts.reduce((sum, row) => sum + row.count, 0) !== item.producedBales
          )
            issue = "Invalid approved category breakdown; reconcile stock entry";
          else {
            const portions = splitExtraBalesByCategory(item.extraBales, counts);
            let total = new Decimal(0);
            const priced: BonusLine[] = [];
            for (const line of portions) {
              if (line.extra === 0) {
                priced.push({ category: line.category, produced: line.count, extra: 0, rate: "0.0000", bonus: "0.00" });
                continue;
              }
              const category = normalizeBonusCategory(line.category);
              const rate = category ? await rateForCategory(category.key) : null;
              if (!rate) {
                issue = "Set a positive category rate for " + line.category;
                break;
              }
              const subtotal = usd(rate.times(line.extra));
              total = total.plus(subtotal);
              priced.push({
                category: line.category,
                produced: line.count,
                extra: line.extra,
                rate: rate.toFixed(4),
                bonus: subtotal,
              });
            }
            if (!issue) {
              amount = usd(total);
              lines.splice(0, lines.length, ...priced);
            }
          }
        }
      }
    } else if (weeklyFlat || weeklyClaim) {
      // Weekly-flat is a separate payment workflow, not missing production
      // evidence. Keep this day non-payable without presenting a false warning.
      handledByWeekly = true;
      issue = weeklyClaim
        ? "Already covered by a weekly bonus review"
        : "This week uses the weekly flat bonus; pay through Weekly Bonus Payroll";
    } else if (categoryClaims.has(key)) {
      issue = "An older category-bonus review already exists; reconcile before paying";
    } else if (!item.targetConfigured || item.targetBales <= 0 || !Number.isFinite(item.targetBales)) {
      // Zero production with no target is not a payable claim and not a
      // configuration error needing a warning for that day.
      issue = item.producedBales > 0 ? "Save a positive Production Targets target first" : "Weekly target not exceeded";
    } else if (item.extraBales <= 0) {
      issue = "Weekly target not exceeded";
    } else if (method === "standard") {
      const rate = rateForWorker(item.workerId);
      if (!rate) issue = "Set the worker/company per-bale rate first";
      else {
        amount = usd(rate.times(item.extraBales));
        lines.push({
          category: "All categories",
          produced: item.producedBales,
          extra: item.extraBales,
          rate: rate.toFixed(4),
          bonus: amount,
        });
      }
    } else {
      if (!Number.isSafeInteger(item.extraBales)) {
        issue = "Category bonus needs a whole number of extra bales; verify the daily target";
      }
      const counts = issue ? [] : await creditedCategories(tx, companyId, date, item.workerId, item.linkGroupId);
      const credited = counts.reduce((sum, c) => sum + c.count, 0);
      if (!issue && (credited !== item.producedBales || credited === 0))
        issue = "Bale category evidence does not match worker production; reconcile stock entry";
      else if (!issue) {
        // Divide excess bales proportionally across the actual categories made.
        // Stable largest-remainder allocation prevents double-counting one bale.
        const portions = splitExtraBalesByCategory(item.extraBales, counts);
        let total = new Decimal(0);
        for (const part of portions) {
          // Categories with no extra bales remain visible but add no charge.
          if (part.extra === 0) {
            lines.push({ category: part.category, produced: part.count, extra: 0, rate: "0.0000", bonus: "0.00" });
            continue;
          }
          const normalized = normalizeBonusCategory(part.category)!;
          const rate = await rateForCategory(normalized.key);
          if (!rate) {
            issue = "Set a positive category rate for " + part.category;
            break;
          }
          const partial = usd(rate.times(part.extra));
          // Line-level cent rounding ensures the displayed category subtotals
          // add up exactly to the worker's posted accounting amount.
          total = total.plus(new Decimal(partial));
          lines.push({
            category: part.category,
            produced: part.count,
            extra: part.extra,
            rate: rate.toFixed(4),
            bonus: partial,
          });
        }
        if (!issue) amount = usd(total);
      }
    }
    const status: Offer["status"] =
      claim?.paymentStatus === "POSTED"
        ? "paid"
        : claim?.paymentStatus === "REVERSED"
          ? "reversed"
          : claim?.status === "rejected"
            ? "rejected"
            : handledByWeekly
              ? "weekly"
              : issue === "Weekly target not exceeded" || (item.targetBales <= 0 && item.producedBales === 0 && !claim)
                ? "no_bonus"
                : issue?.startsWith("Save a positive") ||
                    issue?.startsWith("Set the worker") ||
                    issue?.startsWith("Set a positive category")
                  ? "needs_setup"
                  : issue
                    ? "blocked"
                    : claim
                      ? "approved"
                      : item.extraBales > 0 && Number(amount) > 0
                        ? "pending"
                        : "no_bonus";
    const offerCore = {
      date,
      workerId: item.workerId,
      workerName: item.workerName,
      target: item.targetBales,
      produced: item.producedBales,
      extra: item.extraBales,
      method,
      lines,
      amount,
    };
    // The sheet renders the fee once per worker/week, without adding it to any daily checkout.
    const weekKey = weekStart + ":" + item.workerId;
    const weeklyBonus =
      (weeklyFlat || weeklyClaim) && !shownWeekly.has(weekKey) ? weeklyDisplays.get(weekKey) : undefined;
    if (weeklyBonus) shownWeekly.add(weekKey);
    result.push({
      ...offerCore,
      linkGroupId: item.linkGroupId,
      category: item.category,
      weeklyBonus,
      token:
        claim?.paymentStatus && typeof claim.calculationHash === "string" ? claim.calculationHash : hash(offerCore),
      status,
      issue,
    });
  }
  return result;
}
