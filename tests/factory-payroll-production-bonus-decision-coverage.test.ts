/**
 * /api/factory/payroll/:id/production-bonuses (read and decision) through the
 * real app inside one rolled-back transaction: id/company checks, the Admin
 * gate, decision validation, non-DRAFT payrolls, unmatched allocations, the
 * block on a worker/day whose Production Targets bonus was already paid, and
 * approve/reject with the payroll bonus and net salary recalculated.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createBonusWorld } from "./helpers/productionBonusFixture";

const url = (id: number | string) => `/api/factory/payroll/${id}/production-bonuses`;

async function payrollWithBonuses(w: FactoryWorld, companyId = w.companyId, status = "DRAFT") {
  const workerId = await w.one(
    `INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, 'Presser', TRUE) RETURNING id`,
    [companyId]
  );
  const payrollId = await w.one(
    `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, bonuses, net_salary, status)
     VALUES ($1, $2, '2026-05-01', '2026-05-31', '5.00', '105.00', $3) RETURNING id`,
    [companyId, workerId, status]
  );
  const positionId = await w.one(
    `INSERT INTO factory_production_positions (company_id, name) VALUES ($1, $2) RETURNING id`,
    [companyId, `Press ${status} ${Math.floor(Math.random() * 1e9)}`]
  );
  const runs: number[] = [];
  for (const [day, amount] of [
    ["2026-05-04", "10.00"],
    ["2026-05-05", "6.00"],
  ]) {
    const runId = await w.one(
      `INSERT INTO factory_production_bonus_runs (company_id, production_date, position_id, position_name_snapshot,
         target_bales, actual_bales, extra_bales, bonus_per_extra_bale, bonus_pool, member_count, status)
       VALUES ($1, $2::date, $3, 'Press', 10, 12, 2, '5.00', $4, 1, 'PENDING') RETURNING id`,
      [companyId, day, positionId, amount]
    );
    await w.q(
      `INSERT INTO factory_production_bonus_allocations (company_id, run_id, worker_id, worker_name_snapshot, amount,
         decision_status, payroll_id)
       VALUES ($1, $2, $3, 'Presser', $4, 'PENDING', $5)`,
      [companyId, runId, workerId, amount, payrollId]
    );
    runs.push(runId);
  }
  return { workerId, payrollId, runs };
}

const allocations = (w: FactoryWorld, payrollId: number) =>
  w.q(
    `SELECT run_id, decision_status AS status FROM factory_production_bonus_allocations WHERE payroll_id = $1 ORDER BY run_id`,
    [payrollId]
  );

describe("payroll production bonuses", () => {
  it("reads only this company's payroll", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get(url("abc"))).status).toBe(400);
      expect((await w.agent.get(url(2147483000))).status).toBe(404);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const theirs = await payrollWithBonuses(w, other);
      expect((await w.agent.get(url(theirs.payrollId))).status).toBe(404);
      const mine = await payrollWithBonuses(w);
      const res = await w.agent.get(url(mine.payrollId));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.totals).toMatchObject({ pendingCount: 2 });
    }));

  it("refuses non-admins, bad input, other companies and non-draft payrolls without writing", () =>
    withFactoryWorld(async (w) => {
      const p = await payrollWithBonuses(w);
      const before = await allocations(w, p.payrollId);
      const manager = await w.agentFor("Manager");
      const denied = await manager.post(`${url(p.payrollId)}/decision`).send({ decision: "APPROVED", all: true });
      expect(denied.status).toBe(403);

      const post = (id: number | string, body: Record<string, unknown>) =>
        w.agent.post(`${url(id)}/decision`).send(body);
      expect((await post("x", { decision: "APPROVED", all: true })).status).toBe(400);
      expect((await post(p.payrollId, { decision: "MAYBE", all: true })).body.message).toBe(
        "decision must be APPROVED or REJECTED"
      );
      const none = await post(p.payrollId, { decision: "APPROVED", items: [{ runId: "a", workerId: -1 }, null] });
      expect(none.body.message).toBe("Choose at least one production bonus allocation");
      const unmatched = await post(p.payrollId, { decision: "APPROVED", items: [{ runId: 2147483000, workerId: 1 }] });
      expect(unmatched.status).toBe(400);
      expect(unmatched.body.message).toMatch(/No matching production bonus/);
      expect((await post(2147483000, { decision: "APPROVED", all: true })).status).toBe(404);

      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}Q`,
      ]);
      const theirs = await payrollWithBonuses(w, other);
      expect((await post(theirs.payrollId, { decision: "APPROVED", all: true })).status).toBe(404);
      const posted = await payrollWithBonuses(w, w.companyId, "APPROVED");
      const locked = await post(posted.payrollId, { decision: "REJECTED", all: true });
      expect(locked.status).toBe(409);

      expect(await allocations(w, p.payrollId)).toEqual(before);
      expect((await allocations(w, theirs.payrollId)).every((a) => a.status === "PENDING")).toBe(true);
    }));

  it("blocks approval when the worker's target bonus for that day was paid", () =>
    withFactoryWorld(async (w) => {
      const p = await payrollWithBonuses(w);
      const bonus = await createBonusWorld(w.client, w.companyId);
      const reviewId = await bonus.review("2026-05-04", p.workerId, { amount: "3.00" });
      await bonus.dailyPayment(reviewId, "2026-05-04", p.workerId, "3.00");
      const before = await allocations(w, p.payrollId);
      const res = await w.agent
        .post(`${url(p.payrollId)}/decision`)
        .send({ decision: "APPROVED", items: [{ runId: p.runs[0], workerId: p.workerId }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already paid/);
      expect(await allocations(w, p.payrollId)).toEqual(before);
    }));

  it("approves and rejects allocations, moving the payroll bonus and net salary", () =>
    withFactoryWorld(async (w) => {
      const p = await payrollWithBonuses(w);
      const approve = await w.agent.post(`${url(p.payrollId)}/decision`).send({
        decision: "approved",
        items: [
          { runId: p.runs[0], workerId: p.workerId },
          { runId: p.runs[0], workerId: p.workerId },
        ],
        note: "  good week  ",
      });
      expect(approve.status, JSON.stringify(approve.body)).toBe(200);
      expect(approve.body).toMatchObject({ otherBonus: 5, totalBonus: 15, netSalary: 115, affected: 1 });
      const [note] = await w.q(
        `SELECT decision_note, decided_by FROM factory_production_bonus_allocations WHERE run_id = $1`,
        [p.runs[0]]
      );
      expect(note).toEqual({ decision_note: "good week", decided_by: w.userId });

      const reject = await w.agent.post(`${url(p.payrollId)}/decision`).send({ decision: "REJECTED", all: true });
      expect(reject.status).toBe(200);
      expect(reject.body).toMatchObject({ totalBonus: 5, netSalary: 105, affected: 2 });
      expect((await allocations(w, p.payrollId)).map((a) => a.status)).toEqual(["REJECTED", "REJECTED"]);
      const [payroll] = await w.q(
        `SELECT bonuses::text AS b, net_salary::text AS n FROM factory_payrolls WHERE id = $1`,
        [p.payrollId]
      );
      expect(payroll).toEqual({ b: "5.00", n: "105.00" });
    }));
});
