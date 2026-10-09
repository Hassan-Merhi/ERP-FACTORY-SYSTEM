/**
 * Scanning a bale onto an order and bulk-importing bales priced a per-kg
 * proforma line as weight x rate in floats, rounded with toFixed(2): a 3 kg
 * bale at 1.115/kg is 3.3449... as a float and was stored on the order at 3.34
 * instead of 3.35.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mexact22";

let ctx: TestContext;
let agent: request.SuperAgentTest;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM customer_order_bales WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM customer_orders WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM customer_proforma_lines WHERE proforma_id IN (SELECT id FROM customer_proformas WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM customer_proformas WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_bales WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

let seq = 0;

/** A LOADING order on a proforma priced at 1.115/kg, and one 3 kg bale in stock. */
async function perKgOrderWithBale(): Promise<{ orderId: number; baleRef: string }> {
  seq += 1;
  const article = `${TEST_PREFIX}-ART${seq}`;
  const baleRef = `${TEST_PREFIX}-B${seq}`;
  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C${seq}`, `${TEST_PREFIX} Customer ${seq}`]
  );
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [ctx.companyId, customer.rows[0].id, `${TEST_PREFIX} proforma ${seq}`]
  );
  await pool.query(
    `INSERT INTO customer_proforma_lines
       (proforma_id, article_code, product_name, quantity, price_per_bale, pricing_mode, price_per_kg)
     VALUES ($1, $2, $3, 5, '0', 'per_kg', '1.115')`,
    [proforma.rows[0].id, article, `${TEST_PREFIX} product ${seq}`]
  );
  const order = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, '2026-10-01', 'LOADING', $3) RETURNING id`,
    [ctx.companyId, customer.rows[0].id, proforma.rows[0].id]
  );
  await pool.query(
    `INSERT INTO factory_bales
       (company_id, bale_code, reference_number, weight_kg, cost_per_kg, total_cost, status, article_code, erp_location_id)
     VALUES ($1, $2, $2, '3', '1.00', '3.00', 'IN_STOCK', $3, $4)`,
    [ctx.companyId, baleRef, article, ctx.locationId]
  );
  return { orderId: order.rows[0].id, baleRef };
}

async function priceUsed(orderId: number) {
  const added = await pool.query<{ price_used: string }>(
    `SELECT price_used FROM customer_order_bales WHERE order_id = $1`,
    [orderId]
  );
  return added.rows;
}

describe("per-kg bale pricing", () => {
  it("prices a scanned 3 kg bale at 1.115/kg as 3.35", async () => {
    const { orderId, baleRef } = await perKgOrderWithBale();
    const response = await agent
      .post(`/api/factory/customer-orders/${orderId}/bales`)
      .send({ scanCode: baleRef, locationId: ctx.locationId });
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(await priceUsed(orderId)).toEqual([{ price_used: "3.35" }]);
  });

  it("prices a bulk-imported 3 kg bale at 1.115/kg as 3.35", async () => {
    const { orderId, baleRef } = await perKgOrderWithBale();
    const response = await agent.post(`/api/factory/customer-orders/${orderId}/bales/bulk-import`).send({
      locationId: ctx.locationId,
      refNumbers: [baleRef],
      allowBypassProforma: true,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await priceUsed(orderId)).toEqual([{ price_used: "3.35" }]);
  });
});
