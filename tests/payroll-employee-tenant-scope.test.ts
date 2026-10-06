/**
 * The single-employee payroll writes (deposit, withdrawal, worker payment)
 * loaded the employee by id alone, so a user could post a voucher that moved
 * another company's employee balance. Each must answer 404 for an employee
 * outside the active company and write nothing.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "payscope";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let foreignEmployeeId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'erp', true, 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}X`, `${TEST_PREFIX}_ForeignCompany`]
  );
  foreignCompanyId = company.rows[0].id;
  const employee = await pool.query<{ id: number }>(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, current_balance, total_deposits)
     VALUES ($1, $2, 'Foreign', 'Tester', '2025-01-01', '0', '0') RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX}-FX`]
  );
  foreignEmployeeId = employee.rows[0].id;
}, 120000);

afterAll(async () => {
  const entries = await pool.query<{ voucher_id: number }>(
    `DELETE FROM voucher_entries WHERE employee_id = $1 RETURNING voucher_id`,
    [foreignEmployeeId]
  );
  for (const row of entries.rows) {
    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [row.voucher_id]);
    await pool.query(`DELETE FROM vouchers WHERE id = $1`, [row.voucher_id]);
  }
  await pool.query(`DELETE FROM employees WHERE id = $1`, [foreignEmployeeId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

async function foreignEntryCount() {
  const result = await pool.query(`SELECT 1 FROM voucher_entries WHERE employee_id = $1`, [foreignEmployeeId]);
  return result.rowCount;
}

describe("single-employee payroll writes stay inside the active company", () => {
  it.each([
    ["/api/payroll/deposit-employee", {}],
    ["/api/payroll/withdraw-employee", { paymentAccountType: "cash", paymentAccountId: 1 }],
    ["/api/payroll/pay-worker", { bankAccountId: 1 }],
  ])("%s refuses another company's employee", async (path, extra) => {
    const response = await agent
      .post(path)
      .send({ employeeId: foreignEmployeeId, amount: "50", date: "2026-04-02", ...extra });

    expect(response.status).toBe(404);
    expect(await foreignEntryCount()).toBe(0);
  });
});
