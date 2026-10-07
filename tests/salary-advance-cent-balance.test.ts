/**
 * A salary advance is fully paid only when nothing is left at cents.
 *
 *   - A deduction that leaves 0.01 owed (0.03 - 0.02) used to set fullyPaid (the check was
 *     "remaining <= 0.01"), which then refused any further deduction.
 *   - Reconciliation ignored differences of 0.01 between the stored and the
 *     rebuilt remaining balance.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "salcent";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let employeeId: number;

async function advance(amount: string, remaining: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO salary_advances (company_id, employee_id, advance_date, amount, remaining_balance)
     VALUES ($1, $2, '2026-09-01', $3, $4) RETURNING id`,
    [ctx.companyId, employeeId, amount, remaining]
  );
  return result.rows[0].id;
}

async function row(id: number) {
  const result = await pool.query<{ remaining_balance: string; fully_paid: boolean }>(
    `SELECT remaining_balance, fully_paid FROM salary_advances WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

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
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date)
     VALUES ($1, $2, 'Advance', 'Cent', '2025-01-01') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-E1`]
  );
  employeeId = employee.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM salary_advances WHERE employee_id = $1`, [employeeId]);
  await pool.query(`DELETE FROM employees WHERE id = $1`, [employeeId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("salary advance cent balances", () => {
  it("keeps an advance open while one cent is owed", async () => {
    const id = await advance("0.03", "0.03");
    const response = await agent
      .post(`/api/salary-advances/${id}/deduction`)
      .send({ payrollMonth: "2026-09", deductionAmount: "0.02" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ newRemainingBalance: "0.01", fullyPaid: false });
    expect(await row(id)).toEqual({ remaining_balance: "0.01", fully_paid: false });
  });

  it("reconciles a stored balance that is off by one cent", async () => {
    const id = await advance("5.00", "5.01");
    const response = await agent.post("/api/salary-advances/reconcile");
    expect(response.status).toBe(200);
    expect(await row(id)).toEqual({ remaining_balance: "5.00", fully_paid: false });
  });
});
