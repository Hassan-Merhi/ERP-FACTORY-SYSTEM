/**
 * POST /api/factory/employees/bulk-payroll posts one balanced voucher: rows
 * for another company's employee are dropped before the totals and the
 * expense leg are built (they used to be counted, then skipped), and each
 * amount is taken at cents first (0.105 posts 0.11 on both sides).
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "fbulkpay";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let employeeId: number;
let foreignCompanyId: number;
let foreignEmployeeId: number;

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

  const employee = await pool.query<{ id: number }>(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, current_balance, total_deposits)
     VALUES ($1, $2, 'Own', 'Tester', '2025-01-01', '0', '0') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-E1`]
  );
  employeeId = employee.rows[0].id;
  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'factory', true, 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}X`, `${TEST_PREFIX}_ForeignCompany`]
  );
  foreignCompanyId = company.rows[0].id;
  const foreign = await pool.query<{ id: number }>(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, current_balance, total_deposits)
     VALUES ($1, $2, 'Foreign', 'Tester', '2025-01-01', '0', '0') RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX}-FX`]
  );
  foreignEmployeeId = foreign.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM employees WHERE id = $1`, [foreignEmployeeId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/employees/bulk-payroll", () => {
  it("posts a balanced voucher at cents for this company's employees only", async () => {
    const response = await agent.post("/api/factory/employees/bulk-payroll").send({
      date: "2026-09-10",
      deposits: [
        { employeeId, amount: "0.105", deduction: "0" },
        { employeeId: foreignEmployeeId, amount: "50", deduction: "0" },
      ],
    });

    expect(response.status, response.text).toBe(200);
    expect(response.body.totalSalary).toBe(0.11);
    const entries = await pool.query<{ employee_id: number | null; debit_amount: string; credit_amount: string }>(
      `SELECT employee_id, debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [response.body.voucher.id]
    );
    expect(entries.rows.map((row) => [row.employee_id, row.debit_amount, row.credit_amount])).toEqual([
      [null, "0.11", "0.00"],
      [employeeId, "0.00", "0.11"],
    ]);
    const balance = await pool.query<{ current_balance: string }>(
      `SELECT current_balance FROM employees WHERE id = $1`,
      [employeeId]
    );
    expect(balance.rows[0].current_balance).toBe("0.11");
  });
});
