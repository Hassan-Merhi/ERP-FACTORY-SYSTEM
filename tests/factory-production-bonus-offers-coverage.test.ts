/**
 * Production bonus checkout offers (calculateOffers) against PostgreSQL in a
 * rolled-back transaction: which worker-days are payable, how much, and why
 * every other day is held back (setup missing, weekly flat, already paid...).
 */
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { calculateOffers } from "../server/routes/factory/productionBonusCheckoutRoutesCalculateOffers";
import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createBonusWorld, type BonusWorld } from "./helpers/productionBonusFixture";

// Mondays of separate production weeks, so each scenario owns its week.
const W1 = "2026-01-05";
const W2 = "2026-01-12";
const W3 = "2026-01-19";

function withBonus(work: (b: BonusWorld) => Promise<void>) {
  return withRolledBackPool(async (client) => work(await createBonusWorld(client)));
}

const offers = (b: BonusWorld, from: string, to: string, method: "standard" | "category" = "standard") =>
  calculateOffers(db, b.companyId, from, to, method);

const pick = (list: Awaited<ReturnType<typeof offers>>, workerId: number) => list.find((o) => o.workerId === workerId);

describe("standard per-bale offers without a prior review", () => {
  it("prices surplus with the worker rate and explains every non-payable day", async () => {
    await withBonus(async (b) => {
      const paid = await b.worker("Paid Worker");
      const noRate = await b.worker("No Rate");
      const under = await b.worker("Under Target");
      const noTarget = await b.worker("No Target");
      const idle = await b.worker("Idle No Target");
      await b.rate("worker", "1.5", paid);
      await b.rate("company", "0", null);
      await b.day(W1, paid, 5, 9);
      await b.day(W1, noRate, 5, 8);
      await b.day(W1, under, 6, 4);
      await b.day(W1, noTarget, null, 3);
      await b.day(W1, idle, null, 0);
      const list = await offers(b, W1, W1);
      expect(pick(list, paid)).toMatchObject({
        status: "pending",
        amount: "6.00",
        extra: 4,
        issue: null,
        lines: [{ category: "All categories", produced: 9, extra: 4, rate: "1.5000", bonus: "6.00" }],
      });
      expect(pick(list, paid)!.token).toMatch(/^[a-f0-9]{64}$/);
      expect(pick(list, noRate)).toMatchObject({
        status: "needs_setup",
        issue: "Set the worker/company per-bale rate first",
      });
      expect(pick(list, under)).toMatchObject({
        status: "no_bonus",
        issue: "Weekly target not exceeded",
        amount: "0.00",
      });
      expect(pick(list, noTarget)).toMatchObject({
        status: "needs_setup",
        issue: "Save a positive Production Targets target first",
      });
      expect(pick(list, idle)).toMatchObject({ status: "no_bonus", issue: "Weekly target not exceeded" });
    });
  });
});

describe("weekly flat bonus weeks", () => {
  it("routes days to weekly payroll and shows the flat fee once per worker/week", async () => {
    await withBonus(async (b) => {
      const surplus = await b.worker("Surplus");
      const short = await b.worker("Short");
      const gone = await b.worker("Gone");
      await b.weeklyMethod(W1, "weekly_flat", "25");
      // Saved on Monday only: not on the roster of the checkout end date.
      await b.day(W1, gone, 1, 5);
      await b.day(W1, surplus, 5, 8);
      await b.day("2026-01-06", surplus, 5, 7);
      await b.day(W1, short, 5, 2);
      await b.day("2026-01-06", short, 5, 2);
      const list = await offers(b, W1, "2026-01-06");
      const days = list.filter((o) => o.workerId === surplus);
      expect(days).toHaveLength(2);
      expect(days.every((o) => o.status === "weekly")).toBe(true);
      expect(days[0].issue).toBe("This week uses the weekly flat bonus; pay through Weekly Bonus Payroll");
      const shown = days.filter((o) => o.weeklyBonus);
      expect(shown).toHaveLength(1);
      expect(shown[0].weeklyBonus).toEqual({ weekStart: W1, amount: "25.00", state: "projected" });
      expect(list.filter((o) => o.workerId === short).some((o) => o.weeklyBonus)).toBe(false);
      expect(pick(list, gone)).toBeUndefined();
    });
  });

  it("shows an approved weekly review amount and blocks a rejected week from projection", async () => {
    await withBonus(async (b) => {
      const approved = await b.worker("Approved Week");
      const rejected = await b.worker("Rejected Week");
      const methodId = await b.weeklyMethod(W1, "weekly_flat", "25");
      await b.day(W1, approved, 5, 9);
      await b.day(W1, rejected, 5, 9);
      for (const [workerId, status] of [
        [approved, "approved"],
        [rejected, "rejected"],
      ] as const) {
        await b.q(
          `INSERT INTO factory_target_bonus_weekly_reviews (company_id, worker_id, week_start, week_end, status, bonus_amount,
             calculation_version, credited_bales, extra_bales, target_bales, method_version_id, reviewed_by, snapshot_hash,
             snapshot_json, worker_name_snapshot)
           VALUES ($1, $2, $3, $3::date + 6, $4, 30, 'v1', 9, 4, 5, $5, 'fixture', $6, '{}', 'W')`,
          [b.companyId, workerId, W1, status, methodId, "c".repeat(64)]
        );
      }
      // Per-bale method from the next week: the weekly review still covers W1.
      await b.weeklyMethod(W2, "per_extra_bale");
      const list = await offers(b, W1, W1);
      expect(pick(list, approved)).toMatchObject({
        status: "weekly",
        issue: "Already covered by a weekly bonus review",
        weeklyBonus: { weekStart: W1, amount: "30.00", state: "approved" },
      });
      expect(pick(list, rejected)!.weeklyBonus).toBeUndefined();
    });
  });
});

describe("offers for already reviewed worker-days", () => {
  it("reprices approved unpaid reviews and freezes paid, reversed and rejected ones", async () => {
    await withBonus(async (b) => {
      const unpaid = await b.worker("Unpaid");
      const paid = await b.worker("Paid");
      const reversed = await b.worker("Reversed");
      const rejected = await b.worker("Rejected");
      const fell = await b.worker("Fell Short");
      const noRate = await b.worker("No Rate Review");
      await b.rate("company", "2");
      await b.rate("worker", "0", noRate);
      for (const w of [unpaid, paid, reversed, rejected, noRate]) await b.day(W2, w, 5, 8);
      await b.day(W2, fell, 5, 5);
      await b.review(W2, unpaid, { amount: "1.00", extra: "3", produced: 8, method: "standard" });
      const paidReview = await b.review(W2, paid, { amount: "4.50", extra: "3", rate: "1.5" });
      await b.dailyPayment(paidReview, W2, paid, "4.50");
      const revReview = await b.review(W2, reversed, { amount: "3.00", extra: "3" });
      await b.dailyPayment(revReview, W2, reversed, "3.00", "REVERSED");
      await b.review(W2, rejected, { status: "rejected", amount: "0" });
      await b.review(W2, fell, { amount: "2.00", produced: 5, extra: "0" });
      await b.review(W2, noRate, { amount: "2.00" });
      const list = await offers(b, W2, W2);
      expect(pick(list, unpaid)).toMatchObject({ status: "approved", amount: "6.00", issue: null });
      expect(pick(list, unpaid)!.lines).toEqual([
        { category: "All categories", produced: 8, extra: 3, rate: "2.0000", bonus: "6.00" },
      ]);
      expect(pick(list, paid)).toMatchObject({ status: "paid", amount: "4.50", extra: 3 });
      expect(pick(list, paid)!.lines[0]).toMatchObject({ rate: "1.5000", bonus: "4.50" });
      expect(pick(list, reversed)).toMatchObject({ status: "reversed", amount: "3.00" });
      expect(pick(list, rejected)).toMatchObject({ status: "rejected", amount: "0.00" });
      expect(pick(list, fell)).toMatchObject({
        status: "no_bonus",
        issue: "Weekly target not exceeded",
        amount: "0.00",
      });
      expect(pick(list, noRate)).toMatchObject({ status: "needs_setup" });
    });
  });

  it("blocks a review made with another method", async () => {
    await withBonus(async (b) => {
      const standard = await b.worker("Standard Reviewed");
      const category = await b.worker("Category Reviewed");
      await b.rate("company", "1");
      await b.day(W1, standard, 5, 8);
      await b.day(W1, category, 5, 8);
      await b.review(W1, standard, { amount: "3.00", extra: "3" });
      await b.review(W1, category, { amount: "3.00", extra: "3", method: "category", breakdown: [] });
      const asCategory = await offers(b, W1, W1, "category");
      expect(pick(asCategory, standard)).toMatchObject({
        status: "blocked",
        issue: "Already reviewed with standard per-bale bonus",
      });
      const asStandard = await offers(b, W1, W1, "standard");
      expect(pick(asStandard, category)).toMatchObject({
        status: "blocked",
        issue: "Already reviewed using another bonus method",
      });
    });
  });
});

describe("category-weighted offers", () => {
  it("splits surplus across captured categories and prices each category", async () => {
    await withBonus(async (b) => {
      const ok = await b.worker("Category OK");
      const unpriced = await b.worker("Category Unpriced");
      const uncaptured = await b.worker("Uncaptured");
      await b.categoryRate("Shirts", "2");
      await b.categoryRate("Jeans", "3");
      await b.categoryRate("Rags", "0");
      await b.day(W3, ok, 4, 8, ["Shirts", "Shirts", "Shirts", "Shirts", "Jeans", "Jeans", "Jeans", "Jeans"]);
      await b.day(W3, unpriced, 1, 2, ["Rags", "Rags"]);
      await b.day("2026-01-20", uncaptured, 1, 3);
      const list = await offers(b, W3, W3, "category");
      const offer = pick(list, ok)!;
      expect(offer).toMatchObject({ status: "pending", amount: "10.00", extra: 4 });
      expect(offer.lines).toEqual([
        { category: "Jeans", produced: 4, extra: 2, rate: "3.0000", bonus: "6.00" },
        { category: "Shirts", produced: 4, extra: 2, rate: "2.0000", bonus: "4.00" },
      ]);
      expect(pick(list, unpriced)).toMatchObject({
        status: "needs_setup",
        issue: "Set a positive category rate for Rags",
      });
      const later = await offers(b, "2026-01-20", "2026-01-20", "category");
      expect(pick(later, uncaptured)).toMatchObject({
        status: "blocked",
        issue: "Bale category evidence does not match worker production; reconcile stock entry",
      });
    });
  });

  it("reprices approved category breakdowns and refuses missing or inconsistent ones", async () => {
    await withBonus(async (b) => {
      const good = await b.worker("Breakdown Good");
      const empty = await b.worker("Breakdown Empty");
      const wrong = await b.worker("Breakdown Wrong");
      const unrated = await b.worker("Breakdown Unrated");
      await b.categoryRate("Shirts", "2");
      for (const w of [good, empty, wrong, unrated]) await b.day(W1, w, 5, 7);
      const line = (category: string, produced: number) => ({ category, produced, extra: 1, rate: "1", bonus: "1.00" });
      await b.review(W1, good, { method: "category", breakdown: [line("Shirts", 6), line("Polo", 1)] });
      await b.review(W1, empty, { method: "category", breakdown: [] });
      await b.review(W1, wrong, { method: "category", breakdown: [line("Shirts", 3)] });
      await b.review(W1, unrated, { method: "category", breakdown: [line("Coats", 7)] });
      const list = await offers(b, W1, W1, "category");
      // Polo has no rate but receives no share of the surplus, so no rate is needed.
      expect(pick(list, good)).toMatchObject({ status: "approved", amount: "4.00", issue: null });
      expect(pick(list, good)!.lines).toEqual([
        { category: "Shirts", produced: 6, extra: 2, rate: "2.0000", bonus: "4.00" },
        { category: "Polo", produced: 1, extra: 0, rate: "0.0000", bonus: "0.00" },
      ]);
      expect(pick(list, empty)).toMatchObject({
        status: "blocked",
        issue: "Missing approved category breakdown; reconcile before paying",
      });
      expect(pick(list, wrong)).toMatchObject({
        status: "blocked",
        issue: "Invalid approved category breakdown; reconcile stock entry",
      });
      expect(pick(list, unrated)).toMatchObject({
        status: "needs_setup",
        issue: "Set a positive category rate for Coats",
      });
    });
  });
});
