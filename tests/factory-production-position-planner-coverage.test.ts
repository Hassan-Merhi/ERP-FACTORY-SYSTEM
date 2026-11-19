import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const PLANNER = "/api/factory/production-position-planner";
const DAY = "2026-03-10";

async function seedPositions(world: FactoryWorld) {
  const position = (name: string, active = true) =>
    world.one(`INSERT INTO factory_production_positions (company_id, name, active) VALUES ($1, $2, $3) RETURNING id`, [
      world.companyId,
      name,
      active,
    ]);
  const pressing = await position("Pressing");
  const sorting = await position("Sorting");
  const retired = await position("Retired", false);
  const worker = (name: string) =>
    world.one(`INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`, [
      world.companyId,
      name,
    ]);
  const amina = await worker("Amina");
  const bilal = await worker("Bilal");
  await world.q(
    `INSERT INTO factory_production_position_rules
       (company_id, position_id, effective_from, effective_to, target_bales, bonus_per_extra_bale, bonus_enabled)
     VALUES ($1, $2, '2026-01-01', NULL, 3, 2.5, TRUE),
            ($1, $3, '2026-01-01', '2026-03-01', 50, 9, TRUE)`,
    [world.companyId, pressing, sorting]
  );
  await world.q(
    `INSERT INTO factory_production_position_memberships (company_id, position_id, worker_id, effective_from)
     VALUES ($1, $2, $3, '2026-01-01'), ($1, $2, $4, '2026-01-01')`,
    [world.companyId, pressing, amina, bilal]
  );
  let seq = 0;
  const bale = async (positionId: number | null, workerId: number | null, status = "IN_STOCK") => {
    const baleId = await world.one(
      `INSERT INTO factory_bales (company_id, reference_number, bale_code, status, weight_kg, stock_entry_date)
       VALUES ($1, $2, $2, $3, 50, $4) RETURNING id`,
      [world.companyId, `${world.tag}-B${++seq}`, status, DAY]
    );
    await world.q(
      `INSERT INTO factory_bale_production_attributions (company_id, bale_id, stock_entry_date, production_position_id, worker_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [world.companyId, baleId, DAY, positionId, workerId]
    );
  };
  for (let index = 0; index < 5; index += 1) await bale(pressing, amina);
  await bale(pressing, amina, "AVAILABLE"); // not an eligible production status
  await bale(null, bilal);
  return { pressing, sorting, retired, amina, bilal };
}

describe("production position planner", () => {
  it("builds an unsaved plan from effective rules, members and attributed bales", async () => {
    await withFactoryWorld(async (world) => {
      const { pressing, sorting, amina, bilal } = await seedPositions(world);
      const res = await world.agent.get(`${PLANNER}/${DAY}`);
      expect(res.status, res.text).toBe(200);
      expect(res.body.plan).toEqual({ id: null, planDate: DAY, notes: "", saved: false });
      expect(res.body.entries.map((entry: { positionName: string }) => entry.positionName)).toEqual([
        "Pressing",
        "Sorting",
      ]);
      const [press, sort] = res.body.entries;
      expect(press).toMatchObject({
        positionId: pressing,
        targetBales: 3,
        bonusPerExtraBale: 2.5,
        bonusEnabled: true,
        actualBales: 5,
        memberCount: 2,
        extraBales: 2,
        bonusPool: 5,
        targetMet: true,
        saved: false,
        members: [
          { workerId: amina, workerName: "Amina" },
          { workerId: bilal, workerName: "Bilal" },
        ],
      });
      expect(sort).toMatchObject({
        positionId: sorting,
        targetBales: 0,
        bonusEnabled: false,
        actualBales: 0,
        targetMet: false,
      });
      expect(res.body.summary).toEqual({
        totalTarget: 3,
        totalActual: 5,
        totalExtra: 2,
        totalBonusPool: 5,
        unattributedBales: 1,
      });
    });
  });

  it("passes linked worker groups to the bonus preview and saves an empty plan", async () => {
    await withFactoryWorld(async (world) => {
      const { amina, bilal } = await seedPositions(world);
      const linkId = await world.one(
        `INSERT INTO factory_worker_production_links (company_id, effective_from) VALUES ($1, '2026-01-01') RETURNING id`,
        [world.companyId]
      );
      await world.q(
        `INSERT INTO factory_worker_production_link_members (company_id, link_id, worker_id) VALUES ($1, $2, $3), ($1, $2, $4)`,
        [world.companyId, linkId, amina, bilal]
      );
      const res = await world.agent.get(`${PLANNER}/${DAY}`);
      expect(res.status).toBe(200);
      const press = res.body.entries.find((entry: { positionName: string }) => entry.positionName === "Pressing");
      expect(press.bonusPool).toBe(5);
      expect(press.allocations.map((row: { workerId: number }) => row.workerId).sort()).toEqual([amina, bilal].sort());

      const empty = await world.agent.post(`${PLANNER}/${DAY}`).send({ entries: [], notes: 42 });
      expect(empty.status).toBe(200);
      expect(empty.body.plan).toMatchObject({ saved: false, notes: "" });
      expect(empty.body.plan.id).toEqual(expect.any(Number));
    });
  });

  it("validates dates and Admin authorization", async () => {
    await withFactoryWorld(async (world) => {
      expect((await world.agent.get(`${PLANNER}/10-03-2026`)).status).toBe(400);
      expect((await world.agent.post(`${PLANNER}/2026-3-1`).send({ entries: [] })).status).toBe(400);
      expect((await world.agent.get(`${PLANNER}/2026-3-1/copy-previous`)).status).toBe(400);
      const manager = await world.agentFor("Manager");
      const denied = await manager.post(`${PLANNER}/${DAY}`).send({ entries: [] });
      expect(denied.status).toBe(403);
      expect(denied.body.requiresAdminOverride).toBe(true);
      const plans = await world.q(`SELECT 1 FROM factory_production_plans WHERE company_id = $1`, [world.companyId]);
      expect(plans).toEqual([]);
    });
  });

  it("rejects invalid plan entries and foreign positions without saving", async () => {
    await withFactoryWorld(async (world) => {
      const { pressing } = await seedPositions(world);
      const save = (entries: unknown) => world.agent.post(`${PLANNER}/${DAY}`).send({ entries });
      const cases: Array<[unknown, RegExp]> = [
        ["nope", /entries must be an array/],
        [[{ positionId: 0 }], /Invalid production position/],
        [
          [
            { positionId: pressing, targetBales: 1, bonusPerExtraBale: 0 },
            { positionId: pressing, targetBales: 1, bonusPerExtraBale: 0 },
          ],
          /Duplicate/,
        ],
        [[{ positionId: pressing, targetBales: 1.5, bonusPerExtraBale: 0 }], /whole number/],
        [[{ positionId: pressing, targetBales: 1, bonusPerExtraBale: -1 }], /0 or more/],
        [[{ positionId: pressing + 100000, targetBales: 1, bonusPerExtraBale: 0 }], /another company or do not exist/],
      ];
      for (const [entries, message] of cases) {
        const res = await save(entries);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(message);
      }
      const plans = await world.q(`SELECT 1 FROM factory_production_plans WHERE company_id = $1`, [world.companyId]);
      expect(plans).toEqual([]);
    });
  });

  it("saves a plan snapshot, replaces it on resave and copies it forward", async () => {
    await withFactoryWorld(async (world) => {
      const { pressing, retired } = await seedPositions(world);
      const saved = await world.agent.post(`${PLANNER}/${DAY}`).send({
        notes: "Rush order",
        entries: [
          { positionId: pressing, targetBales: 4, bonusPerExtraBale: 1, bonusEnabled: true },
          { positionId: retired, targetBales: 2, bonusPerExtraBale: 0 },
        ],
      });
      expect(saved.status, saved.text).toBe(200);
      expect(saved.body.plan).toMatchObject({ notes: "Rush order", saved: true });
      const byName = Object.fromEntries(
        saved.body.entries.map((entry: { positionName: string }) => [entry.positionName, entry])
      );
      expect(byName.Pressing).toMatchObject({
        saved: true,
        targetBales: 4,
        extraBales: 1,
        bonusPool: 1,
        memberCount: 2,
      });
      expect(byName.Retired).toMatchObject({ saved: true, targetBales: 2, members: [] });
      expect(byName.Sorting).toMatchObject({ saved: false });

      const resaved = await world.agent
        .post(`${PLANNER}/${DAY}`)
        .send({ entries: [{ positionId: pressing, targetBales: 6, bonusPerExtraBale: 1 }] });
      expect(resaved.status).toBe(200);
      const rows = await world.q(
        `SELECT e.target_bales, p.notes FROM factory_production_position_plan_entries e
           JOIN factory_production_plans p ON p.id = e.plan_id WHERE e.company_id = $1`,
        [world.companyId]
      );
      expect(rows).toEqual([{ target_bales: 6, notes: null }]);

      const copied = await world.agent.get(`${PLANNER}/2026-03-11/copy-previous`);
      expect(copied.status).toBe(200);
      expect(copied.body.fromDate).toBe(DAY);
      const copiedPressing = copied.body.entries.find((entry: { positionId: number }) => entry.positionId === pressing);
      expect(copiedPressing).toMatchObject({ targetBales: 6, bonusEnabled: false });

      const none = await world.agent.get(`${PLANNER}/${DAY}/copy-previous`);
      expect(none.body).toEqual({ fromDate: null, notes: "", entries: [] });
    });
  });
});
