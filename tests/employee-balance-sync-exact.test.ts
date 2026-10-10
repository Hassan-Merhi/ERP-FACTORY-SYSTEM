/**
 * syncEmployeeBalancesFromEntries keeps employee balances exact and in-tenant.
 *
 *   - Entry amounts are summed as decimals and the change is taken at cents,
 *     so a 1.005 credit moves the balance by 1.01 (float addition gave
 *     1.00499… and stored 1.00) and reversing it returns exactly to 0.00.
 *   - Employees are looked up inside the voucher's company only: an entry that
 *     names another company's employee id leaves that employee untouched.
 *   - Wave 12: the executor is now a required argument (the caller's
 *     transaction in the routes); these calls pass the pool-level db.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { db, pool } from "../server/db";
import { syncEmployeeBalancesFromEntries } from "../server/routes/helpers/employeeHelpers";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "empbalsync";

let ctx: TestContext;
let employeeId: number;
let foreignCompanyId: number;
let foreignEmployeeId: number;

async function balances(id: number) {
  const result = await pool.query<{ current_balance: string; total_deposits: string; total_withdrawals: string }>(
    `SELECT current_balance, total_deposits, total_withdrawals FROM employees WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const employee = await pool.query<{ id: number }>(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date)
     VALUES ($1, $2, 'Own', 'Tester', '2025-01-01') RETURNING id`,
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
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date)
     VALUES ($1, $2, 'Foreign', 'Tester', '2025-01-01') RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX}-FX`]
  );
  foreignEmployeeId = foreign.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM employees WHERE id = ANY($1::int[])`, [[employeeId, foreignEmployeeId]]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  await closeTestServer();
});

describe("syncEmployeeBalancesFromEntries", () => {
  it("applies the summed change at cents and reverses it exactly", async () => {
    await syncEmployeeBalancesFromEntries(
      [{ ledgerAccountId: null, employeeId, debitAmount: "0.000000", creditAmount: "1.005000" }],
      ctx.companyId,
      false,
      db
    );
    expect(await balances(employeeId)).toEqual({
      current_balance: "1.01",
      total_deposits: "1.01",
      total_withdrawals: "0.00",
    });

    await syncEmployeeBalancesFromEntries(
      [{ ledgerAccountId: null, employeeId, debitAmount: "0.000000", creditAmount: "1.005000" }],
      ctx.companyId,
      true,
      db
    );
    expect(await balances(employeeId)).toEqual({
      current_balance: "0.00",
      total_deposits: "0.00",
      total_withdrawals: "0.00",
    });
  });

  it("does not touch another company's employee", async () => {
    await syncEmployeeBalancesFromEntries(
      [{ ledgerAccountId: null, employeeId: foreignEmployeeId, debitAmount: "0.000000", creditAmount: "50.000000" }],
      ctx.companyId,
      false,
      db
    );
    expect(await balances(foreignEmployeeId)).toEqual({
      current_balance: "0.00",
      total_deposits: "0.00",
      total_withdrawals: "0.00",
    });
  });
});
