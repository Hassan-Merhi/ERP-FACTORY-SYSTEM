/**
 * Production Targets bonus review routes (list / decide / worker rate) over
 * HTTP against PostgreSQL, one rolled-back transaction per test. Pinned: only
 * Owners/Admins see money or decide, every decision is checked against the
 * live production figures, and decisions are immutable and idempotent.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createBonusWorld, type BonusWorld } from "./helpers/productionBonusFixture";

const BASE = "/api/factory/staff-tracking/production-bonuses";
const DAY = "2026-01-06";

async function setup(w: FactoryWorld) {
  const b = await createBonusWorld(w.client, w.companyId);
  return b;
}

const decide = (w: FactoryWorld, decisions: unknown, agent = w.agent) =>
  agent.post(`${BASE}/decide`).send({ decisions });

const reviews = (b: BonusWorld) =>
  b.q(
    `SELECT worker_id, status, bonus_amount::text AS amount FROM factory_target_bonus_reviews WHERE company_id = $1 ORDER BY worker_id`,
    [b.companyId]
  );

describe("production bonus list", () => {
  it("shows amounts and totals to Admins only and validates the range", async () => {
    await withFactoryWorld(async (w) => {
      const b = await setup(w);
      const worker = await b.worker("Lister");
      await b.rate("company", "1.25");
      await b.day(DAY, worker, 5, 9);
      const res = await w.agent.get(BASE).query({ start: DAY, end: DAY });
      expect(res.status).toBe(200);
      expect(res.body.canDecide).toBe(true);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0]).toMatchObject({ workerId: worker, extraBales: 4, proposedAmount: 5, status: "pending" });
      expect(res.body.totals).toMatchObject({ workers: 1, pendingAmount: 5, pendingCount: 1 });

      const manager = await w.agentFor("Manager");
      const hidden = await manager.get(BASE).query({ start: DAY, end: DAY });
      expect(hidden.body).toMatchObject({ rows: [], canDecide: false });
      expect((await w.agent.get(BASE).query({ start: "2026-01-01", end: "2026-03-01" })).status).toBe(400);
      expect((await w.agent.get(BASE).query({ start: "bad", end: DAY })).status).toBe(400);
    });
  });
});

describe("production bonus decisions", () => {
  it("approves and rejects pending days once and replays identical retries", async () => {
    await withFactoryWorld(async (w) => {
      const b = await setup(w);
      const approve = await b.worker("Approve Me");
      const reject = await b.worker("Reject Me");
      await b.rate("company", "2");
      await b.day(DAY, approve, 5, 8);
      await b.day(DAY, reject, 5, 6);
      const body = [
        {
          date: DAY,
          workerId: approve,
          decision: "approved",
          expectedAmount: 6,
          expectedProducedBales: 8,
          expectedTargetBales: 5,
        },
        { date: DAY, workerId: reject, decision: "rejected", expectedAmount: "2" },
      ];
      const res = await decide(w, body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, saved: 2, unchanged: 0 });
      expect(await reviews(b)).toEqual([
        { worker_id: approve, status: "approved", amount: "6.00" },
        { worker_id: reject, status: "rejected", amount: "2.00" },
      ]);
      const replay = await decide(w, body);
      expect(replay.body).toEqual({ success: true, saved: 0, unchanged: 2 });
      const flip = await decide(w, [{ ...body[1], decision: "approved" }]);
      expect(flip.status).toBe(409);
      expect(flip.body.message).toMatch(/immutable decision/);
    });
  });

  it("refuses non-Admins and malformed, duplicate or over-wide selections", async () => {
    await withFactoryWorld(async (w) => {
      const b = await setup(w);
      const worker = await b.worker("Validated");
      const ok = { date: DAY, workerId: worker, decision: "approved", expectedAmount: 1 };
      const manager = await w.agentFor("Manager");
      expect((await decide(w, [ok], manager)).status).toBe(403);
      expect((await decide(w, [])).body.message).toMatch(/between 1 and 200/);
      expect((await decide(w, "x")).status).toBe(400);
      for (const bad of [
        null,
        { ...ok, date: "2026-02-30" },
        { ...ok, workerId: 0 },
        { ...ok, decision: "maybe" },
        { ...ok, expectedAmount: -1 },
        { ...ok, expectedProducedBales: 1.5 },
        { ...ok, expectedTargetBales: -2 },
      ]) {
        const res = await decide(w, [bad]);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe("Invalid bonus review selection");
      }
      expect((await decide(w, [ok, ok])).body.message).toMatch(/only appear once/);
      expect((await decide(w, [ok, { ...ok, date: "2026-03-06" }])).body.message).toMatch(/up to 32 days/);
      expect(await reviews(b)).toEqual([]);
    });
  });

  it("refuses changed figures, missing production, missing setup and weekly-covered days", async () => {
    await withFactoryWorld(async (w) => {
      const b = await setup(w);
      const changed = await b.worker("Changed");
      const noTarget = await b.worker("No Target");
      const noRate = await b.worker("No Rate");
      const weekly = await b.worker("Weekly Reviewed");
      await b.rate("company", "1");
      await b.rate("worker", "0", noRate);
      await b.day(DAY, changed, 5, 8);
      await b.day(DAY, noTarget, null, 4);
      await b.day(DAY, noRate, 5, 8);
      await b.day(DAY, weekly, 5, 8);
      const pick = (workerId: number, extra: Record<string, unknown> = {}) => [
        { date: DAY, workerId, decision: "approved", expectedAmount: 3, ...extra },
      ];
      const msg = async (body: unknown) => (await decide(w, body)).body.message as string;
      expect(await msg(pick(changed, { expectedProducedBales: 7 }))).toMatch(/production or target changed/);
      expect(await msg(pick(changed, { expectedTargetBales: 4 }))).toMatch(/production or target changed/);
      expect(await msg(pick(changed, { expectedAmount: 2.5 }))).toMatch(/amount changed/);
      expect(await msg(pick(noTarget, { expectedAmount: 4 }))).toMatch(/valid production target/);
      expect(await msg(pick(noRate, { expectedAmount: 0 }))).toMatch(/positive rate/);
      expect(await msg(pick(999999999))).toMatch(/No production record/);

      const methodId = await b.weeklyMethod("2026-01-05", "weekly_flat", "20");
      await b.q(
        `INSERT INTO factory_target_bonus_weekly_reviews (company_id, worker_id, week_start, week_end, status, bonus_amount,
           calculation_version, credited_bales, extra_bales, target_bales, method_version_id, reviewed_by, snapshot_hash,
           snapshot_json, worker_name_snapshot)
         VALUES ($1, $2, '2026-01-05', '2026-01-11', 'approved', 20, 'v1', 8, 3, 5, $3, 'fixture', $4, '{}', 'W')`,
        [b.companyId, weekly, methodId, "d".repeat(64)]
      );
      expect(await msg(pick(weekly))).toMatch(/weekly flat bonus review/);
      expect(await msg(pick(changed))).toMatch(/daily per-bale reviews are disabled/);
      expect(await reviews(b)).toEqual([]);
    });
  });
});

describe("worker bonus rate", () => {
  it("appends a worker rate version and refuses bad input, foreign workers and non-Admins", async () => {
    await withFactoryWorld(async (w) => {
      const b = await setup(w);
      const worker = await b.worker("Rated");
      const rate = (body: Record<string, unknown>, agent = w.agent) => agent.post(`${BASE}/rate`).send(body);
      const res = await rate({ workerId: worker, effectiveFrom: DAY, ratePerBale: "1.2345" });
      expect(res.body).toEqual({ success: true });
      const rows = await b.q(
        `SELECT scope, rate_per_extra_bale::text AS rate, enabled FROM factory_production_target_bonus_rates WHERE worker_id = $1`,
        [worker]
      );
      expect(rows).toEqual([{ scope: "worker", rate: "1.2345", enabled: true }]);
      for (const bad of [
        { workerId: 0, effectiveFrom: DAY, ratePerBale: "1" },
        { workerId: worker, effectiveFrom: "nope", ratePerBale: "1" },
        { workerId: worker, effectiveFrom: DAY, ratePerBale: "1.23456" },
        { workerId: worker, effectiveFrom: DAY, ratePerBale: "0" },
        { workerId: worker, effectiveFrom: DAY },
      ]) {
        expect((await rate(bad)).status).toBe(400);
      }
      const unknown = await rate({ workerId: 999999999, effectiveFrom: DAY, ratePerBale: "1" });
      expect(unknown.status).toBe(404);
      const manager = await w.agentFor("Manager");
      expect((await rate({ workerId: worker, effectiveFrom: DAY, ratePerBale: "1" }, manager)).status).toBe(403);
      const count = await b.q(
        `SELECT COUNT(*)::int AS n FROM factory_production_target_bonus_rates WHERE worker_id = $1`,
        [worker]
      );
      expect(count[0].n).toBe(1);
    });
  });
});
