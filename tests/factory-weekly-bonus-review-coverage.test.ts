/**
 * Weekly flat Production Targets bonus review decisions
 * (productionTargetBonusWeeklyReviewRoutes.ts) through the real HTTP app in
 * one rolled-back transaction per test. Pins the role and request guards,
 * the eligibility / token / payroll refusals, the immutable decision with its
 * idempotent replay and the refusal of a different second decision - and
 * that every refusal writes no review row.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createBonusWorld, type BonusWorld } from "./helpers/productionBonusFixture";

const BASE = "/api/factory/production-target-bonuses";
const WEEK = "2026-01-05";

async function eligibleWeek(w: FactoryWorld) {
  const b = await createBonusWorld(w.client, w.companyId);
  const workerId = await b.worker("Weekly Presser");
  await b.weeklyMethod(WEEK, "weekly_flat", "25");
  await b.day(WEEK, workerId, 2, 4, ["Cream", "Cream", "Cream", "Cream"]);
  // The saved daily total must match the frozen bale snapshot.
  await b.q(`UPDATE factory_staff_tracking_entries SET produced_bales = 4 WHERE company_id = $1 AND person_id = $2`, [
    b.companyId,
    workerId,
  ]);
  const preview = await w.agent.get(`${BASE}/weekly-preview`).query({ weekOf: WEEK });
  expect(preview.status).toBe(200);
  const worker = preview.body.workers.find((row: { workerId: number }) => row.workerId === workerId);
  expect(worker, JSON.stringify(preview.body)).toBeDefined();
  return { b, workerId, worker, preview: preview.body };
}

const reviewRows = (b: BonusWorld) =>
  b.q(
    `SELECT worker_id, status, bonus_amount::text AS amount, review_note FROM factory_target_bonus_weekly_reviews
        WHERE company_id = $1`,
    [b.companyId]
  );

const decision = (workerId: number, reviewToken: string, extra: Record<string, unknown> = {}) => ({
  confirm: true,
  weekStart: WEEK,
  workerId,
  decision: "approved",
  expectedAmount: "25.00",
  reviewToken,
  ...extra,
});

describe("weekly bonus review list", () => {
  it("requires Admin/Owner and a valid week, and lists an empty week", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get(`${BASE}/weekly-reviews`).query({ weekOf: "nope" })).status).toBe(400);
      const empty = await w.agent.get(`${BASE}/weekly-reviews`).query({ weekOf: "2026-01-07" });
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ weekStart: WEEK, reviews: [], approvalDoesNotPost: true });
      const manager = await w.agentFor("Manager");
      expect((await manager.get(`${BASE}/weekly-reviews`).query({ weekOf: WEEK })).status).toBe(403);
      expect((await manager.post(`${BASE}/weekly-reviews/decide`).send({})).status).toBe(403);
    });
  });
});

describe("weekly bonus review decisions", () => {
  it("refuses malformed decisions", async () => {
    await withFactoryWorld(async (w) => {
      const token = "a".repeat(64);
      const post = (body: unknown) => w.agent.post(`${BASE}/weekly-reviews/decide`).send(body as object);
      for (const bad of [
        decision(1, token, { confirm: false }),
        decision(1, token, { weekStart: "2026-01-06" }),
        decision(1, token, { workerId: 0 }),
        decision(1, token, { decision: "maybe" }),
        decision(1, token, { expectedAmount: "25" }),
        decision(1, token, { expectedAmount: "0.00" }),
        decision(1, "XYZ"),
        decision(1, token, { note: 5 }),
        decision(1, token, { note: "n".repeat(501) }),
      ]) {
        const res = await post(bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
      }
    });
  });

  it("refuses ineligible workers, stale tokens and payroll-covered weeks", async () => {
    await withFactoryWorld(async (w) => {
      const { b, workerId, worker, preview } = await eligibleWeek(w);
      expect(worker.eligible, JSON.stringify(preview.days)).toBe(true);
      const post = (body: object) => w.agent.post(`${BASE}/weekly-reviews/decide`).send(body);
      const stranger = await post(decision(999999999, worker.reviewToken));
      expect(stranger.status).toBe(409);
      expect(stranger.body.message).toContain("not eligible");
      const stale = await post(decision(workerId, "b".repeat(64)));
      expect(stale.status).toBe(409);
      expect(stale.body.message).toContain("refresh before confirming");
      const wrongAmount = await post(decision(workerId, worker.reviewToken, { expectedAmount: "20.00" }));
      expect(wrongAmount.body.message).toContain("refresh before confirming");

      await b.q(
        `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, status)
         VALUES ($1, $2, '2026-01-01', '2026-01-31', 'PAID')`,
        [b.companyId, workerId]
      );
      const payroll = await post(decision(workerId, worker.reviewToken));
      expect(payroll.status).toBe(409);
      expect(payroll.body.message).toContain("Payroll already covers");
      expect(await reviewRows(b)).toEqual([]);
    });
  });

  it("records one immutable decision, replays it and refuses a different one", async () => {
    await withFactoryWorld(async (w) => {
      const { b, workerId, worker } = await eligibleWeek(w);
      const post = (body: object) => w.agent.post(`${BASE}/weekly-reviews/decide`).send(body);
      const body = decision(workerId, worker.reviewToken, { note: "  Great week  " });
      const first = await post(body);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        replayed: false,
        amount: "25.00",
        status: "approved",
        accountingPosted: false,
      });
      expect(await reviewRows(b)).toEqual([
        { worker_id: workerId, status: "approved", amount: "25.00", review_note: "Great week" },
      ]);

      const replay = await post(body);
      expect(replay.status).toBe(200);
      expect(replay.headers["x-idempotent-replay"]).toBe("true");
      expect(replay.body.reviewId).toBe(first.body.reviewId);
      const changed = await post({ ...body, decision: "rejected" });
      expect(changed.status).toBe(409);
      expect(changed.body.message).toContain("different immutable decision");

      const list = await w.agent.get(`${BASE}/weekly-reviews`).query({ weekOf: "2026-01-08" });
      expect(list.headers["cache-control"]).toContain("no-store");
      expect(list.body.reviews).toEqual([
        expect.objectContaining({
          id: first.body.reviewId,
          workerId,
          status: "approved",
          amount: "25.00",
          note: "Great week",
        }),
      ]);
    });
  });
});
