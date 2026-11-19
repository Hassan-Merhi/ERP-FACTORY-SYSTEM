/**
 * Production Targets bonus checkout routes over HTTP against PostgreSQL, one
 * rolled-back transaction per test: the calculated preview and payment (with
 * token, eligibility and repricing checks) and the separate manual bonus
 * payments with their reversal. Refusals never write reviews or payments.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createBonusWorld, type BonusWorld } from "./helpers/productionBonusFixture";

const BASE = "/api/factory/production-target-bonuses/checkout";
const DAY = "2026-01-05";

async function setup(w: FactoryWorld) {
  const b = await createBonusWorld(w.client, w.companyId);
  const worker = await b.worker("Checkout Worker");
  await b.rate("company", "1.5");
  await b.day(DAY, worker, 5, 9);
  return { b, worker };
}

const preview = (w: FactoryWorld) => w.agent.get(BASE).query({ from: DAY, to: DAY, method: "standard" });

async function written(b: BonusWorld) {
  const [row] = await b.q<{ reviews: number; payments: number; manual: number }>(
    `SELECT (SELECT count(*)::int FROM factory_target_bonus_reviews WHERE company_id = $1) AS reviews,
            (SELECT count(*)::int FROM factory_target_bonus_payments WHERE company_id = $1) AS payments,
            (SELECT count(*)::int FROM factory_target_bonus_manual_payments WHERE company_id = $1) AS manual`,
    [b.companyId]
  );
  return row;
}

function payBody(b: BonusWorld, offer: { workerId: number; date: string; amount: string; token: string }, extra = {}) {
  return {
    confirm: true,
    method: "standard",
    paymentDate: "2026-01-10",
    cashAccountId: b.cashId,
    currency: "USD",
    selections: [{ workerId: offer.workerId, date: offer.date, expectedAmount: offer.amount, token: offer.token }],
    ...extra,
  };
}

describe("bonus checkout preview", () => {
  it("prices pending days for Admins and refuses other roles and bad ranges", async () => {
    await withFactoryWorld(async (w) => {
      const { worker } = await setup(w);
      const res = await preview(w);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.offers.find((o: any) => o.workerId === worker)).toMatchObject({
        status: "pending",
        amount: "6.00",
      });
      const manager = await w.agentFor("Manager");
      expect((await manager.get(BASE).query({ date: DAY, method: "standard" })).status).toBe(403);
      expect((await w.agent.get(BASE).query({ date: DAY, method: "other" })).status).toBe(400);
      expect((await w.agent.get(BASE).query({ from: DAY, to: "2026-03-30", method: "category" })).status).toBe(400);
    });
  });
});

describe("bonus checkout pay", () => {
  it("approves and posts a pending day in one transaction, then replays it", async () => {
    await withFactoryWorld(async (w) => {
      const { b, worker } = await setup(w);
      const offer = (await preview(w)).body.offers.find((o: any) => o.workerId === worker);
      const paid = await w.agent.post(`${BASE}/pay`).send(payBody(b, offer));
      expect(paid.status).toBe(201);
      expect(await written(b)).toEqual({ reviews: 1, payments: 1, manual: 0 });
      const [detail] = await b.q(
        `SELECT method, calculation_hash FROM factory_target_bonus_checkout_details WHERE company_id = $1`,
        [b.companyId]
      );
      expect(detail).toEqual({ method: "standard", calculation_hash: offer.token });

      const again = (await preview(w)).body.offers.find((o: any) => o.workerId === worker);
      expect(again.status).toBe("paid");
      const replay = await w.agent.post(`${BASE}/pay`).send(payBody(b, again));
      expect(replay.status).toBe(200);
      expect(await written(b)).toEqual({ reviews: 1, payments: 1, manual: 0 });
    });
  });

  it("pays an approved standard review at its reviewed amount without repricing", async () => {
    await withFactoryWorld(async (w) => {
      const { b, worker } = await setup(w);
      const review = await b.review(DAY, worker, { amount: "3.00", extra: "2", rate: "1.5" });
      const offer = (await preview(w)).body.offers.find((o: any) => o.workerId === worker);
      expect(offer).toMatchObject({ status: "approved", amount: "3.00" });
      expect((await w.agent.post(`${BASE}/pay`).send(payBody(b, offer))).status).toBe(201);
      const revisions = await b.q(`SELECT id FROM factory_target_bonus_unpaid_rate_revisions WHERE review_id = $1`, [
        review,
      ]);
      expect(revisions).toHaveLength(0);
      expect(await written(b)).toMatchObject({ reviews: 1, payments: 1 });
    });
  });

  it("reprices an approved, unpaid category review inside the payment and keeps the old amount", async () => {
    await withFactoryWorld(async (w) => {
      const b = await createBonusWorld(w.client, w.companyId);
      const worker = await b.worker("Category Worker");
      await b.categoryRate("Shirts", "2");
      await b.day(DAY, worker, 5, 9, Array(9).fill("Shirts"));
      const review = await b.review(DAY, worker, {
        amount: "2.00",
        extra: "2",
        produced: 9,
        rate: "1",
        method: "category",
        breakdown: [{ category: "Shirts", produced: 9, extra: 2, rate: "1.0000", bonus: "2.00" }],
      });
      const list = await w.agent.get(BASE).query({ from: DAY, to: DAY, method: "category" });
      const offer = list.body.offers.find((o: any) => o.workerId === worker);
      expect(offer).toMatchObject({ status: "approved", amount: "8.00" });
      const paid = await w.agent.post(`${BASE}/pay`).send(payBody(b, offer, { method: "category" }));
      expect(paid.status).toBe(201);
      const [revision] = await b.q(
        `SELECT old_amount::text AS old, new_amount::text AS new FROM factory_target_bonus_unpaid_rate_revisions WHERE review_id = $1`,
        [review]
      );
      expect(revision).toEqual({ old: "2.00", new: "8.00" });
      const [row] = await b.q(`SELECT bonus_amount::text AS amount FROM factory_target_bonus_reviews WHERE id = $1`, [
        review,
      ]);
      expect(row.amount).toBe("8.00");
    });
  });

  it("refuses roles, methods, malformed commands, stale tokens and bad windows without writing", async () => {
    await withFactoryWorld(async (w) => {
      const { b, worker } = await setup(w);
      const offer = (await preview(w)).body.offers.find((o: any) => o.workerId === worker);
      const manager = await w.agentFor("Manager");
      expect((await manager.post(`${BASE}/pay`).send(payBody(b, offer))).status).toBe(403);
      const cases: Array<[Record<string, unknown>, number, RegExp]> = [
        [{ method: "flat" }, 400, /./],
        [{ confirm: false }, 400, /confirm/],
        [{ selections: [{ workerId: worker, date: DAY, expectedAmount: "6.00", token: "nope" }] }, 400, /Refresh/],
        [{ rosterDate: "2025-12-01" }, 400, /32-day window/],
        [
          { selections: [{ workerId: worker, date: DAY, expectedAmount: "6.00", token: "a".repeat(64) }] },
          409,
          /changed/,
        ],
        [{ selections: [{ workerId: worker, date: DAY, expectedAmount: "5.00", token: offer.token }] }, 409, /changed/],
      ];
      for (const [patch, status, message] of cases) {
        const res = await w.agent.post(`${BASE}/pay`).send(payBody(b, offer, patch));
        expect(res.status, JSON.stringify(patch)).toBe(status);
        expect(res.body.message).toMatch(message);
      }
      expect(await written(b)).toEqual({ reviews: 0, payments: 0, manual: 0 });
    });
  });
});

function manualBody(b: BonusWorld, workerId: number, extra: Record<string, unknown> = {}) {
  return {
    confirm: true,
    currency: "USD",
    weekStart: DAY,
    rosterDate: DAY,
    paymentDate: "2026-01-10",
    cashAccountId: b.cashId,
    requestKey: randomUUID(),
    selections: [{ workerId, amount: "12.50" }],
    ...extra,
  };
}

describe("manual bonus payments", () => {
  it("posts, lists, replays and reverses a manual payment", async () => {
    await withFactoryWorld(async (w) => {
      const { b, worker } = await setup(w);
      const body = manualBody(b, worker);
      const posted = await w.agent.post(`${BASE}/manual-pay`).send(body);
      expect(posted.status).toBe(201);
      const replay = await w.agent.post(`${BASE}/manual-pay`).send(body);
      expect(replay.status).toBe(200);
      expect(replay.headers["x-idempotent-replay"]).toBe("true");

      const list = await w.agent.get(`${BASE}/manual-payments`).query({ weekStart: DAY });
      expect(list.status).toBe(200);
      expect(list.body.payments).toHaveLength(1);
      expect(list.body.payments[0]).toMatchObject({ workerId: worker, amount: "12.50", status: "POSTED" });
      const paymentId = list.body.payments[0].id;

      const reverseUrl = `${BASE}/manual-payments/${paymentId}/reverse`;
      expect((await w.agent.post(reverseUrl).send({ reason: "Paid twice" })).status).toBe(400);
      expect((await w.agent.post(`${BASE}/manual-payments/abc/reverse`).send({ confirm: true })).status).toBe(400);
      const early = await w.agent
        .post(reverseUrl)
        .send({ confirm: true, reversalDate: "2026-01-06", reason: "Too early" });
      expect(early.status).toBe(409);
      const noReason = await w.agent.post(reverseUrl).send({ confirm: true, reversalDate: "2026-01-11" });
      expect(noReason.status).toBe(400);
      const missing = await w.agent
        .post(`${BASE}/manual-payments/999999999/reverse`)
        .send({ confirm: true, reversalDate: "2026-01-11", reason: "Paid twice" });
      expect(missing.status).toBe(404);
      const reversed = await w.agent
        .post(reverseUrl)
        .send({ confirm: true, reversalDate: "2026-01-11", reason: "Paid twice" });
      expect(reversed.status).toBe(200);
      const after = await w.agent.get(`${BASE}/manual-payments`).query({ weekStart: DAY });
      expect(after.body.payments[0].status).toBe("REVERSED");
    });
  });

  it("refuses other roles, non-Monday weeks and malformed payments", async () => {
    await withFactoryWorld(async (w) => {
      const { b, worker } = await setup(w);
      const manager = await w.agentFor("Manager");
      expect((await manager.get(`${BASE}/manual-payments`).query({ weekStart: DAY })).status).toBe(403);
      expect((await manager.post(`${BASE}/manual-pay`).send(manualBody(b, worker))).status).toBe(403);
      expect((await manager.post(`${BASE}/manual-payments/1/reverse`).send({ confirm: true })).status).toBe(403);
      expect((await w.agent.get(`${BASE}/manual-payments`).query({ weekStart: "2026-01-06" })).status).toBe(400);
      for (const patch of [
        { confirm: false },
        { currency: "ZMW" },
        { requestKey: "not-a-uuid" },
        { selections: [] },
        { selections: [{ workerId: worker, amount: "0" }] },
      ]) {
        const res = await w.agent.post(`${BASE}/manual-pay`).send(manualBody(b, worker, patch));
        expect(res.status, JSON.stringify(patch)).toBe(400);
      }
      expect(await written(b)).toEqual({ reviews: 0, payments: 0, manual: 0 });
    });
  });
});
