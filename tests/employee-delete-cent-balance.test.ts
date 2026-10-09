/**
 * Deleting an employee with a balance needs admin confirmation. The check was
 * "|balance| > 0.01", so an employee owing or owed exactly one cent was
 * deleted without confirmation as if the balance were zero.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "empdelcent";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let employeeId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const employee = await pool.query<{ id: number }>(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, current_balance)
     VALUES ($1, $2, 'Cent', 'Balance', '2025-01-01', '0.01') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-E1`]
  );
  employeeId = employee.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM employees WHERE id = $1`, [employeeId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("employee delete balance check", () => {
  it("asks for confirmation when the balance is one cent", async () => {
    const response = await agent.delete(`/api/employees/${employeeId}`);
    expect(response.status).toBe(409);
    expect(response.body.employeeBalance).toBe(0.01);

    const still = await pool.query(`SELECT 1 FROM employees WHERE id = $1 AND deleted_at IS NULL`, [employeeId]);
    expect(still.rowCount).toBe(1);
  });
});
