/**
 * Production Targets worker links (list, link, unlink) through the real app in
 * one rolled-back transaction: date and worker-count validation, bad bale
 * targets, finalized production history, workers of another company or off
 * the planner roster, a successful link with its shared target, unlinking
 * another company's link, an unlink before the start date and an unlink that
 * splits a blank target.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/staff-tracking/production-worker-links";

async function roster(w: FactoryWorld, names: string[], companyId = w.companyId) {
  const ids: number[] = [];
  for (const name of names) {
    ids.push(
      await w.one(`INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, $2, TRUE) RETURNING id`, [
        companyId,
        name,
      ])
    );
  }
  await w.q(`INSERT INTO factory_worker_categories (company_id, name, worker_ids) VALUES ($1, 'Pressing', $2::jsonb)`, [
    companyId,
    JSON.stringify(ids),
  ]);
  return ids;
}

const link = (w: FactoryWorld, body: Record<string, unknown>) => w.agent.post(BASE).send(body);
const links = async (w: FactoryWorld, companyId = w.companyId) =>
  w.q(`SELECT id FROM factory_worker_production_links WHERE company_id = $1`, [companyId]);

describe("production worker links", () => {
  it("validates the list date and the link request", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get(`${BASE}?asOf=bad`)).status).toBe(400);
      const [a, b] = await roster(w, ["Amina", "Bilal"]);
      expect((await link(w, { effectiveFrom: "2026-13", workerIds: [a, b] })).status).toBe(400);
      const one = await link(w, { effectiveFrom: "2026-06-01", workerIds: [a, a, "x"] });
      expect(one.body.message).toBe("Link between 2 and 10 workers");
      const badTarget = await link(w, { effectiveFrom: "2026-06-01", workerIds: [a, b], targetBales: "-3" });
      expect(badTarget.status).toBe(400);
      expect(await links(w)).toHaveLength(0);
    }));

  it("refuses finalized history, foreign workers and workers off the planner roster", () =>
    withFactoryWorld(async (w) => {
      const [a, b] = await roster(w, ["Amina", "Bilal"]);
      const loose = await w.one(
        `INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, 'Loose', TRUE) RETURNING id`,
        [w.companyId]
      );
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      const [foreign] = await roster(w, ["Stranger"], other);
      const cross = await link(w, { effectiveFrom: "2026-06-01", workerIds: [a, foreign] });
      expect(cross.status).toBe(400);
      const offRoster = await link(w, { effectiveFrom: "2026-06-01", workerIds: [a, loose] });
      expect([offRoster.status, offRoster.body.message]).toEqual([
        400,
        "Worker is not assigned to a saved Production Planner group",
      ]);
      await w.q(
        `INSERT INTO factory_staff_tracking_period_closures (company_id, page_type, period_type, period_start, period_end)
         VALUES ($1, 'production', 'daily', '2026-06-10', '2026-06-10')`,
        [w.companyId]
      );
      const closed = await link(w, { effectiveFrom: "2026-06-01", workerIds: [a, b] });
      expect(closed.status).toBe(409);
      const closedUnlink = await w.agent.post(`${BASE}/1/unlink`).send({ effectiveTo: "2026-06-05" });
      expect(closedUnlink.status).toBe(409);
      expect(await links(w)).toHaveLength(0);
    }));

  it("links workers with a shared target, lists them and unlinks with a blank-target split", () =>
    withFactoryWorld(async (w) => {
      const [a, b] = await roster(w, ["Amina", "Bilal"]);
      // Legacy planner rows store worker ids as a JSON text string; unreadable text counts as empty.
      const c = await w.one(
        `INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, 'Chidi', TRUE) RETURNING id`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_worker_categories (company_id, name, worker_ids)
         VALUES ($1, 'Legacy', to_jsonb($2::text)), ($1, 'Broken', to_jsonb('not json'::text)), ($1, 'Object', '{"a":1}'::jsonb)`,
        [w.companyId, JSON.stringify([c])]
      );
      const res = await link(w, { effectiveFrom: "2026-06-01", workerIds: [b, a, String(a)], targetBales: "12" });
      expect(res.status).toBe(200);
      expect(res.body.links).toEqual([
        expect.objectContaining({
          id: res.body.linkId,
          effectiveFrom: "2026-06-01",
          effectiveTo: null,
          sharedTargetBales: 12,
          members: [expect.objectContaining({ workerId: a }), expect.objectContaining({ workerId: b })],
        }),
      ]);
      const blank = await link(w, { effectiveFrom: "2026-06-02", workerIds: [b, c], targetBales: "" });
      expect(blank.status).toBe(200);
      const listed = await w.agent.get(`${BASE}?asOf=2026-06-01`);
      expect(listed.body.links.map((l: { id: number }) => l.id)).toEqual([res.body.linkId]);

      const linkId = blank.body.linkId;
      const early = await w.agent.post(`${BASE}/${linkId}/unlink`).send({ effectiveTo: "2026-05-01" });
      expect(early.status).toBe(500);
      expect(early.body.message).toMatch(/before the link start date/);
      const badSplit = await w.agent
        .post(`${BASE}/${linkId}/unlink`)
        .send({ effectiveTo: "2026-06-03", allocations: [{ workerId: b, targetBales: 1 }] });
      expect([badSplit.status, badSplit.body.message]).toEqual([400, "Cannot split a blank fixed target"]);
      expect((await w.agent.post(`${BASE}/abc/unlink`).send({ effectiveTo: "2026-06-03" })).status).toBe(400);
      const ok = await w.agent.post(`${BASE}/${linkId}/unlink`).send({ effectiveTo: "2026-06-03", allocations: [] });
      expect(ok.status).toBe(200);
      const [row] = await w.q(`SELECT effective_to::text AS t FROM factory_worker_production_links WHERE id = $1`, [
        linkId,
      ]);
      expect(row.t).toBe("2026-06-03");
    }));

  it("does not unlink another company's link", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}P`]
      );
      const foreignLink = await w.one(
        `INSERT INTO factory_worker_production_links (company_id, effective_from) VALUES ($1, '2026-06-01') RETURNING id`,
        [other]
      );
      const res = await w.agent.post(`${BASE}/${foreignLink}/unlink`).send({ effectiveTo: "2026-06-05" });
      expect([res.status, res.body.message]).toEqual([404, "Worker link not found"]);
      const [row] = await w.q(`SELECT effective_to FROM factory_worker_production_links WHERE id = $1`, [foreignLink]);
      expect(row.effective_to).toBeNull();
    }));
});
