/**
 * Weekly flat bonus payment and reversal (weeklyBonusPaymentService) against
 * PostgreSQL in a rolled-back transaction: one balanced voucher, claim,
 * daybook entry and audit row per approved worker/week, idempotent replay,
 * and every refusal before a voucher is posted.
 */
import { describe, expect, it } from "vitest";

import {
  postWeeklyBonusPayments,
  reverseWeeklyBonusPayment,
} from "../server/services/factory/weeklyBonusPaymentService";
import { weeklyBonusReviewToken } from "../server/services/factory/weeklyBonusReviewSnapshot";
import { isClosedPeriodError } from "../server/lib/closedPeriodError";
import { withRolledBackPool } from "./helpers/routedPoolClient";
import { closeBooksOn, createBonusWorld, type BonusWorld } from "./helpers/productionBonusFixture";

const WEEK = "2026-02-02";
const WEEK_END = "2026-02-08";
const PAY_DATE = "2026-02-10";

function withBonus(work: (b: BonusWorld) => Promise<void>) {
  return withRolledBackPool(async (client) => work(await createBonusWorld(client)));
}

/** An immutable weekly review with a signed snapshot (overridable to break integrity). */
async function weeklyReview(
  b: BonusWorld,
  workerId: number,
  options: { status?: "approved" | "rejected"; amount?: string; tamper?: Record<string, unknown>; method?: number } = {}
) {
  const methodId = options.method ?? (await b.weeklyMethod(WEEK, "weekly_flat", options.amount ?? "30"));
  const snapshot = {
    companyId: b.companyId,
    workerId,
    weekStart: WEEK,
    weekEnd: WEEK_END,
    method: "weekly_flat",
    methodVersionId: methodId,
    amount: options.amount ?? "30.00",
    targetBales: "10.00",
    creditedBales: 14,
    extraBales: "4.00",
  };
  const hash = weeklyBonusReviewToken(snapshot);
  const id = await b.one(
    `INSERT INTO factory_target_bonus_weekly_reviews (company_id, worker_id, week_start, week_end, status, bonus_amount,
       calculation_version, credited_bales, extra_bales, target_bales, method_version_id, reviewed_by, snapshot_hash,
       snapshot_json, worker_name_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, 'v1', 14, 4, 10, $7, 'fixture', $8, $9::jsonb, 'Weekly Worker') RETURNING id`,
    [
      b.companyId,
      workerId,
      WEEK,
      WEEK_END,
      options.status ?? "approved",
      options.amount ?? "30.00",
      methodId,
      hash,
      JSON.stringify({ ...snapshot, ...options.tamper }),
    ]
  );
  return { id, methodId };
}

const command = (b: BonusWorld, workerId: number, overrides: Record<string, unknown> = {}) => ({
  confirm: true as const,
  currency: "USD" as const,
  paymentDate: PAY_DATE,
  cashAccountId: b.cashId,
  selections: [{ weekStart: WEEK, workerId, expectedAmount: "30.00" }],
  ...overrides,
});

const vouchers = (b: BonusWorld) =>
  b.q(`SELECT voucher_type FROM vouchers WHERE company_id = $1 AND description LIKE '%weekly%' ORDER BY id`, [
    b.companyId,
  ]);

describe("weekly bonus payment", () => {
  it("posts one balanced payment with claim, daybook and audit, then replays without a second voucher", async () => {
    await withBonus(async (b) => {
      const worker = await b.worker("Weekly Worker");
      const { id: reviewId } = await weeklyReview(b, worker);
      const result = await postWeeklyBonusPayments(b.companyId, command(b, worker), b.actor);
      expect(result).toMatchObject({ success: true, posted: 1, replayed: 0, cashAccountId: b.cashId });
      expect(result.results[0]).toMatchObject({ reviewId, workerId: worker, amount: "30.00", replayed: false });
      const lines = await b.q(
        `SELECT debit_amount::text AS dr, credit_amount::text AS cr FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [result.results[0].voucherId]
      );
      expect(lines).toEqual([
        { dr: "30.00", cr: "0.00" },
        { dr: "0.00", cr: "30.00" },
      ]);
      const daybook = await b.q(
        `SELECT tx_type FROM factory_daybook_entries WHERE company_id = $1 AND reference_table = 'factory_target_bonus_weekly_payments'`,
        [b.companyId]
      );
      expect(daybook.map((d) => d.tx_type)).toEqual(["PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT"]);

      const replay = await postWeeklyBonusPayments(b.companyId, command(b, worker), b.actor);
      expect(replay).toMatchObject({ posted: 0, replayed: 1 });
      expect(await vouchers(b)).toHaveLength(1);
      await expect(
        postWeeklyBonusPayments(b.companyId, command(b, worker, { paymentDate: "2026-02-11" }), b.actor)
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/different details/) });
    });
  });

  it("refuses bad identities, missing reviews and changed amounts", async () => {
    await withBonus(async (b) => {
      const worker = await b.worker("Weekly Worker");
      await expect(postWeeklyBonusPayments(0, command(b, worker), b.actor)).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        postWeeklyBonusPayments(b.companyId, command(b, worker), { userId: "", username: "" })
      ).rejects.toMatchObject({ statusCode: 401 });
      await expect(postWeeklyBonusPayments(b.companyId, command(b, worker), b.actor)).rejects.toMatchObject({
        statusCode: 404,
      });
      await weeklyReview(b, worker);
      const changed = command(b, worker, {
        selections: [{ weekStart: WEEK, workerId: worker, expectedAmount: "31.00" }],
      });
      await expect(postWeeklyBonusPayments(b.companyId, changed, b.actor)).rejects.toThrow(/amount changed/);
      const expense = await b.ledger("EXPX", "Expense");
      await expect(
        postWeeklyBonusPayments(b.companyId, command(b, worker, { cashAccountId: expense }), b.actor)
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await vouchers(b)).toHaveLength(0);
    });
  });

  it("refuses a tampered snapshot, a foreign method version and unapproved weeks", async () => {
    await withBonus(async (b) => {
      const tampered = await b.worker("Tampered");
      await weeklyReview(b, tampered, { tamper: { amount: "99.00" } });
      await expect(postWeeklyBonusPayments(b.companyId, command(b, tampered), b.actor)).rejects.toThrow(
        /integrity check failed/
      );
      const rejected = await b.worker("Rejected");
      await weeklyReview(b, rejected, { status: "rejected" });
      await expect(postWeeklyBonusPayments(b.companyId, command(b, rejected), b.actor)).rejects.toThrow(
        /Only approved weekly bonuses/
      );
      const empty = await b.worker("Empty Snapshot");
      const emptyReview = await weeklyReview(b, empty, { tamper: {} });
      await b.q(
        `ALTER TABLE factory_target_bonus_weekly_reviews DISABLE TRIGGER factory_bonus_weekly_review_immutable`
      );
      await b.q(`UPDATE factory_target_bonus_weekly_reviews SET snapshot_json = '{}'::jsonb WHERE id = $1`, [
        emptyReview.id,
      ]);
      await expect(postWeeklyBonusPayments(b.companyId, command(b, empty), b.actor)).rejects.toThrow(
        /integrity check failed/
      );
      const perBale = await b.worker("Per Bale Method");
      const otherMethod = await b.weeklyMethod("2026-03-02", "weekly_flat", "30");
      await weeklyReview(b, perBale, { method: otherMethod });
      await expect(postWeeklyBonusPayments(b.companyId, command(b, perBale), b.actor)).rejects.toThrow(
        /does not belong to this factory/
      );
      expect(await vouchers(b)).toHaveLength(0);
    });
  });

  it("refuses early payment, manual payouts and overlapping daily bonuses or payroll", async () => {
    await withBonus(async (b) => {
      const early = await b.worker("Early");
      await weeklyReview(b, early);
      await expect(
        postWeeklyBonusPayments(b.companyId, command(b, early, { paymentDate: "2026-02-05" }), b.actor)
      ).rejects.toThrow(/cannot predate/);

      const manual = await b.worker("Manual Paid");
      await weeklyReview(b, manual);
      const voucher = await b.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount) VALUES ($1, $2, 'Payment', $3, 0) RETURNING id`,
        [b.companyId, `${b.tag}MAN`, PAY_DATE]
      );
      await b.q(
        `INSERT INTO factory_target_bonus_manual_payments (company_id, worker_id, week_start, amount_usd, payment_date, request_key,
           cash_ledger_account_id, expense_ledger_account_id, payment_voucher_id, posted_by)
         VALUES ($1, $2, $3, 5, $4, gen_random_uuid(), $5, $5, $6, 'fixture')`,
        [b.companyId, manual, WEEK, PAY_DATE, b.cashId, voucher]
      );
      await expect(postWeeklyBonusPayments(b.companyId, command(b, manual), b.actor)).rejects.toThrow(/manual bonus/);

      const daily = await b.worker("Daily Reviewed");
      await weeklyReview(b, daily);
      await b.review("2026-02-03", daily);
      await expect(postWeeklyBonusPayments(b.companyId, command(b, daily), b.actor)).rejects.toThrow(/overlaps/);
      expect(await vouchers(b)).toHaveLength(0);
    });
  });

  it("refuses a payment dated inside a closed accounting period", async () => {
    await withBonus(async (b) => {
      const worker = await b.worker("Closed Period");
      await weeklyReview(b, worker);
      await closeBooksOn(b, "2026-12-31");
      await expect(postWeeklyBonusPayments(b.companyId, command(b, worker), b.actor)).rejects.toSatisfy(
        isClosedPeriodError
      );
      const claims = await b.q(`SELECT id FROM factory_target_bonus_weekly_payments WHERE company_id = $1`, [
        b.companyId,
      ]);
      expect(claims).toHaveLength(0);
    });
  });
});

describe("weekly bonus reversal", () => {
  it("posts a mirror receipt once and keeps the claim so the week cannot be paid again", async () => {
    await withBonus(async (b) => {
      const worker = await b.worker("Weekly Worker");
      await weeklyReview(b, worker);
      const paid = await postWeeklyBonusPayments(b.companyId, command(b, worker), b.actor);
      const paymentId = paid.results[0].paymentId;
      await expect(reverseWeeklyBonusPayment(b.companyId, paymentId, "2026-02-09", "early", b.actor)).rejects.toThrow(
        /cannot precede/
      );
      const reversed = await reverseWeeklyBonusPayment(
        b.companyId,
        paymentId,
        "2026-02-12",
        "  Paid in error  ",
        b.actor
      );
      expect(reversed).toMatchObject({ paymentId, reversed: true, replayed: false });
      const [claim] = await b.q(
        `SELECT status, reversal_reason FROM factory_target_bonus_weekly_payments WHERE id = $1`,
        [paymentId]
      );
      expect(claim).toEqual({ status: "REVERSED", reversal_reason: "Paid in error" });
      expect((await vouchers(b)).map((v) => v.voucher_type)).toEqual(["Payment", "Receipt"]);
      const again = await reverseWeeklyBonusPayment(b.companyId, paymentId, "2026-02-12", "again", b.actor);
      expect(again).toMatchObject({ replayed: true, voucherId: reversed.voucherId });
      await expect(postWeeklyBonusPayments(b.companyId, command(b, worker), b.actor)).rejects.toThrow(
        /already posted or reversed/
      );
    });
  });

  it("validates its input and the payment's company", async () => {
    await withBonus(async (b) => {
      await expect(reverseWeeklyBonusPayment(b.companyId, 0, "2026-02-12", "r", b.actor)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(reverseWeeklyBonusPayment(b.companyId, 1, "2026-02-30", "r", b.actor)).rejects.toThrow(
        /valid reversal date/
      );
      await expect(reverseWeeklyBonusPayment(b.companyId, 1, "2026-02-12", " ", b.actor)).rejects.toThrow(/reason/);
      await expect(
        reverseWeeklyBonusPayment(b.companyId, 1, "2026-02-12", "x".repeat(401), b.actor)
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        reverseWeeklyBonusPayment(b.companyId, 1, "2026-02-12", "r", { userId: "", username: "" })
      ).rejects.toMatchObject({ statusCode: 401 });
      await expect(reverseWeeklyBonusPayment(b.companyId, 999999999, "2026-02-12", "r", b.actor)).rejects.toMatchObject(
        {
          statusCode: 404,
        }
      );
    });
  });
});
