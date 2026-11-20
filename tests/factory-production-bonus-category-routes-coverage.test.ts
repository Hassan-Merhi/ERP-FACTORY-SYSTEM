/**
 * Production Targets category evidence routes
 * (server/routes/factory/productionBonusCategoryEvidenceRoutes.ts) over HTTP,
 * one rolled-back factory company per test: role and date refusals for the
 * preview and evidence reads, then the category-target allocation with its
 * input, finalization, evidence, worker, review and immutability refusals,
 * the first save and an identical replay. Refusals write no allocation sets.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createBonusWorld, type BonusWorld } from "./helpers/productionBonusFixture";

const BASE = "/api/factory/production-target-bonuses";
const DAY = "2026-01-05";
const SUNDAY = "2026-01-04";

async function setup(w: FactoryWorld) {
  const b = await createBonusWorld(w.client, w.companyId);
  const worker = await b.worker("Category Worker");
  await b.day(DAY, worker, 4, 4, ["Mixed", "Mixed", "Shoes", "Shoes"]);
  await savedProduced(w, worker, 4);
  const evidence = await w.agent.get(`${BASE}/category-evidence`).query({ date: DAY });
  expect(evidence.status).toBe(200);
  const keys = evidence.body.workers
    .find((x: { workerId: number }) => x.workerId === worker)
    .categories.map((c: { categoryKey: string }) => c.categoryKey);
  return { b, worker, keys: keys as string[] };
}

/** The fixture leaves the saved produced total empty; the evidence compares it with the bales. */
const savedProduced = (w: FactoryWorld, workerId: number, produced: number, status = "Present") =>
  w.q(
    `UPDATE factory_staff_tracking_entries SET produced_bales = $1, status = $2
      WHERE company_id = $3 AND person_id = $4 AND page_type = 'production'`,
    [produced, status, w.companyId, workerId]
  );

const sets = async (b: BonusWorld) =>
  Number(
    (
      await b.q<{ n: number }>(
        `SELECT count(*)::int AS n FROM factory_target_bonus_category_allocation_sets WHERE company_id = $1`,
        [b.companyId]
      )
    )[0].n
  );

const save = (w: FactoryWorld, body: Record<string, unknown>) =>
  w.agent.post(`${BASE}/category-targets`).send({ confirm: true, date: DAY, ...body });

describe("category preview and evidence reads", () => {
  it("refuses non-Admin roles and invalid or Sunday dates", () =>
    withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      for (const path of ["category-preview", "category-evidence"]) {
        const res = await manager.get(`${BASE}/${path}`).query({ date: DAY });
        expect(res.status, path).toBe(403);
        expect((await w.agent.get(`${BASE}/${path}`).query({ date: "2026-02-31" })).status).toBe(400);
      }
      expect((await manager.post(`${BASE}/category-targets`).send({})).status).toBe(403);
      const sunday = await w.agent.get(`${BASE}/category-preview`).query({ date: SUNDAY });
      expect(sunday.status).toBe(400);
      expect(sunday.body.message).toMatch(/Sunday/);
    }));

  it("returns a no-store proposal and the captured evidence", () =>
    withFactoryWorld(async (w) => {
      const { worker, keys } = await setup(w);
      expect(keys).toHaveLength(2);
      const preview = await w.agent.get(`${BASE}/category-preview`).query({ date: DAY });
      expect(preview.status).toBe(200);
      expect(preview.headers["cache-control"]).toBe("private, no-store");
      expect(preview.body).toMatchObject({ proposalOnly: true, canPost: false, finalized: true });
      expect(preview.body.workers.some((x: { workerId: number }) => x.workerId === worker)).toBe(true);
    }));
});

describe("category target allocation refusals", () => {
  it("rejects malformed requests before reading evidence", () =>
    withFactoryWorld(async (w) => {
      const { b, worker, keys } = await setup(w);
      const good = [{ categoryKey: keys[0], targetBales: 2 }];
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ workerId: worker, allocations: good, confirm: false }, /Confirm one worker/],
        [{ workerId: worker, allocations: good, date: SUNDAY }, /Confirm one worker/],
        [{ workerId: 0, allocations: good }, /Confirm one worker/],
        [{ workerId: worker, allocations: [] }, /Confirm one worker/],
        [{ workerId: worker, allocations: [null] }, /Invalid category allocation/],
        [{ workerId: worker, allocations: [{ categoryKey: keys[0], targetBales: "2" }] }, /Invalid category or target/],
        [{ workerId: worker, allocations: [{ categoryKey: 5, targetBales: 2 }] }, /Invalid category or target/],
      ];
      for (const [body, message] of cases) {
        const res = await save(w, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.message).toMatch(message);
      }
      expect(await sets(b)).toBe(0);
    }));

  it("refuses an unfinalized day and incomplete category evidence", () =>
    withFactoryWorld(async (w) => {
      const b = await createBonusWorld(w.client, w.companyId);
      const worker = await b.worker("Open Day");
      await w.q(
        `INSERT INTO factory_staff_tracking_entries (company_id, page_type, period_type, period_start, period_end,
           person_type, person_id, target_bales, category)
         VALUES ($1, 'production', 'daily', $2, $2, 'worker', $3, 4, 'Pressing')`,
        [w.companyId, DAY, worker]
      );
      const open = await save(w, { workerId: worker, allocations: [{ categoryKey: "x", targetBales: 4 }] });
      expect(open.status).toBe(409);
      expect(open.body.message).toBe("Production day is not finalized");

      await b.closeDay(DAY);
      const uncaptured = await save(w, { workerId: worker, allocations: [{ categoryKey: "x", targetBales: 4 }] });
      expect(uncaptured.status).toBe(409);
      expect(uncaptured.body.message).toMatch(/incomplete or differs/);
      expect(await sets(b)).toBe(0);
    }));

  it("refuses an unknown worker, a worker without a target, an absent worker and a bad split", () =>
    withFactoryWorld(async (w) => {
      const { b, worker, keys } = await setup(w);
      const noTarget = await b.worker("No Target");
      await b.day(DAY, noTarget, null, 0, []);
      await savedProduced(w, noTarget, 0);
      const absent = await b.worker("Absent Worker");
      await b.day(DAY, absent, 4, 0, []);
      await savedProduced(w, absent, 0, "Absent");
      const evidence = await w.agent.get(`${BASE}/category-evidence`).query({ date: DAY });
      expect(evidence.body.readyForTargetAllocation, JSON.stringify(evidence.body.issues)).toBe(true);

      const unknown = await save(w, { workerId: 2147483000, allocations: [{ categoryKey: keys[0], targetBales: 4 }] });
      expect(unknown.status).toBe(404);
      const missing = await save(w, { workerId: noTarget, allocations: [{ categoryKey: keys[0], targetBales: 4 }] });
      expect(missing.status).toBe(409);
      expect(missing.body.message).toBe("Worker has no saved daily target");
      const away = await save(w, { workerId: absent, allocations: [{ categoryKey: keys[0], targetBales: 4 }] });
      expect(away.status).toBe(409);
      expect(away.body.message).toBe("Absent worker cannot claim category production");
      const split = await save(w, {
        workerId: worker,
        allocations: [
          { categoryKey: keys[0], targetBales: 1 },
          { categoryKey: keys[1], targetBales: 1 },
        ],
      });
      expect(split.status).toBe(400);
      expect(split.body.message).toMatch(/sum to the saved daily target/);
      expect(await sets(b)).toBe(0);
    }));

  it("refuses an allocation once a review exists for the worker/day", () =>
    withFactoryWorld(async (w) => {
      const { b, worker, keys } = await setup(w);
      await b.review(DAY, worker, { status: "rejected" });
      const res = await save(w, {
        workerId: worker,
        allocations: keys.map((categoryKey) => ({ categoryKey, targetBales: 2 })),
      });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/Existing approved\/rejected bonus/);
      expect(await sets(b)).toBe(0);
    }));
});

describe("category target allocation", () => {
  it("saves once, replays the identical split and refuses a different one", () =>
    withFactoryWorld(async (w) => {
      const { b, worker, keys } = await setup(w);
      const allocations = keys.map((categoryKey, i) => ({ categoryKey, targetBales: i === 0 ? 1.5 : 2.5 }));
      const first = await save(w, { workerId: worker, allocations });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body).toMatchObject({
        replayed: false,
        workerId: worker,
        categoryCount: 2,
        payoutCalculated: false,
        accountingPosted: false,
      });
      const rows = await b.q(
        `SELECT category_key, credited_bales::float8 AS credited, target_bales::float8 AS target
           FROM factory_target_bonus_category_allocations WHERE allocation_set_id = $1 ORDER BY category_key`,
        [first.body.allocationSetId]
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.credited === 2)).toBe(true);

      const replay = await save(w, { workerId: worker, allocations });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ replayed: true, allocationSetId: first.body.allocationSetId });

      const changed = await save(w, {
        workerId: worker,
        allocations: keys.map((categoryKey) => ({ categoryKey, targetBales: 2 })),
      });
      expect(changed.status).toBe(409);
      expect(changed.body.message).toMatch(/historical snapshots are immutable/);
      expect(await sets(b)).toBe(1);
    }));
});
