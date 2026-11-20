/**
 * Factory production positions (POS financial bonus rules): admin-only writes,
 * worker validation, rule versioning by effective date (same-day update,
 * later-day new version, earlier-day refusal), membership replacement,
 * history, listing and archive. One rolled-back transaction per test.
 */
import { describe, expect, it } from "vitest";

import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/production-positions";

async function worker(w: FactoryWorld, name: string, active = true, companyId = w.companyId) {
  return w.one(`INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, $2, $3) RETURNING id`, [
    companyId,
    `${w.tag} ${name}`,
    active,
  ]);
}

async function create(w: FactoryWorld, body: Record<string, unknown>) {
  return w.agent.post(URL).send({ name: `${w.tag} Press`, targetBales: 10, bonusPerExtraBale: 2, ...body });
}

async function positionCount(w: FactoryWorld) {
  const [row] = await w.q(`SELECT COUNT(*)::int AS n FROM factory_production_positions WHERE company_id = $1`, [
    w.companyId,
  ]);
  return row.n;
}

describe("production position refusals", () => {
  it("refuses non-admin writes and writes nothing", async () => {
    await withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      const res = await manager.post(URL).send({ name: "X", targetBales: 1, bonusPerExtraBale: 1 });
      expect(res.status).toBe(403);
      expect(res.body.requiresAdminOverride).toBe(true);
      expect((await manager.patch(`${URL}/1`).send({ name: "Y" })).status).toBe(403);
      expect((await manager.delete(`${URL}/1`)).status).toBe(403);
      expect(await positionCount(w)).toBe(0);
    });
  });

  it("refuses invalid bodies, inactive or foreign workers and bad ids", async () => {
    await withFactoryWorld(async (w) => {
      expect((await create(w, { name: "" })).status).toBe(400);
      expect((await create(w, { targetBales: -1 })).status).toBe(400);
      const inactive = await worker(w, "Idle", false);
      const res = await create(w, { workerIds: [inactive] });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("One or more selected workers are inactive or belong to another company");
      expect(await positionCount(w)).toBe(0);
      expect((await w.agent.patch(`${URL}/abc`).send({ name: "Y" })).status).toBe(400);
      expect((await w.agent.delete(`${URL}/abc`)).status).toBe(400);
      expect((await w.agent.get(`${URL}/abc/history`)).status).toBe(400);
    });
  });

  it("returns 404 for unknown positions", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.patch(`${URL}/999999999`).send({ name: "Y" })).status).toBe(404);
      expect((await w.agent.delete(`${URL}/999999999`)).status).toBe(404);
      expect((await w.agent.get(`${URL}/999999999/history`)).status).toBe(404);
    });
  });

  it("refuses an empty patch without changing anything", async () => {
    await withFactoryWorld(async (w) => {
      const anna = await worker(w, "Anna");
      const created = await create(w, { bonusEnabled: true, workerIds: [anna], effectiveFrom: "2026-01-01" });
      const empty = await w.agent.patch(`${URL}/${created.body.id}`).send({});
      expect(empty.status).toBe(400);
      expect(empty.body.message).toContain("No changes supplied");
      const history = await w.agent.get(`${URL}/${created.body.id}/history`);
      expect(history.body.rules).toHaveLength(1);
      expect(history.body.memberships.map((m: { workerId: number }) => m.workerId)).toEqual([anna]);
    });
  });
});

describe("production position partial updates", () => {
  it("keeps bonus, active and members on a rename-only patch", async () => {
    await withFactoryWorld(async (w) => {
      const anna = await worker(w, "Anna");
      const created = await create(w, { bonusEnabled: true, workerIds: [anna], effectiveFrom: "2026-01-01" });
      expect(created.body).toMatchObject({ bonusEnabled: true, active: true, workerIds: [anna] });
      const renamed = await w.agent
        .patch(`${URL}/${created.body.id}`)
        .send({ name: `${w.tag} Renamed`, effectiveFrom: "2026-01-05" });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        name: `${w.tag} Renamed`,
        bonusEnabled: true,
        active: true,
        workerIds: [anna],
        ruleEffectiveFrom: "2026-01-01",
      });
    });
  });

  it("still applies explicit bonus, active and member values", async () => {
    await withFactoryWorld(async (w) => {
      const anna = await worker(w, "Anna");
      const ben = await worker(w, "Ben");
      const created = await create(w, { bonusEnabled: true, workerIds: [anna], effectiveFrom: "2026-01-01" });
      const id = created.body.id;
      let res = await w.agent
        .patch(`${URL}/${id}`)
        .send({ bonusEnabled: false, workerIds: [ben], effectiveFrom: "2026-01-01" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ bonusEnabled: false, active: true, workerIds: [ben] });
      res = await w.agent.patch(`${URL}/${id}`).send({ workerIds: [], effectiveFrom: "2026-01-02" });
      expect(res.body).toMatchObject({ bonusEnabled: false, workerIds: [] });
      res = await w.agent.patch(`${URL}/${id}`).send({ active: false, effectiveFrom: "2026-01-03" });
      expect(res.body).toMatchObject({ active: false, workerIds: [] });
    });
  });
});

describe("production position lifecycle", () => {
  it("creates, versions rules by effective date, replaces members and archives", async () => {
    await withFactoryWorld(async (w) => {
      const anna = await worker(w, "Anna");
      const ben = await worker(w, "Ben");
      const created = await create(w, { workerIds: [anna, anna], effectiveFrom: "2026-01-01", bonusEnabled: true });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ targetBales: 10, bonusEnabled: true, workerIds: [anna] });
      const id = created.body.id;

      // Same effective date updates the rule in place.
      let res = await w.agent.patch(`${URL}/${id}`).send({ targetBales: 12, effectiveFrom: "2026-01-01" });
      expect(res.status).toBe(200);
      expect(res.body.targetBales).toBe(12);
      // A later date closes the current rule and opens a new one, swapping members.
      res = await w.agent
        .patch(`${URL}/${id}`)
        .send({ bonusPerExtraBale: 3, workerIds: [ben], effectiveFrom: "2026-02-01" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        bonusPerExtraBale: "3.0000",
        workerIds: [ben],
        ruleEffectiveFrom: "2026-02-01",
      });
      // An earlier date than the current rule is refused.
      res = await w.agent.patch(`${URL}/${id}`).send({ targetBales: 1, effectiveFrom: "2026-01-15" });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Effective date cannot be before the current rule start (2026-02-01)");
      // A name-only change keeps the rule version.
      res = await w.agent.patch(`${URL}/${id}`).send({ name: `${w.tag} Renamed`, effectiveFrom: "2026-02-10" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe(`${w.tag} Renamed`);

      const history = await w.agent.get(`${URL}/${id}/history`);
      expect(history.status).toBe(200);
      expect(history.body.rules.map((r: { effectiveFrom: string }) => r.effectiveFrom)).toEqual([
        "2026-02-01",
        "2026-01-01",
      ]);
      expect(history.body.memberships.length).toBeGreaterThanOrEqual(2);

      const list = await w.agent.get(`${URL}?asOf=2026-01-10`);
      expect(list.status).toBe(200);
      expect(list.body.find((p: { id: number }) => p.id === id)).toMatchObject({ targetBales: 12 });
      expect((await w.agent.get(URL)).status).toBe(200);

      const archived = await w.agent.delete(`${URL}/${id}`);
      expect(archived.body).toEqual({ ok: true, archived: true });
      const [row] = await w.q(`SELECT active FROM factory_production_positions WHERE id = $1`, [id]);
      expect(row.active).toBe(false);
    });
  });

  it("creates an inactive position without members and deactivates members on patch", async () => {
    await withFactoryWorld(async (w) => {
      const anna = await worker(w, "Anna");
      const created = await create(w, { active: false, workerIds: [anna], effectiveFrom: "2026-03-01" });
      expect(created.status).toBe(201);
      expect(created.body.workerIds).toEqual([]);
      const res = await w.agent.patch(`${URL}/${created.body.id}`).send({ active: true, effectiveFrom: "2026-03-01" });
      expect(res.status).toBe(200);
      const off = await w.agent
        .patch(`${URL}/${created.body.id}`)
        .send({ active: false, workerIds: [anna], effectiveFrom: "2026-03-05" });
      expect(off.body).toMatchObject({ active: false, workerIds: [] });
    });
  });

  it("writes a first rule version for a position that never had one", async () => {
    await withFactoryWorld(async (w) => {
      const id = await w.one(
        `INSERT INTO factory_production_positions (company_id, name, active, created_by) VALUES ($1, $2, true, 'seed') RETURNING id`,
        [w.companyId, `${w.tag} Bare`]
      );
      const res = await w.agent.patch(`${URL}/${id}`).send({ name: `${w.tag} Bare 2`, effectiveFrom: "2026-04-01" });
      expect(res.status).toBe(200);
      expect(res.body.ruleEffectiveFrom).toBe("2026-04-01");
    });
  });
});
