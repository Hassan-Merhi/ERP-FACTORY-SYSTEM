import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const PREFIX = "saedit";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let fromWorkerId: number;
let toWorkerId: number;

async function addWorker(code: string, firstName: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO employees (company_id, code, first_name, last_name, employee_type, join_date)
     VALUES ($1, $2, $3, 'Worker', 'Worker', '2025-01-01') RETURNING id`,
    [ctx.companyId, code, firstName]
  );
  return result.rows[0].id;
}

async function addOpeningAdvance(amount: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO salary_advances (company_id, employee_id, advance_date, amount, remaining_balance, is_opening_balance)
     VALUES ($1, $2, '2026-10-20', $3, $3, true) RETURNING id`,
    [ctx.companyId, fromWorkerId, amount]
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  fromWorkerId = await addWorker(`${PREFIX}-W1`, "Original");
  toWorkerId = await addWorker(`${PREFIX}-W2`, "Correct");
}, 120000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM salary_advance_deductions WHERE salary_advance_id IN
       (SELECT id FROM salary_advances WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query("DELETE FROM salary_advances WHERE company_id = $1", [ctx.companyId]);
  // The posted advance voucher still references the workers; cleanupTestData
  // removes the vouchers themselves, but the entries must go before the workers.
  await pool.query("DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)", [
    ctx.companyId,
  ]);
  await pool.query("DELETE FROM employees WHERE id IN ($1, $2)", [fromWorkerId, toWorkerId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("ERP salary advance worker correction", () => {
  it("reassigns an untouched opening advance without changing its amounts", async () => {
    const id = await addOpeningAdvance("140.00");
    const response = await agent.patch(`/api/salary-advances/${id}/worker`).send({ employeeId: toWorkerId });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id,
      employeeId: toWorkerId,
      amount: "140.00",
      remainingBalance: "140.00",
    });
    const { rows } = await pool.query(
      "SELECT employee_id, amount, remaining_balance FROM salary_advances WHERE id = $1",
      [id]
    );
    expect(Number(rows[0].employee_id)).toBe(toWorkerId);
    expect(rows[0].amount).toBe("140.00");
    expect(rows[0].remaining_balance).toBe("140.00");
  });

  it("reassigns the employee debit in a linked voucher, without changing the amounts or cash line", async () => {
    const created = await agent.post("/api/salary-advances").send({
      employeeId: fromWorkerId,
      advanceDate: "2026-10-29",
      amount: "60.00",
      cashAccountId: ctx.cashAccountId,
      notes: "",
      isOpeningBalance: false,
    });
    expect(created.status).toBe(201);
    const id: number = created.body.id;
    const voucherId: number = created.body.voucherId;
    expect(voucherId).toBeTruthy();

    const before = await pool.query(
      "SELECT id, employee_id, ledger_account_id, debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id",
      [voucherId]
    );

    const changed = await agent.patch(`/api/salary-advances/${id}/worker`).send({ employeeId: toWorkerId });
    expect(changed.status).toBe(200);

    const after = await pool.query(
      "SELECT id, employee_id, ledger_account_id, debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id",
      [voucherId]
    );
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows.map((row) => [row.id, row.ledger_account_id, row.debit_amount, row.credit_amount])).toEqual(
      before.rows.map((row) => [row.id, row.ledger_account_id, row.debit_amount, row.credit_amount])
    );
    expect(after.rows.filter((row) => Number(row.employee_id) === fromWorkerId)).toHaveLength(0);
    expect(
      after.rows.filter((row) => Number(row.employee_id) === toWorkerId && Number(row.debit_amount) === 60)
    ).toHaveLength(1);
  });

  it("refuses reassignment once a repayment exists", async () => {
    const id = await addOpeningAdvance("35.00");
    const repaid = await agent.post(`/api/salary-advances/${id}/deduction`).send({
      payrollMonth: "2026-10",
      deductionAmount: "10.00",
    });
    expect(repaid.status).toBe(200);
    const response = await agent.patch(`/api/salary-advances/${id}/worker`).send({ employeeId: toWorkerId });
    expect(response.status).toBe(409);
    const row = await pool.query("SELECT employee_id, remaining_balance FROM salary_advances WHERE id = $1", [id]);
    expect(Number(row.rows[0].employee_id)).toBe(fromWorkerId);
    expect(row.rows[0].remaining_balance).toBe("25.00");
  });

  it("rejects an unknown worker and a malformed worker id", async () => {
    const id = await addOpeningAdvance("15.00");
    expect((await agent.patch(`/api/salary-advances/${id}/worker`).send({ employeeId: "1" })).status).toBe(400);
    expect((await agent.patch(`/api/salary-advances/${id}/worker`).send({ employeeId: 2147483647 })).status).toBe(400);
  });
});
