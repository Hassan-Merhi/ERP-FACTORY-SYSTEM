/**
 * Phase 22 integration: readers that find a voucher by its family number.
 *
 * - Phase 22 (C) engine-numbers the factory employee deposit / withdrawal
 *   vouchers (they were EMP-DEP- / EMP-WD-{Date.now()}). The daybook void moved
 *   the employee balance back only for vouchers whose number carried those
 *   prefixes, so voiding a new deposit retired the voucher but left the
 *   employee's balance credited. The void now also recognises the vouchers by
 *   their posting identity.
 * - Phase 22 (B) engine-numbered the ERP payroll run payment (was
 *   SAL-{run}-{Date.now()}), but the run undo, the voucher bulk delete and the
 *   payment deletion policy find it by the SAL-{run}- prefix; and its posting
 *   identity (the run) made a re-pay after an undo replay the deleted voucher.
 *   It keeps SAL-{run}-{generation}, each generation its own identity.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "p22void";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let employeeId: number;
let runSeq = 0;

async function employeeBalances() {
  const result = await pool.query<{ current_balance: string; total_deposits: string; total_withdrawals: string }>(
    `SELECT current_balance, total_deposits, total_withdrawals FROM employees WHERE id = $1`,
    [employeeId]
  );
  return result.rows[0];
}

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
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, current_balance, total_deposits, total_withdrawals)
     VALUES ($1, 'P22V-A', 'Void', 'Test', '2026-01-01', '10.00', '10.00', '0') RETURNING id`,
    [ctx.companyId]
  );
  employeeId = employee.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM erp_payroll_run_items WHERE run_id IN (SELECT id FROM erp_payroll_runs WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM erp_payroll_runs WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT voucher_id FROM voucher_entries WHERE employee_id = $1)`,
    [employeeId]
  );
  await pool.query(`DELETE FROM employees WHERE id = $1`, [employeeId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("daybook void of an engine-numbered employee cash voucher", () => {
  it("moves the employee balance back when a deposit is voided", async () => {
    const deposit = await agent
      .post(`/api/factory/employees/${employeeId}/deposit`)
      .send({ amount: "25.50", date: "2026-10-01", notes: `${TEST_PREFIX} deposit` });
    expect(deposit.status).toBe(200);
    const voucherId = Number(deposit.body.voucher.id);
    expect(deposit.body.voucher.voucherNumber).not.toMatch(/^EMP-DEP-/);
    expect(await employeeBalances()).toEqual({
      current_balance: "35.50",
      total_deposits: "35.50",
      total_withdrawals: "0.00",
    });

    const voided = await agent.delete(`/api/factory/daybook/entry/-${voucherId}/void`);
    expect(voided.status).toBe(200);

    const voucher = await pool.query<{ deleted_at: string | null }>(`SELECT deleted_at FROM vouchers WHERE id = $1`, [
      voucherId,
    ]);
    expect(voucher.rows[0]?.deleted_at).not.toBeNull();
    expect(await employeeBalances()).toEqual({
      current_balance: "10.00",
      total_deposits: "10.00",
      total_withdrawals: "0.00",
    });
  });
});

describe("ERP payroll run payment, undo and re-pay", () => {
  async function createDraftRun(): Promise<number> {
    runSeq += 1;
    const run = await pool.query<{ id: number }>(
      `INSERT INTO erp_payroll_runs (company_id, status, date, created_at)
       VALUES ($1, 'DRAFT', '2026-10-05', '2026-10-05') RETURNING id`,
      [ctx.companyId]
    );
    const runId = run.rows[0].id;
    await pool.query(
      `INSERT INTO erp_payroll_run_items (run_id, employee_id, employee_name, base_salary, deduction, net_pay)
       VALUES ($1, $2, $3, '120.00', '0', '120.00')`,
      [runId, employeeId, `${TEST_PREFIX} run ${runSeq}`]
    );
    return runId;
  }

  async function runVouchers(runId: number) {
    const result = await pool.query<{ id: number; voucher_number: string; deleted_at: string | null }>(
      `SELECT id, voucher_number, deleted_at FROM vouchers
        WHERE company_id = $1 AND (voucher_number LIKE $2 OR original_voucher_number LIKE $2)
        ORDER BY id`,
      [ctx.companyId, `SAL-${runId}-%`]
    );
    return result.rows;
  }

  it("keeps the SAL- family number, undoes the payment and posts a new one on re-pay", async () => {
    const runId = await createDraftRun();
    const pay = () =>
      agent.patch(`/api/payroll/runs/${runId}`).send({ action: "pay", paymentAccountId: ctx.cashAccountId });

    expect((await pay()).status).toBe(200);
    const first = await runVouchers(runId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ voucher_number: `SAL-${runId}-1`, deleted_at: null });

    const undo = await agent.post(`/api/payroll/runs/${runId}/undo`).send({});
    expect(undo.status).toBe(200);
    const afterUndo = await runVouchers(runId);
    expect(afterUndo).toHaveLength(1);
    expect(afterUndo[0]?.deleted_at).not.toBeNull();

    expect((await pay()).status).toBe(200);
    const afterRepay = await runVouchers(runId);
    expect(afterRepay).toHaveLength(2);
    expect(afterRepay[1]).toMatchObject({ voucher_number: `SAL-${runId}-2`, deleted_at: null });
    expect(afterRepay[1]?.id).not.toBe(first[0]?.id);

    const legs = await pool.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(debit_amount), 0)::text AS debit, COALESCE(SUM(credit_amount), 0)::text AS credit
         FROM voucher_entries WHERE voucher_id = $1`,
      [afterRepay[1]?.id]
    );
    expect(legs.rows[0]).toEqual({ debit: "120.00", credit: "120.00" });
  });
});
