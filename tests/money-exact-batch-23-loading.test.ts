/**
 * Creating a loading from a proforma priced a per-kg line as weight x rate in
 * floats rounded with toFixed(2): a 3 kg bale at 1.115/kg is 3.3449... as a
 * float and was stored on the loading at 3.34 instead of 3.35.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mexact23";

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
    `DELETE FROM customer_order_expected_lines WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`,
    [ctx.companyId]
  );
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

describe("create loading from proforma", () => {
  it("prices a 3 kg bale at 1.115/kg as 3.35", async () => {
    const article = `${TEST_PREFIX}-ART`;
    const customer = await pool.query<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-C`, `${TEST_PREFIX} Customer`]
    );
    const proforma = await pool.query<{ id: number }>(
      `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [ctx.companyId, customer.rows[0].id, `${TEST_PREFIX} proforma`]
    );
    await pool.query(
      `INSERT INTO customer_proforma_lines
         (proforma_id, article_code, product_name, quantity, price_per_bale, pricing_mode, price_per_kg)
       VALUES ($1, $2, $3, 1, '0', 'per_kg', '1.115')`,
      [proforma.rows[0].id, article, `${TEST_PREFIX} product`]
    );
    await pool.query(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, weight_kg, cost_per_kg, total_cost, status, article_code, erp_location_id)
       VALUES ($1, $2, $2, '3', '1.00', '3.00', 'IN_STOCK', $3, $4)`,
      [ctx.companyId, `${TEST_PREFIX}-B1`, article, ctx.locationId]
    );

    const response = await agent
      .post(`/api/factory/customer-proformas/${proforma.rows[0].id}/create-loading`)
      .send({ locationId: ctx.locationId, orderDate: "2026-10-09" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const added = await pool.query<{ price_used: string }>(
      `SELECT cob.price_used FROM customer_order_bales cob
       JOIN customer_orders co ON co.id = cob.order_id
       WHERE co.company_id = $1`,
      [ctx.companyId]
    );
    expect(added.rows).toEqual([{ price_used: "3.35" }]);
  });
});
