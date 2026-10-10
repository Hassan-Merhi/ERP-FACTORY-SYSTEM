/**
 * Behavioural coverage for the employee advance and bonus write routes.
 *
 * All five were guard-only. Advances track money lent to an employee and repaid
 * over time; bonuses post a journal and move the employee's running balance.
 *
 * The properties that carry the risk:
 *
 *   - **Repayment arithmetic.** `remaining_balance` falls by exactly the amount
 *     repaid, is clamped at zero rather than going negative, and `fully_paid`
 *     flips precisely when the balance reaches zero. An over-repayment that
 *     drove the balance negative would show the company owing the employee.
 *   - **A bonus moves three things together.** The voucher (Dr payroll expense
 *     / Cr employee), `employees.current_balance` and `employees.total_deposits`
 *     all move by the same amount. Deleting the bonus has to put all three
 *     back — a reversal that dropped the voucher but left the balance would
 *     leave the employee permanently owed money with nothing behind it.
 *   - **Deletes take their dependents.** Removing an advance removes its
 *     repayments; removing a bonus removes its voucher and both entries.
 *
 * The bonus voucher credits an entry keyed by `employee_id` with a null
 * `ledger_account_id`, which is how this schema represents an employee-side
 * leg. The balance assertion is written against the totals rather than the
 * account, so it holds regardless of how that leg is modelled.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "empadv";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let employeeId: number;
let seq = 0;

async function employeeTotals(id: number) {
  const result = await pool.query<{ current_balance: string | null; total_deposits: string | null }>(
    `SELECT current_balance, total_deposits FROM employees WHERE id = $1`,
    [id]
  );
  return {
    balance: Number(result.rows[0]?.current_balance ?? 0),
    deposits: Number(result.rows[0]?.total_deposits ?? 0),
  };
}

async function advanceRow(id: number) {
  const result = await pool.query<{ remaining_balance: string; fully_paid: boolean; amount: string }>(
    `SELECT remaining_balance, fully_paid, amount FROM employee_advances WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function giveAdvance(amount: string) {
  const response = await agent
    .post("/api/factory/employee-advances")
    .send({ employeeId, advanceDate: "2026-04-01", amount });
  if (response.status !== 201) throw new Error(`Seed advance failed: ${response.status} ${response.text}`);
  return response.body as { id: number };
}

async function giveBonus(amount: string) {
  const response = await agent
    .post("/api/factory/employee-bonuses")
    .send({ employeeId, bonusDate: "2026-04-01", amount });
  if (response.status !== 201) throw new Error(`Seed bonus failed: ${response.status} ${response.text}`);
  return response.body as { id: number; voucher_id: number };
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

  seq += 1;
  const employee = await pool.query<{ id: number }>(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, current_balance, total_deposits)
     VALUES ($1, $2, $3, 'Tester', '2025-01-01', '0', '0') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-E${seq}`, `${TEST_PREFIX}`]
  );
  employeeId = employee.rows[0].id;
}, 120000);

afterAll(async () => {
  // The employee rows are cleared by cleanupTestData, which does it after the
  // vouchers — a bonus leaves a voucher_entries row keyed by employee_id, so
  // employees cannot be dropped before those go.
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/employee-advances", () => {
  it("starts the remaining balance at the full amount and unpaid", async () => {
    const advance = await giveAdvance("400.00");

    const row = await advanceRow(advance.id);
    expect(Number(row?.amount)).toBeCloseTo(400, 2);
    expect(Number(row?.remaining_balance)).toBeCloseTo(400, 2);
    expect(row?.fully_paid).toBe(false);
  });

  it("rejects a zero, negative or missing amount", async () => {
    for (const amount of ["0", "-1", undefined]) {
      const response = await agent
        .post("/api/factory/employee-advances")
        .send({ employeeId, advanceDate: "2026-04-01", amount });
      expect(response.status).toBe(400);
    }
  });

  it("returns 404 for an employee who is not in this company", async () => {
    const response = await agent
      .post("/api/factory/employee-advances")
      .send({ employeeId: 999999, advanceDate: "2026-04-01", amount: "10.00" });

    expect(response.status).toBe(404);
  });
});

describe("POST /api/factory/employee-advances/:id/repay", () => {
  it("reduces the remaining balance by exactly the amount repaid", async () => {
    const advance = await giveAdvance("500.00");

    const response = await agent
      .post(`/api/factory/employee-advances/${advance.id}/repay`)
      .send({ repaymentDate: "2026-05-01", amount: "125.00" });

    expect(response.status).toBe(200);
    const row = await advanceRow(advance.id);
    expect(Number(row?.remaining_balance)).toBeCloseTo(375, 2);
    expect(row?.fully_paid).toBe(false);

    const repayments = await pool.query(`SELECT id FROM employee_advance_repayments WHERE advance_id = $1`, [
      advance.id,
    ]);
    expect(repayments.rowCount).toBe(1);
  });

  it("marks the advance fully paid when the balance reaches zero", async () => {
    const advance = await giveAdvance("200.00");

    await agent
      .post(`/api/factory/employee-advances/${advance.id}/repay`)
      .send({ repaymentDate: "2026-05-01", amount: "200.00" });

    const row = await advanceRow(advance.id);
    expect(Number(row?.remaining_balance)).toBeCloseTo(0, 2);
    expect(row?.fully_paid).toBe(true);
  });

  it("clamps an over-repayment at zero instead of going negative", async () => {
    const advance = await giveAdvance("100.00");

    const response = await agent
      .post(`/api/factory/employee-advances/${advance.id}/repay`)
      .send({ repaymentDate: "2026-05-01", amount: "150.00" });

    expect(response.status).toBe(200);
    const row = await advanceRow(advance.id);
    // A negative remaining balance would read as the company owing the
    // employee, which is a different debt in the opposite direction.
    expect(Number(row?.remaining_balance)).toBeCloseTo(0, 2);
    expect(row?.fully_paid).toBe(true);
  });

  it("accumulates across several repayments", async () => {
    const advance = await giveAdvance("300.00");

    for (const amount of ["100.00", "50.00", "25.00"]) {
      await agent
        .post(`/api/factory/employee-advances/${advance.id}/repay`)
        .send({ repaymentDate: "2026-05-01", amount });
    }

    expect(Number((await advanceRow(advance.id))?.remaining_balance)).toBeCloseTo(125, 2);
    const repayments = await pool.query(`SELECT id FROM employee_advance_repayments WHERE advance_id = $1`, [
      advance.id,
    ]);
    expect(repayments.rowCount).toBe(3);
  });

  it("rejects a zero or negative repayment", async () => {
    const advance = await giveAdvance("100.00");

    for (const amount of ["0", "-10"]) {
      const response = await agent
        .post(`/api/factory/employee-advances/${advance.id}/repay`)
        .send({ repaymentDate: "2026-05-01", amount });
      expect(response.status).toBe(400);
    }
    expect(Number((await advanceRow(advance.id))?.remaining_balance)).toBeCloseTo(100, 2);
  });

  it("returns 404 for an advance in another company", async () => {
    const response = await agent
      .post("/api/factory/employee-advances/999999/repay")
      .send({ repaymentDate: "2026-05-01", amount: "10.00" });

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/factory/employee-advances/:id", () => {
  it("removes the advance and its repayments together", async () => {
    const advance = await giveAdvance("250.00");
    await agent
      .post(`/api/factory/employee-advances/${advance.id}/repay`)
      .send({ repaymentDate: "2026-05-01", amount: "50.00" });

    const response = await agent.delete(`/api/factory/employee-advances/${advance.id}`);
    expect(response.status).toBe(200);

    expect(await advanceRow(advance.id)).toBeNull();
    // Repayments pointing at an advance that no longer exists would keep
    // appearing in the repayment list with nothing to reconcile against.
    const repayments = await pool.query(`SELECT id FROM employee_advance_repayments WHERE advance_id = $1`, [
      advance.id,
    ]);
    expect(repayments.rowCount).toBe(0);
  });
});

describe("POST /api/factory/employee-bonuses", () => {
  it("posts a balanced journal and moves the employee's balance and deposits", async () => {
    const before = await employeeTotals(employeeId);

    const bonus = await giveBonus("90.00");

    const legs = await pool.query<{ debit_amount: string; credit_amount: string }>(
      `SELECT debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1`,
      [bonus.voucher_id]
    );
    expect(legs.rowCount).toBe(2);
    const debits = legs.rows.reduce((sum, leg) => sum + Number(leg.debit_amount), 0);
    const credits = legs.rows.reduce((sum, leg) => sum + Number(leg.credit_amount), 0);
    expect(debits).toBeCloseTo(90, 2);
    expect(credits).toBeCloseTo(90, 2);

    // The journal and the employee's running totals have to move together, or
    // the payroll page and the ledger disagree about what is owed.
    const after = await employeeTotals(employeeId);
    expect(after.balance).toBeCloseTo(before.balance + 90, 2);
    expect(after.deposits).toBeCloseTo(before.deposits + 90, 2);
  });

  it("rejects a zero, negative or missing amount", async () => {
    const before = await employeeTotals(employeeId);

    for (const amount of ["0", "-5", undefined]) {
      const response = await agent
        .post("/api/factory/employee-bonuses")
        .send({ employeeId, bonusDate: "2026-04-01", amount });
      expect(response.status).toBe(400);
    }

    expect(await employeeTotals(employeeId)).toEqual(before);
  });

  it("returns 404 for an employee who is not in this company", async () => {
    const response = await agent
      .post("/api/factory/employee-bonuses")
      .send({ employeeId: 999999, bonusDate: "2026-04-01", amount: "10.00" });

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/factory/employee-bonuses/:id", () => {
  it("reverses the balance, the deposits and the voucher together", async () => {
    const before = await employeeTotals(employeeId);
    const bonus = await giveBonus("140.00");
    expect((await employeeTotals(employeeId)).balance).toBeCloseTo(before.balance + 140, 2);

    const response = await agent.delete(`/api/factory/employee-bonuses/${bonus.id}`);
    expect(response.status).toBe(200);

    // All three go back. Dropping the voucher but leaving the balance would
    // leave the employee owed money with nothing in the ledger behind it.
    const after = await employeeTotals(employeeId);
    expect(after.balance).toBeCloseTo(before.balance, 2);
    expect(after.deposits).toBeCloseTo(before.deposits, 2);
    expect(
      (await pool.query(`SELECT id FROM vouchers WHERE id = $1 AND deleted_at IS NULL`, [bonus.voucher_id])).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT ve.id FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL WHERE ve.voucher_id = $1`,
          [bonus.voucher_id]
        )
      ).rowCount
    ).toBe(0);
  });

  it("leaves nothing behind when the same bonus is deleted twice", async () => {
    const before = await employeeTotals(employeeId);
    const bonus = await giveBonus("60.00");

    expect((await agent.delete(`/api/factory/employee-bonuses/${bonus.id}`)).status).toBe(200);
    const second = await agent.delete(`/api/factory/employee-bonuses/${bonus.id}`);

    // The reversal used to run unwrapped and fail partway, so a retry after a
    // 500 decremented the balance a second time. The second delete must find
    // nothing and change nothing.
    expect(second.status).toBe(404);
    expect(await employeeTotals(employeeId)).toEqual(before);
  });

  it("returns 404 for a bonus in another company", async () => {
    const response = await agent.delete("/api/factory/employee-bonuses/999999");
    expect(response.status).toBe(404);
  });
});

describe("employee advances and bonuses at exact cents", () => {
  it("stores a half-cent advance rounded half up", async () => {
    // parseFloat("1.005").toFixed(2) is "1.00"; numeric(…, 2) keeps 1.01.
    const advance = await giveAdvance("1.005");
    const row = await advanceRow(advance.id);
    expect(row?.amount).toBe("1.01");
    expect(row?.remaining_balance).toBe("1.01");
  });

  it("moves the employee's balance by a half-cent bonus rounded half up", async () => {
    const before = await employeeTotals(employeeId);
    const bonus = (await giveBonus("1.005")) as { amount?: string };
    expect(bonus.amount).toBe("1.01");
    const after = await employeeTotals(employeeId);
    expect(after.balance - before.balance).toBeCloseTo(1.01, 2);
  });
});

describe("POST /api/payroll/bonus-employee", () => {
  it("posts a half-cent bonus rounded up, not down", async () => {
    // 1.005 parses to the float 1.00499999999999989…, which toFixed(2) wrote as 1.00.
    const response = await agent
      .post("/api/payroll/bonus-employee")
      .send({ employeeId, amount: "1.005", date: "2026-04-02" });

    expect(response.status).toBe(200);
    expect(response.body.voucher.totalAmount).toBe("1.01");
    const entries = await pool.query<{ debit_amount: string; credit_amount: string }>(
      `SELECT debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [response.body.voucher.id]
    );
    expect(entries.rows.map((row) => [Number(row.debit_amount), Number(row.credit_amount)])).toEqual([
      [1.01, 0],
      [0, 1.01],
    ]);
  });

  it("rejects an amount that does not parse", async () => {
    const response = await agent
      .post("/api/payroll/bonus-employee")
      .send({ employeeId, amount: "abc", date: "2026-04-02" });

    expect(response.status).toBe(400);
  });
});

describe("POST /api/payroll/bonus-employee tenant boundary", () => {
  it("refuses a bonus for another company's employee without posting anything", async () => {
    const company = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, company_type, active, base_currency)
       VALUES ($1, $2, 'erp', true, 'USD') RETURNING id`,
      [`${TEST_PREFIX.toUpperCase()}X`, `${TEST_PREFIX}_ForeignCompany`]
    );
    const foreignCompanyId = company.rows[0].id;
    const foreign = await pool.query<{ id: number }>(
      `INSERT INTO employees (company_id, code, first_name, last_name, join_date, current_balance, total_deposits)
       VALUES ($1, $2, 'Foreign', 'Tester', '2025-01-01', '0', '0') RETURNING id`,
      [foreignCompanyId, `${TEST_PREFIX}-FX`]
    );
    const foreignEmployeeId = foreign.rows[0].id;
    try {
      const response = await agent
        .post("/api/payroll/bonus-employee")
        .send({ employeeId: foreignEmployeeId, amount: "50", date: "2026-04-02" });

      expect(response.status).toBe(404);
      const entries = await pool.query(`SELECT 1 FROM voucher_entries WHERE employee_id = $1`, [foreignEmployeeId]);
      expect(entries.rowCount).toBe(0);
      expect((await employeeTotals(foreignEmployeeId)).balance).toBe(0);
    } finally {
      const vouchers = await pool.query<{ voucher_id: number }>(
        `DELETE FROM voucher_entries WHERE employee_id = $1 RETURNING voucher_id`,
        [foreignEmployeeId]
      );
      for (const row of vouchers.rows) {
        await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [row.voucher_id]);
        await pool.query(`DELETE FROM vouchers WHERE id = $1`, [row.voucher_id]);
      }
      await pool.query(`DELETE FROM employees WHERE id = $1`, [foreignEmployeeId]);
      await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
    }
  });
});
