/**
 * Wave 4 — bulk factory payroll generation (POST /api/factory/payrolls/generate-bulk)
 * against real PostgreSQL rows.
 *
 * One run covers three pay frequencies, a salary-deduction advance, a pending
 * worker deduction, a per-worker bonus and a transport allowance, and checks
 * that the payroll rows, the advance settlement, the deduction application
 * and the single PAYROLL-GEN expense journal all agree. Regenerating the same
 * period must replace — not duplicate — that journal.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "w4paybulk";
const PERIOD_START = "2026-08-01";
const PERIOD_END = "2026-08-31";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let monthlyId: number;
let dailyId: number;
let weeklyId: number;
let advanceId: number;
let deductionId: number;

async function insertWorker(fields: Record<string, string | number | boolean>) {
  const columns = Object.keys(fields);
  const values = Object.values(fields);
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_workers (company_id, ${columns.join(", ")})
     VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(", ")})
     RETURNING id`,
    [ctx.companyId, ...values]
  );
  return result.rows[0].id;
}

async function payrollFor(workerId: number) {
  const result = await pool.query(
    `SELECT id, base_salary, bonuses, transport, deductions, advances, net_salary, status
       FROM factory_payrolls WHERE company_id = $1 AND worker_id = $2 ORDER BY id`,
    [ctx.companyId, workerId]
  );
  return result.rows;
}

async function genVouchers() {
  const result = await pool.query<{ id: number; total_amount: string; description: string }>(
    `SELECT id, total_amount, description FROM vouchers
      WHERE company_id = $1 AND voucher_number LIKE 'PAYROLL-GEN-%' AND voucher_date = $2
      ORDER BY id`,
    [ctx.companyId, PERIOD_START]
  );
  return result.rows;
}

async function legs(voucherId: number) {
  const result = await pool.query<{ name: string; debit: string; credit: string }>(
    `SELECT la.name, ve.debit_amount AS debit, ve.credit_amount AS credit
       FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE ve.voucher_id = $1 ORDER BY ve.id`,
    [voucherId]
  );
  return result.rows;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app) as request.SuperAgentTest;
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`set-company failed: ${selected.status} ${selected.text}`);

  monthlyId = await insertWorker({
    full_name: `${PREFIX} Monthly`,
    salary_type: "Monthly",
    base_salary: "3100.00",
    transport_allowance: "100.00",
    active: true,
  });
  dailyId = await insertWorker({
    full_name: `${PREFIX} Daily`,
    salary_type: "Daily",
    base_salary: "50.00",
    active: true,
  });
  weeklyId = await insertWorker({
    full_name: `${PREFIX} Weekly`,
    salary_type: "Monthly",
    pay_frequency: "Weekly",
    base_salary: "0",
    weekly_salary: "140.00",
    active: true,
  });

  const advance = await pool.query<{ id: number }>(
    `INSERT INTO factory_worker_advances
       (company_id, worker_id, amount, remaining_balance, advance_date, repayment_type, fully_paid)
     VALUES ($1, $2, '500.00', '500.00', '2026-07-15', 'salary_deduction', false)
     RETURNING id`,
    [ctx.companyId, monthlyId]
  );
  advanceId = advance.rows[0].id;

  const deduction = await pool.query<{ id: number }>(
    `INSERT INTO factory_worker_deductions (company_id, worker_id, amount, reason, deduction_date, applied)
     VALUES ($1, $2, '20.00', 'Damaged sack', '2026-08-10', false)
     RETURNING id`,
    [ctx.companyId, dailyId]
  );
  deductionId = deduction.rows[0].id;
}, 120_000);

afterAll(async () => {
  if (ctx) {
    const cid = ctx.companyId;
    await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool
      .query(
        `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'PAYROLL-GEN-%')`,
        [cid]
      )
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'PAYROLL-GEN-%'`, [cid])
      .catch(() => undefined);
    await pool.query(`DELETE FROM factory_advance_repayments WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_worker_advances WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_worker_deductions WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_payrolls WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [cid]).catch(() => undefined);
    await cleanupTestData(PREFIX);
  }
  closeTestServer();
}, 120_000);

describe("bulk payroll generation", () => {
  it("rejects a request without period dates", async () => {
    const response = await agent.post("/api/factory/payrolls/generate-bulk").send({ companyId: ctx.companyId });
    expect(response.status).toBe(400);
  });

  it("generates draft payrolls for every active worker with pay, bonus, transport, advances and deductions", async () => {
    const response = await agent.post("/api/factory/payrolls/generate-bulk").send({
      companyId: ctx.companyId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      bonusPerWorker: "10",
      cashAccountId: String(ctx.cashAccountId),
      notes: "Wave 4 bulk run",
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.created).toBe(3);

    const [monthly] = await payrollFor(monthlyId);
    const [daily] = await payrollFor(dailyId);
    const [weekly] = await payrollFor(weeklyId);

    for (const row of [monthly, daily, weekly]) {
      expect(row.status).toBe("DRAFT");
      expect(Number(row.bonuses)).toBeCloseTo(10, 2);
      // net = base + bonus + transport - advances - deductions, to the cent.
      const expected =
        Number(row.base_salary) +
        Number(row.bonuses) +
        Number(row.transport) -
        Number(row.advances) -
        Number(row.deductions);
      expect(Number(row.net_salary)).toBeCloseTo(expected, 2);
    }

    // Daily: 31 days × 50; the pending deduction is applied to it.
    expect(Number(daily.base_salary)).toBeCloseTo(1550, 2);
    expect(Number(daily.deductions)).toBeCloseTo(20, 2);
    // Weekly: 31/7 of the weekly salary.
    expect(Number(weekly.base_salary)).toBeCloseTo((31 / 7) * 140, 2);
    // Monthly: full transport without attendance records; the advance is deducted in full.
    expect(Number(monthly.transport)).toBeCloseTo(100, 2);
    expect(Number(monthly.advances)).toBeCloseTo(500, 2);

    const advance = await pool.query(
      `SELECT remaining_balance, fully_paid FROM factory_worker_advances WHERE id = $1`,
      [advanceId]
    );
    expect(Number(advance.rows[0].remaining_balance)).toBeCloseTo(0, 2);
    expect(advance.rows[0].fully_paid).toBe(true);

    const deduction = await pool.query(`SELECT applied, payroll_id FROM factory_worker_deductions WHERE id = $1`, [
      deductionId,
    ]);
    expect(deduction.rows[0].applied).toBe(true);
    expect(deduction.rows[0].payroll_id).toBe(daily.id);
  });

  it("posts one balanced PAYROLL-GEN journal: per-worker expenses against payable and advances", async () => {
    const vouchers = await genVouchers();
    expect(vouchers).toHaveLength(1);
    const lines = await legs(vouchers[0].id);

    const debit = lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const credit = lines.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(debit).toBeCloseTo(credit, 2);
    expect(Number(vouchers[0].total_amount)).toBeCloseTo(debit, 2);

    const nets = [...(await payrollFor(monthlyId)), ...(await payrollFor(dailyId)), ...(await payrollFor(weeklyId))];
    const totalNet = nets.reduce((sum, row) => sum + Number(row.net_salary), 0);
    expect(Number(lines.find((l) => l.name === "Payroll Payable")?.credit)).toBeCloseTo(totalNet, 2);
    expect(Number(lines.find((l) => l.name === "Factory Worker Advances")?.credit)).toBeCloseTo(500, 2);

    // Every worker gets their own named salary and bonus expense lines.
    for (const name of ["Monthly", "Daily", "Weekly"]) {
      expect(lines.some((l) => l.name === `Salary Expense - ${PREFIX} ${name}` && Number(l.debit) > 0)).toBe(true);
      expect(lines.some((l) => l.name === `Bonus Expense - ${PREFIX} ${name}` && Number(l.debit) > 0)).toBe(true);
    }
  });

  it("replaces the period's expense journal instead of duplicating it when regenerated for chosen workers", async () => {
    const response = await agent.post("/api/factory/payrolls/generate-bulk").send({
      companyId: ctx.companyId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      workerIds: [dailyId],
      daysCount: "10",
      transportOverrides: { [String(dailyId)]: "0" },
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.created).toBe(1);

    const rows = await payrollFor(dailyId);
    expect(rows).toHaveLength(2);
    expect(Number(rows[1].base_salary)).toBeCloseTo(500, 2);
    expect(Number(rows[1].deductions)).toBeCloseTo(0, 2);

    const vouchers = await genVouchers();
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].description).toContain("1 worker");
  });

  it("caps an approved advance override at the worker's gross pay and balance", async () => {
    await pool.query(
      `INSERT INTO factory_worker_advances
         (company_id, worker_id, amount, remaining_balance, advance_date, repayment_type, fully_paid)
       VALUES ($1, $2, '80.00', '80.00', '2026-08-02', 'salary_deduction', false)`,
      [ctx.companyId, weeklyId]
    );
    const response = await agent.post("/api/factory/payrolls/generate-bulk").send({
      companyId: ctx.companyId,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-07",
      workerIds: [weeklyId],
      advanceOverrides: { [String(weeklyId)]: "30" },
    });
    expect(response.status, response.text).toBe(200);

    const rows = await payrollFor(weeklyId);
    const latest = rows[rows.length - 1];
    expect(Number(latest.base_salary)).toBeCloseTo(140, 2);
    expect(Number(latest.advances)).toBeCloseTo(30, 2);
    expect(Number(latest.net_salary)).toBeCloseTo(110, 2);

    const remaining = await pool.query(
      `SELECT COALESCE(SUM(remaining_balance::numeric), 0)::text AS total
         FROM factory_worker_advances WHERE worker_id = $1 AND fully_paid = false`,
      [weeklyId]
    );
    expect(Number(remaining.rows[0].total)).toBeCloseTo(50, 2);
  });
});
