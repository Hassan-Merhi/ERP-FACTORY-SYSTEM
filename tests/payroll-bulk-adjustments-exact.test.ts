/**
 * Bulk payroll bonuses and withdrawals post one balanced voucher.
 *
 *   - Each amount is taken at cents before it is totalled, so 0.105 posts
 *     0.11 on both sides (the float total was 0.11 against a 0.10 leg).
 *   - A row for another company's employee is dropped before the voucher is
 *     built. It used to be counted in the total and the expense or cash leg
 *     and only then skipped, leaving the voucher unbalanced.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "pbulkadj";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let employeeId: number;
let foreignCompanyId: number;
let foreignEmployeeId: number;

async function legs(voucherId: number) {
  const result = await pool.query<{ employee_id: number | null; debit_amount: string; credit_amount: string }>(
    `SELECT employee_id, debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucherId]
  );
  return result.rows;
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
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, current_balance, total_deposits)
     VALUES ($1, $2, 'Own', 'Tester', '2025-01-01', '0', '0') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-E1`]
  );
  employeeId = employee.rows[0].id;
  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'erp', true, 'USD') RETURNING id`,
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

describe("bulk payroll adjustments", () => {
  it("posts a balanced bonus voucher at cents and ignores another company's employee", async () => {
    const response = await agent.post("/api/payroll/bulk-bonus-employees").send({
      date: "2026-09-10",
      bonuses: [
        { employeeId, amount: "0.105" },
        { employeeId: foreignEmployeeId, amount: "50" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.totalAmount).toBe(0.11);
    expect(
      (await legs(response.body.voucher.id)).map((leg) => [leg.employee_id, leg.debit_amount, leg.credit_amount])
    ).toEqual([
      [null, "0.11", "0.00"],
      [employeeId, "0.00", "0.11"],
    ]);
  });

  it("posts a balanced withdrawal voucher and ignores another company's employee", async () => {
    const response = await agent.post("/api/payroll/bulk-withdraw-employees").send({
      date: "2026-09-11",
      paymentAccountType: "cash",
      paymentAccountId: ctx.cashAccountId,
      withdrawals: [
        { employeeId, amount: "0.105" },
        { employeeId: foreignEmployeeId, amount: "50" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.totalAmount).toBe(0.11);
    expect(
      (await legs(response.body.voucher.id)).map((leg) => [leg.employee_id, leg.debit_amount, leg.credit_amount])
    ).toEqual([
      [null, "0.00", "0.11"],
      [employeeId, "0.11", "0.00"],
    ]);
  });

  it("posts a balanced salary deposit voucher and ignores another company's employee", async () => {
    const response = await agent.post("/api/payroll/bulk-deposit-employees").send({
      date: "2026-09-12",
      deposits: [
        { employeeId, amount: "0.105" },
        { employeeId: foreignEmployeeId, amount: "50" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.totalAmount).toBe(0.11);
    expect(
      (await legs(response.body.voucher.id)).map((leg) => [leg.employee_id, leg.debit_amount, leg.credit_amount])
    ).toEqual([
      [null, "0.11", "0.00"],
      [employeeId, "0.00", "0.11"],
    ]);
  });

  it("balances bulk worker payments at cents and refuses another company's cash account", async () => {
    const response = await agent.post("/api/payroll/bulk-pay-workers").send({
      date: "2026-09-13",
      paymentAccountType: "cash",
      paymentAccountId: ctx.cashAccountId,
      payments: [
        { employeeId, amount: "0.105" },
        { employeeId, amount: "0.105" },
      ],
    });

    expect(response.status).toBe(200);
    // Two half-cent payments are 0.11 each: 0.22 on both legs (the float total was 0.21).
    expect(response.body.totalAmount).toBe("0.22");
    const rows = await legs(response.body.voucher.id);
    const debits = rows.reduce((sum, leg) => sum + Number(leg.debit_amount), 0);
    const credits = rows.reduce((sum, leg) => sum + Number(leg.credit_amount), 0);
    expect(debits.toFixed(2)).toBe("0.22");
    expect(credits.toFixed(2)).toBe("0.22");

    const foreignAccount = await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, 'Asset') RETURNING id`,
      [foreignCompanyId, `${TEST_PREFIX}-FCASH`, `${TEST_PREFIX} Foreign Cash`]
    );
    try {
      const refused = await agent.post("/api/payroll/bulk-pay-workers").send({
        date: "2026-09-13",
        paymentAccountType: "cash",
        paymentAccountId: foreignAccount.rows[0].id,
        payments: [{ employeeId, amount: "5" }],
      });
      expect(refused.status).toBe(404);
    } finally {
      await pool.query(`DELETE FROM ledger_accounts WHERE id = $1`, [foreignAccount.rows[0].id]);
    }
  });
});
