// Extracted from ./productionBonusCheckoutRoutes.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import type { DatabaseOrTransaction } from "../../db";
import { normalizeBonusCategory } from "@shared/productionTargetBonusCategoryRates";
import { splitExtraBalesByCategory } from "@shared/productionBonusCheckoutMath";
import { rateChangeMayRepriceReview } from "@shared/productionBonusUnpaidRatePolicy";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import {
  creditedCategories,
  hash,
  usd,
  type BonusLine,
  type Method,
  type Offer,
} from "./productionBonusCheckoutRoutesCreditedCategories";
import { calculateOffersPart1 } from "./calculateOffersPart1";

export async function calculateOffers(
  tx: DatabaseOrTransaction,
  companyId: number,
  from: string,
  to: string,
  method: Method,
  rosterDate: string = to
): Promise<Offer[]> {
  const {
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
  } = await calculateOffersPart1(tx, companyId, from, to, rosterDate);
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
