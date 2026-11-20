/**
 * Fixed Production Planner routes
 * (server/routes/factory/raw-stock/fixedProductionPlannerRoutes.ts) over HTTP
 * in one rolled-back factory company per test: the empty default read, role
 * refusals, every allocation-key and quantity refusal, another company's
 * supplier or category, save/lock, the stale-revision and locked-plan
 * compare-and-set refusals, and unlock.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/raw-stock/fixed-production-planner";

const plan = async (w: FactoryWorld) =>
  w.q<{ revision: number; is_locked: boolean }>(
    `SELECT revision, is_locked FROM factory_fixed_production_plans WHERE company_id = $1`,
    [w.companyId]
  );

describe("fixed production planner", () => {
  it("reads an empty default plan and refuses non-editor roles", () =>
    withFactoryWorld(async (w) => {
      const empty = await w.agent.get(BASE);
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ allocations20t: {}, locked: false, revision: 0, updatedAt: null, updatedBy: null });
      const manager = await w.agentFor("Manager");
      expect((await manager.post(`${BASE}/save`).send({ allocations20t: {}, expectedRevision: 0 })).status).toBe(403);
      expect((await manager.post(`${BASE}/unlock`).send({ expectedRevision: 1 })).status).toBe(403);
    }));

  it("refuses malformed bodies, keys and quantities and foreign suppliers without writing", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}X`]
      );
      const foreignSupplier = await w.one(
        `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'Foreign') RETURNING id`,
        [other]
      );
      const foreignCategory = await w.one(
        `INSERT INTO factory_supplier_categories (company_id, name) VALUES ($1, 'Foreign Cat') RETURNING id`,
        [other]
      );
      const save = (body: Record<string, unknown>) => w.agent.post(`${BASE}/save`).send(body);
      for (const body of [
        { allocations20t: null, expectedRevision: 0 },
        { allocations20t: [], expectedRevision: 0 },
        { allocations20t: "x", expectedRevision: 0 },
        { allocations20t: {}, expectedRevision: -1 },
        { allocations20t: {}, expectedRevision: 1.5 },
      ]) {
        expect((await save(body)).body.message, JSON.stringify(body)).toMatch(/Invalid allocations/);
      }
      const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i + 1), 1]));
      expect((await save({ allocations20t: many, expectedRevision: 0 })).body.message).toMatch(/Too many/);
      for (const allocations20t of [
        { "0": 1 },
        { "cat:0": 1 },
        { abc: 1 },
        { "1": "2" },
        { "1": -1 },
        { "1": 1.2345 },
        { "1": 1e21 },
      ]) {
        const res = await save({ allocations20t, expectedRevision: 0 });
        expect(res.status, JSON.stringify(allocations20t)).toBe(400);
        expect(res.body.message).toMatch(/Invalid 20-ton quantity/);
      }
      for (const key of [String(foreignSupplier), `cat:${foreignCategory}`]) {
        const res = await save({ allocations20t: { [key]: 2 }, expectedRevision: 0 });
        expect(res.status, key).toBe(400);
        expect(res.body.message).toMatch(/do not belong/);
      }
      expect(await plan(w)).toEqual([]);
    }));

  it("saves and locks, refuses stale or locked saves, unlocks once and saves again", () =>
    withFactoryWorld(async (w) => {
      const supplier = await w.one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'Own') RETURNING id`, [
        w.companyId,
      ]);
      const category = await w.one(
        `INSERT INTO factory_supplier_categories (company_id, name) VALUES ($1, 'Own Cat') RETURNING id`,
        [w.companyId]
      );
      const allocations20t = { [String(supplier)]: 2.5, [`cat:${category}`]: 1, "cat:uncategorized": 0 };
      const saved = await w.agent.post(`${BASE}/save`).send({ allocations20t, expectedRevision: 0 });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ allocations20t, locked: true, revision: 1, updatedBy: w.userId });

      const locked = await w.agent.post(`${BASE}/save`).send({ allocations20t: {}, expectedRevision: 1 });
      expect(locked.status).toBe(409);
      for (const expectedRevision of [0, -1, 1.5]) {
        expect((await w.agent.post(`${BASE}/unlock`).send({ expectedRevision })).status).toBe(400);
      }
      expect((await w.agent.post(`${BASE}/unlock`).send({ expectedRevision: 7 })).status).toBe(409);
      const unlocked = await w.agent.post(`${BASE}/unlock`).send({ expectedRevision: 1 });
      expect(unlocked.status).toBe(200);
      expect(unlocked.body).toMatchObject({ locked: false, revision: 2 });
      expect((await w.agent.post(`${BASE}/unlock`).send({ expectedRevision: 2 })).status).toBe(409);

      const stale = await w.agent.post(`${BASE}/save`).send({ allocations20t: {}, expectedRevision: 1 });
      expect(stale.status).toBe(409);
      const again = await w.agent.post(`${BASE}/save`).send({ allocations20t: {}, expectedRevision: 2 });
      expect(again.body).toMatchObject({ allocations20t: {}, locked: true, revision: 3 });
      const read = await w.agent.get(BASE);
      expect(read.body).toMatchObject({ locked: true, revision: 3 });
      expect(await plan(w)).toEqual([{ revision: 3, is_locked: true }]);
    }));
});
