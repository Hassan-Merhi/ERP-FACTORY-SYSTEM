/**
 * Recalculating bale costs from their mix batch stored weight x cost/kg as a
 * float product rounded with toFixed(2): 3 kg at 1.115/kg is 3.3449... as a
 * float and became 3.34 instead of 3.35.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mexact20";

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
  await pool.query(`DELETE FROM factory_bales WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_mix_batches WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("recalculate bale costs", () => {
  it("prices 3 kg at 1.115/kg as 3.35", async () => {
    const batch = await pool.query<{ id: number }>(
      `INSERT INTO factory_mix_batches (company_id, batch_code, cost_per_kg) VALUES ($1, $2, '1.115') RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-MB`]
    );
    await pool.query(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, mix_batch_id, cost_per_kg, total_cost)
       VALUES ($1, $2, $2, '3', $3, '0', '0')`,
      [ctx.companyId, `${TEST_PREFIX}-B1`, batch.rows[0].id]
    );

    const response = await agent.post("/api/factory/raw-stock/recalculate-bale-costs").send({});
    expect(response.status).toBe(200);
    expect(response.body.changes).toEqual([expect.objectContaining({ newCostPerKg: "1.1150", newTotalCost: "3.35" })]);
  });
});
