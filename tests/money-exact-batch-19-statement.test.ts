/**
 * The factory worker statement kept a float running balance: advances of 0.10
 * and 0.20 left a balance of 0.30000000000000004, and the residue grew with
 * the worker's history.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mexact19";

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
  await pool.query(`DELETE FROM factory_worker_advances WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("factory worker statement", () => {
  it("keeps an exact running balance", async () => {
    const worker = await pool.query<{ id: number }>(
      `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX} Worker`]
    );
    const workerId = worker.rows[0].id;
    await pool.query(
      `INSERT INTO factory_worker_advances (company_id, worker_id, advance_date, amount, remaining_balance)
       VALUES ($1, $2, '2026-10-01', '0.10', '0.10'), ($1, $2, '2026-10-02', '0.20', '0.20')`,
      [ctx.companyId, workerId]
    );

    const response = await agent.get(`/api/factory/workers/${workerId}/statement`);
    expect(response.status).toBe(200);
    expect(response.body.map((entry: { runningBalance: number }) => entry.runningBalance)).toEqual([0.1, 0.3]);
  });
});
