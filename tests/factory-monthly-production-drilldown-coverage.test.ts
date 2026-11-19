import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const WORKERS = "/api/factory/monthly-production-matrix/workers";
const BALES = "/api/factory/monthly-production-matrix/bales";

async function seedProduction(world: FactoryWorld) {
  const productId = await world.one(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, 'Mixed Cotton', 'ART-1') RETURNING id`,
    [world.companyId, `${world.tag}P`]
  );
  const otherProductId = await world.one(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, 'Wool', 'ART-2') RETURNING id`,
    [world.companyId, `${world.tag}Q`]
  );
  const amina = await world.one(
    `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, 'Amina') RETURNING id`,
    [world.companyId]
  );
  const bilal = await world.one(
    `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, 'Bilal') RETURNING id`,
    [world.companyId]
  );
  let seq = 0;
  const bale = (values: {
    productId: number | null;
    article?: string;
    worker: number | null;
    workerName?: string | null;
    date: string;
    weight: number;
    status?: string;
  }) =>
    world.q(
      `INSERT INTO factory_bales
         (company_id, reference_number, bale_code, product_id, article_code, finalized_by, worker_name,
          stock_entry_date, weight_kg, status, erp_location_id, quantity)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)`,
      [
        world.companyId,
        `${world.tag}-${++seq}`,
        values.productId,
        values.article ?? "ART-1",
        values.worker,
        values.workerName ?? null,
        values.date,
        values.weight,
        values.status ?? "AVAILABLE",
        world.locationId,
      ]
    );
  await bale({ productId, worker: amina, date: "2026-01-05", weight: 100 });
  await bale({ productId, worker: amina, date: "2026-01-05", weight: 110 });
  await bale({ productId, worker: amina, date: "2026-02-03", weight: 90, status: "SOLD" });
  // Matched by article code when the bale has no product id; worker name stored on the bale wins.
  await bale({ productId: null, worker: bilal, workerName: "Bilal B.", date: "2026-01-20", weight: 80 });
  await bale({ productId, worker: null, date: "2026-01-09", weight: 70 });
  // Excluded: removed, other product, outside the requested months.
  await bale({ productId, worker: amina, date: "2026-01-06", weight: 999, status: "REMOVED" });
  await bale({ productId: otherProductId, article: "ART-2", worker: amina, date: "2026-01-06", weight: 999 });
  await bale({ productId, worker: amina, date: "2025-12-31", weight: 999 });
  return { productId, amina, bilal };
}

describe("monthly production drill-down: workers", () => {
  it("aggregates qualifying bales per worker and month", async () => {
    await withFactoryWorld(async (world) => {
      const { productId, amina, bilal } = await seedProduction(world);
      const res = await world.agent.get(WORKERS).query({ productId, months: "2026-01,2026-02,2026-01" });
      expect(res.status, res.text).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.product).toEqual({ id: productId, name: "Mixed Cotton", articleCode: "ART-1" });
      expect(res.body.months).toEqual(["2026-01", "2026-02"]);
      expect(res.body.workers).toEqual([
        {
          workerId: amina,
          workerName: "Amina",
          quantity: 3,
          weightKg: "300",
          monthlyBales: { "2026-01": 2, "2026-02": 1 },
        },
        {
          workerId: bilal,
          workerName: "Bilal B.",
          quantity: 1,
          weightKg: "80",
          monthlyBales: { "2026-01": 1, "2026-02": 0 },
        },
        {
          workerId: 0,
          workerName: "Unassigned",
          quantity: 1,
          weightKg: "70",
          monthlyBales: { "2026-01": 1, "2026-02": 0 },
        },
      ]);
      expect(res.body.totalBales).toBe(5);
      expect(res.body.totalWeightKg).toBe(450);
    });
  });

  it("validates the period and returns 404 for unknown or foreign products", async () => {
    await withFactoryWorld(async (world) => {
      const { productId } = await seedProduction(world);
      for (const invalid of [
        {},
        { productId: "0", months: "2026-01" },
        { productId: String(productId), months: "2026-13" },
        { productId: String(productId) },
      ]) {
        const res = await world.agent.get(WORKERS).query({ ...invalid });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe("Invalid product or months");
      }
      const missing = await world.agent.get(WORKERS).query({ productId: productId + 100000, months: "2026-01" });
      expect(missing.status).toBe(404);
    });
  });

  it("denies a user whose Factory page list excludes the matrix", async () => {
    await withFactoryWorld(async (world) => {
      const { productId } = await seedProduction(world);
      const cashier = await world.agentFor("Manager");
      await world.q(
        `INSERT INTO factory_user_page_access (company_id, user_id, page_key)
         SELECT company_id, user_id, 'factory/attendance' FROM user_company_roles
          WHERE company_id = $1 AND role = 'Manager'`,
        [world.companyId]
      );
      const workers = await cashier.get(WORKERS).query({ productId, months: "2026-01" });
      expect(workers.status).toBe(403);
      const bales = await cashier.get(BALES).query({ productId, months: "2026-01", workerId: "0" });
      expect(bales.status).toBe(403);
    });
  });
});

describe("monthly production drill-down: bales", () => {
  it("returns condensed daily groups for one worker", async () => {
    await withFactoryWorld(async (world) => {
      const { productId, amina } = await seedProduction(world);
      const res = await world.agent.get(BALES).query({ productId, months: "2026-01,2026-02", workerId: String(amina) });
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({
        workerId: amina,
        view: "condensed",
        page: 1,
        limit: 100,
        totalBales: 3,
        totalRows: 2,
      });
      expect(res.body.totalWeightKg).toBe("300.000");
      expect(res.body.groups).toEqual([
        { date: "2026-02-03", productName: "Mixed Cotton", quantity: 1, weightKg: "90.000" },
        { date: "2026-01-05", productName: "Mixed Cotton", quantity: 2, weightKg: "210.000" },
      ]);
      expect(res.body.bales).toEqual([]);
    });
  });

  it("returns detailed bales for unassigned production and pages past the end", async () => {
    await withFactoryWorld(async (world) => {
      const { productId } = await seedProduction(world);
      const detailed = await world.agent
        .get(BALES)
        .query({ productId, months: "2026-01", workerId: "0", view: "detailed" });
      expect(detailed.status).toBe(200);
      expect(detailed.body.totalRows).toBe(1);
      expect(detailed.body.bales).toEqual([
        expect.objectContaining({
          weightKg: "70.000",
          status: "AVAILABLE",
          stockEntryDate: "2026-01-09",
          workerName: null,
          locationName: "Yard",
          quantity: 1,
        }),
      ]);
      expect(detailed.body.groups).toEqual([]);

      const empty = await world.agent
        .get(BALES)
        .query({ productId, months: "2026-01", workerId: "0", view: "detailed", page: "2" });
      expect(empty.body.page).toBe(2);
      expect(empty.body.bales).toEqual([]);
      const badPage = await world.agent.get(BALES).query({ productId, months: "2026-01", workerId: "0", page: "x" });
      expect(badPage.body.page).toBe(1);

      await world.q(
        `UPDATE factory_bales SET category = 'Cotton', grade = 'A', worker_name = 'Temp', finalized_at = '2026-01-09T10:00:00Z',
                stock_entry_date = NULL, created_at = '2026-01-10T08:00:00Z'
          WHERE company_id = $1 AND finalized_by IS NULL`,
        [world.companyId]
      );
      const enriched = await world.agent
        .get(BALES)
        .query({ productId, months: "2026-01", workerId: "0", view: "detailed" });
      expect(enriched.body.bales).toEqual([
        expect.objectContaining({ category: "Cotton", grade: "A", workerName: "Temp", stockEntryDate: null }),
      ]);
      expect(enriched.body.bales[0].finalizedAt).not.toBeNull();
    });
  });

  it("validates worker, view and product", async () => {
    await withFactoryWorld(async (world) => {
      const { productId } = await seedProduction(world);
      const invalidWorker = await world.agent.get(BALES).query({ productId, months: "2026-01", workerId: "-1" });
      expect(invalidWorker.status).toBe(400);
      expect((await world.agent.get(BALES).query({ productId, months: "2026-01" })).status).toBe(400);
      const invalidView = await world.agent
        .get(BALES)
        .query({ productId, months: "2026-01", workerId: "0", view: "pie" });
      expect(invalidView.body.message).toBe("Invalid bale view");
      const missing = await world.agent
        .get(BALES)
        .query({ productId: productId + 100000, months: "2026-01", workerId: "0" });
      expect(missing.status).toBe(404);
    });
  });
});
