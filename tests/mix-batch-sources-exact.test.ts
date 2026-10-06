/**
 * GET /api/factory/mix-batches/:id/sources
 *
 *   - The batch must belong to the active company. The route filtered the
 *     source rows by batch id only, so any tenant's batch id returned that
 *     batch's sources (containers, suppliers, costs).
 *   - A zero-cost container source is shown at the container's raw-stock rate,
 *     computed as decimals at the column's 7 places: 1.3 kg at 0.35 is
 *     0.4550000 (the float path returned "0.45499999999999996").
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mixsrc";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let batchId: number;
let foreignBatchId: number;

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

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} supplier`]
  );
  const container = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers (company_id, supplier_id, container_number, total_kg, rate_per_kg, currency_code)
     VALUES ($1, $2, $3, '3', '0', 'USD') RETURNING id`,
    [ctx.companyId, supplier.rows[0].id, `${TEST_PREFIX}-C1`]
  );
  const containerId = container.rows[0].id;
  await pool.query(
    `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd, offloaded_at)
     VALUES ($1, $2, '3.000', '0', '0.35', '0.35', now())`,
    [ctx.companyId, containerId]
  );

  const batch = await pool.query<{ id: number }>(
    `INSERT INTO factory_mix_batches (company_id, batch_code, cost_per_kg, total_weight_kg, used_kg, status)
     VALUES ($1, $2, '0', '3.000', '0', 'OPEN') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-MB-1`]
  );
  batchId = batch.rows[0].id;
  await pool.query(
    `INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, weight_kg, cost_per_kg, total_cost)
     VALUES ($1, $2, '1.300', '0', '0')`,
    [batchId, containerId]
  );

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}FG`, `${TEST_PREFIX}_Foreign`]
  );
  foreignCompanyId = company.rows[0].id;
  const foreignBatch = await pool.query<{ id: number }>(
    `INSERT INTO factory_mix_batches (company_id, batch_code, cost_per_kg, total_weight_kg, used_kg, status)
     VALUES ($1, $2, '0', '3.000', '0', 'OPEN') RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX}-FMB-1`]
  );
  foreignBatchId = foreignBatch.rows[0].id;
  const foreignSupplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX} foreign supplier`]
  );
  await pool.query(
    `INSERT INTO factory_mix_batch_sources (mix_batch_id, supplier_id, weight_kg, cost_per_kg, total_cost)
     VALUES ($1, $2, '3.000', '1.00', '3.00')`,
    [foreignBatchId, foreignSupplier.rows[0].id]
  );
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM factory_mix_batch_sources WHERE mix_batch_id = ANY($1::int[])`, [
    [batchId, foreignBatchId],
  ]);
  await pool.query(`DELETE FROM factory_mix_batches WHERE id = ANY($1::int[])`, [[batchId, foreignBatchId]]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = ANY($1::int[])`, [
    [ctx.companyId, foreignCompanyId],
  ]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("mix batch sources", () => {
  it("refuses another company's batch", async () => {
    const response = await agent.get(`/api/factory/mix-batches/${foreignBatchId}/sources`);
    expect(response.status).toBe(404);
  });

  it("shows a zero-cost container source at the exact container rate", async () => {
    const response = await agent.get(`/api/factory/mix-batches/${batchId}/sources`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({ costPerKg: "0.3500000", totalCost: "0.4550000" });
  });
});
