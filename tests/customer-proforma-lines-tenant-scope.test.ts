/**
 * Customer proforma lines carry no company of their own, so the line routes
 * must check the proforma they belong to. POST added a line to any proforma
 * id, and PUT/DELETE edited or removed any line by id, across tenants. All
 * three now answer 404 for another company's proforma.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "proflines";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let foreignCustomerId: number;
let foreignProformaId: number;
let foreignLineId: number;

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

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}F`, `${TEST_PREFIX}_Foreign`]
  );
  foreignCompanyId = company.rows[0].id;
  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX.toUpperCase()}-FC`, `${TEST_PREFIX} foreign customer`]
  );
  foreignCustomerId = customer.rows[0].id;
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [foreignCompanyId, foreignCustomerId, `${TEST_PREFIX} foreign proforma`]
  );
  foreignProformaId = proforma.rows[0].id;
  const line = await pool.query<{ id: number }>(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, 'ART-F', 'Foreign article', 5, '10.00') RETURNING id`,
    [foreignProformaId]
  );
  foreignLineId = line.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM customer_proforma_lines WHERE proforma_id = $1`, [foreignProformaId]);
  await pool.query(`DELETE FROM customer_proformas WHERE id = $1`, [foreignProformaId]);
  await pool.query(`DELETE FROM customers WHERE id = $1`, [foreignCustomerId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

async function foreignLine() {
  const result = await pool.query<{ quantity: number }>(`SELECT quantity FROM customer_proforma_lines WHERE id = $1`, [
    foreignLineId,
  ]);
  return result.rows[0];
}

describe("customer proforma lines", () => {
  it("refuses a line on another company's proforma", async () => {
    const response = await agent.post("/api/factory/customer-proforma-lines").send({
      proformaId: foreignProformaId,
      articleCode: "ART-X",
      productName: "Injected",
      quantity: 1,
      pricePerBale: "1.00",
    });
    expect(response.status).toBe(404);
    const count = await pool.query(`SELECT 1 FROM customer_proforma_lines WHERE proforma_id = $1`, [foreignProformaId]);
    expect(count.rowCount).toBe(1);
  });

  it("refuses to edit or delete another company's line", async () => {
    const edit = await agent.put(`/api/factory/customer-proforma-lines/${foreignLineId}`).send({ quantity: 99 });
    expect(edit.status).toBe(404);
    const remove = await agent.delete(`/api/factory/customer-proforma-lines/${foreignLineId}`);
    expect(remove.status).toBe(404);
    expect(await foreignLine()).toEqual({ quantity: 5 });
  });
});
