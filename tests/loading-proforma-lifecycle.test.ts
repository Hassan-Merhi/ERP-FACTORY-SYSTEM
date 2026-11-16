import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p16load";
const ARTICLE = "P16-ARTICLE-A";
const UNRELATED_ARTICLE = "P16-ARTICLE-B";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let proformaId: number;
let orderOneId: number;
let orderTwoId: number;
const baleIds = new Map<string, number>();

async function createBale(code: string, articleCode: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_bales
       (company_id, bale_code, reference_number, article_code, product_name,
        erp_location_id, weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, $2, $3, $4, $5, '25.000', '1.0000000', '25.0000000', 'IN_STOCK')
     RETURNING id`,
    [ctx.companyId, code, articleCode, `${articleCode} Product`, ctx.locationId]
  );
  baleIds.set(code, Number(result.rows[0].id));
  return Number(result.rows[0].id);
}

async function scan(orderId: number, scanCode: string, overrides: Record<string, unknown> = {}) {
  return agent.post(`/api/factory/customer-orders/${orderId}/bales`).send({
    scanCode,
    locationId: ctx.locationId,
    ...overrides,
  });
}

async function loadedFactoryBaleIds(orderId: number): Promise<number[]> {
  const result = await pool.query<{ bale_id: number }>(
    `SELECT bale_id FROM customer_order_bales WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  return result.rows.map((row) => Number(row.bale_id));
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C`, `${TEST_PREFIX} Customer`]
  );
  customerId = Number(customer.rows[0].id);

  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, true)
     RETURNING id`,
    [ctx.companyId, customerId, `${TEST_PREFIX} reusable proforma`]
  );
  proformaId = Number(proforma.rows[0].id);
  await pool.query(
    `INSERT INTO customer_proforma_lines
       (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, $2, $3, 2, '12.00')`,
    [proformaId, ARTICLE, "Phase 16 requested product"]
  );

  const orders = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, '2026-09-14', 'LOADING', $3),
            ($1, $2, '2026-09-14', 'LOADING', $3)
     RETURNING id`,
    [ctx.companyId, customerId, proformaId]
  );
  orderOneId = Number(orders.rows[0].id);
  orderTwoId = Number(orders.rows[1].id);

  for (const code of ["P16-A1", "P16-A2", "P16-A3", "P16-A4", "P16-A5"]) {
    await createBale(code, ARTICLE);
  }
  await createBale("P16-B1", UNRELATED_ARTICLE);
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM customer_order_bale_removals WHERE order_id IN ($1, $2)`, [orderOneId, orderTwoId]);
  await pool.query(`DELETE FROM customer_order_bales WHERE order_id IN ($1, $2)`, [orderOneId, orderTwoId]);
  await pool.query(`DELETE FROM customer_order_expected_lines WHERE order_id IN ($1, $2)`, [orderOneId, orderTwoId]);
  await pool.query(`DELETE FROM customer_order_lines WHERE order_id IN ($1, $2)`, [orderOneId, orderTwoId]);
  await pool.query(`DELETE FROM customer_orders WHERE id IN ($1, $2)`, [orderOneId, orderTwoId]);
  await pool.query(`DELETE FROM customer_proforma_lines WHERE proforma_id = $1`, [proformaId]);
  await pool.query(`DELETE FROM customer_proformas WHERE id = $1`, [proformaId]);
  await pool.query(`DELETE FROM factory_bales WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 16 reusable proforma loading lifecycle", () => {
  it("keeps each loading isolated and enforces overload with an explicit second-scan bypass", async () => {
    expect((await scan(orderOneId, "P16-A1")).status).toBe(200);
    expect((await scan(orderOneId, "P16-A2")).status).toBe(200);

    const exceeded = await scan(orderOneId, "P16-A3");
    expect(exceeded.status).toBe(400);
    expect(exceeded.body.confirmationRequired).toBe(true);
    expect(exceeded.body.confirmationType).toBe("overload");
    expect(exceeded.body.overloaded).toBe(true);
    expect(exceeded.body.capacity.requestedQty).toBe(2);
    expect(exceeded.body.capacity.consumedQty).toBe(2);
    expect(exceeded.body.capacity.validationMode).toBe("reference");

    const bypassed = await scan(orderOneId, "P16-A3", { allowBypassOverload: true });
    expect(bypassed.status).toBe(200);
    expect(await loadedFactoryBaleIds(orderOneId)).toEqual([
      baleIds.get("P16-A1"),
      baleIds.get("P16-A2"),
      baleIds.get("P16-A3"),
    ]);

    // The same reusable proforma starts fresh for a separate loading. Order 1
    // being overloaded must not make Order 2 start overloaded.
    const secondLoadingFirst = await scan(orderTwoId, "P16-A4");
    const secondLoadingSecond = await scan(orderTwoId, "P16-A5");
    expect(secondLoadingFirst.status).toBe(200);
    expect(secondLoadingSecond.status).toBe(200);
    expect(await loadedFactoryBaleIds(orderTwoId)).toEqual([baleIds.get("P16-A4"), baleIds.get("P16-A5")]);
  }, 120_000);

  it("removing and rescanning a bale restores only this loading's capacity", async () => {
    const orderBale = await pool.query<{ id: number }>(
      `SELECT id FROM customer_order_bales WHERE order_id = $1 AND bale_id = $2`,
      [orderTwoId, baleIds.get("P16-A5")]
    );
    expect(orderBale.rowCount).toBe(1);

    const removed = await agent.delete(`/api/factory/customer-orders/${orderTwoId}/bales/${orderBale.rows[0].id}`);
    expect(removed.status).toBe(200);
    expect(await loadedFactoryBaleIds(orderTwoId)).toEqual([baleIds.get("P16-A4")]);

    const removalLog = await pool.query<{ id: number }>(
      `SELECT id FROM customer_order_bale_removals WHERE order_id = $1 AND bale_id = $2`,
      [orderTwoId, baleIds.get("P16-A5")]
    );
    expect(removalLog.rowCount).toBe(1);

    const rescanned = await scan(orderTwoId, "P16-A5");
    expect(rescanned.status).toBe(200);
    expect(await loadedFactoryBaleIds(orderTwoId)).toEqual([baleIds.get("P16-A4"), baleIds.get("P16-A5")]);

    // Sibling loading remains untouched by the remove/rescan cycle.
    expect((await loadedFactoryBaleIds(orderOneId)).length).toBe(3);
  }, 60_000);

  it("rejects an unrelated item on the first scan and adds it only after the explicit bypass scan", async () => {
    const first = await scan(orderTwoId, "P16-B1");
    expect(first.status).toBe(400);
    expect(first.body.confirmationRequired).toBe(true);
    expect(first.body.confirmationType).toBe("not_in_proforma");
    expect(first.body.notInProforma).toBe(true);

    const second = await scan(orderTwoId, "P16-B1", { allowBypassProforma: true });
    expect(second.status).toBe(200);
    expect(await loadedFactoryBaleIds(orderTwoId)).toContain(baleIds.get("P16-B1")!);
  }, 60_000);
});
