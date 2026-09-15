/**
 * Phase 20 backend coverage — complete factory payroll lifecycle.
 *
 * Covers the production path end to end with real PostgreSQL rows:
 * advance -> generate -> generation replay -> pay -> payment replay -> paid undo
 * -> draft cancel -> regenerate. The assertions pin the ledger, cash, Daybook,
 * advance-repayment and retry invariants together so one surface cannot drift
 * while another still looks correct.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p20life";
const PERIOD_START = "2026-08-01";
const PERIOD_END = "2026-08-31";
const PAYMENT_DATE = "2026-09-01";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let workerId: number;
let advanceId: number;
let firstPayrollId: number;

type PayrollState = {
  id: number;
  status: string;
  advances: string;
  net_salary: string;
  cash_account_id: number | null;
};

async function payrollState(id: number): Promise<PayrollState | null> {
  const result = await pool.query<PayrollState>(
    `SELECT id, status, advances, net_salary, cash_account_id
       FROM factory_payrolls
      WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function advanceState() {
  const result = await pool.query<{ remaining_balance: string; fully_paid: boolean }>(
    `SELECT remaining_balance, fully_paid
       FROM factory_worker_advances
      WHERE id = $1`,
    [advanceId]
  );
  return result.rows[0];
}

async function repaymentCount(payrollId: number): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM factory_advance_repayments
      WHERE company_id = $1 AND payroll_id = $2`,
    [ctx.companyId, payrollId]
  );
  return result.rows[0].count;
}

async function daybookCount(payrollId: number, txType: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM factory_daybook_entries
      WHERE company_id = $1
        AND reference_table = 'factory_payrolls'
        AND reference_id = $2
        AND tx_type = $3`,
    [ctx.companyId, payrollId, txType]
  );
  return result.rows[0].count;
}

async function paymentVouchers(payrollId: number) {
  const result = await pool.query<{ id: number; total_amount: string }>(
    `SELECT id, total_amount
       FROM vouchers
      WHERE company_id = $1
        AND voucher_number LIKE $2
      ORDER BY id`,
    [ctx.companyId, `PAYMENT-PAY-${payrollId}-%`]
  );
  return result.rows;
}

async function voucherLegs(voucherId: number) {
  const result = await pool.query<{
    ledger_account_id: number;
    debit_amount: string;
    credit_amount: string;
  }>(
    `SELECT ledger_account_id, debit_amount, credit_amount
       FROM voucher_entries
      WHERE voucher_id = $1
      ORDER BY id`,
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

  const worker = await pool.query<{ id: number }>(
    `INSERT INTO factory_workers
       (company_id, full_name, salary_type, base_salary, active)
     VALUES ($1, $2, 'Monthly', '1000.00', true)
     RETURNING id`,
    [ctx.companyId, `${PREFIX} Worker`]
  );
  workerId = worker.rows[0].id;
}, 120_000);

afterAll(async () => {
  if (ctx) {
    await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_advance_repayments WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_worker_advances WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_payrolls WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
    await cleanupTestData(PREFIX);
  }
  closeTestServer();
}, 120_000);

describe.sequential("Phase 20 payroll lifecycle", () => {
  it("records an advance with balanced cash accounting and Daybook evidence", async () => {
    const response = await agent.post(`/api/factory/workers/${workerId}/advances`).send({
      companyId: ctx.companyId,
      amount: "200.00",
      advanceDate: "2026-07-20",
      cashAccountId: ctx.cashAccountId,
      repaymentType: "salary_deduction",
      notes: "Phase 20 lifecycle advance",
    });

    expect(response.status, response.text).toBe(200);
    advanceId = Number(response.body.id);
    expect(advanceId).toBeGreaterThan(0);
    expect(Number(response.body.voucherId)).toBeGreaterThan(0);

    const legs = await voucherLegs(Number(response.body.voucherId));
    expect(legs).toHaveLength(2);
    expect(legs.reduce((sum, row) => sum + Number(row.debit_amount), 0)).toBeCloseTo(200, 2);
    expect(legs.reduce((sum, row) => sum + Number(row.credit_amount), 0)).toBeCloseTo(200, 2);
    expect(legs.find((row) => row.ledger_account_id === ctx.cashAccountId)?.credit_amount).toBe("200.00");

    const daybook = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM factory_daybook_entries
        WHERE company_id = $1
          AND reference_table = 'factory_worker_advances'
          AND reference_id = $2
          AND tx_type = 'ADVANCE_GIVEN'`,
      [ctx.companyId, advanceId]
    );
    expect(daybook.rows[0].count).toBe(1);
    expect(Number((await advanceState()).remaining_balance)).toBeCloseTo(200, 2);
  });

  it("generates once, deducts the advance once, and safely replays the same period", async () => {
    const body = { companyId: ctx.companyId, startDate: PERIOD_START, endDate: PERIOD_END };
    const first = await agent.post("/api/factory/payroll/generate").send(body);

    expect(first.status, first.text).toBe(200);
    expect(first.body).toHaveLength(1);
    firstPayrollId = Number(first.body[0].id);
    expect(firstPayrollId).toBeGreaterThan(0);

    const state = await payrollState(firstPayrollId);
    expect(state?.status).toBe("DRAFT");
    expect(Number(state?.advances)).toBeCloseTo(200, 2);
    expect(Number(state?.net_salary)).toBeCloseTo(800, 2);
    expect(Number((await advanceState()).remaining_balance)).toBeCloseTo(0, 2);
    expect((await advanceState()).fully_paid).toBe(true);
    expect(await repaymentCount(firstPayrollId)).toBe(1);
    expect(await daybookCount(firstPayrollId, "PAYROLL_GENERATED")).toBe(1);

    const replay = await agent.post("/api/factory/payroll/generate").send(body);
    expect(replay.status, replay.text).toBe(200);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(replay.body).toHaveLength(1);
    expect(Number(replay.body[0].id)).toBe(firstPayrollId);
    expect(await repaymentCount(firstPayrollId)).toBe(1);
    expect(await daybookCount(firstPayrollId, "PAYROLL_GENERATED")).toBe(1);
    expect(Number((await advanceState()).remaining_balance)).toBeCloseTo(0, 2);
  });

  it("pays through cash/ledger/Daybook exactly once across an idempotent retry", async () => {
    const payment = {
      companyId: ctx.companyId,
      cashAccountId: ctx.cashAccountId,
      paymentDate: PAYMENT_DATE,
      clientRequestId: `${PREFIX}-pay-first`,
    };

    const first = await agent
      .patch(`/api/factory/payrolls/${firstPayrollId}/mark-paid`)
      .set("X-Idempotency-Key", `${PREFIX}-pay-first`)
      .send(payment);
    expect(first.status, first.text).toBe(200);

    const retry = await agent
      .patch(`/api/factory/payrolls/${firstPayrollId}/mark-paid`)
      .set("X-Idempotency-Key", `${PREFIX}-pay-first`)
      .send(payment);
    expect(retry.status, retry.text).toBe(200);
    expect(Number(retry.body.id)).toBe(firstPayrollId);

    const state = await payrollState(firstPayrollId);
    expect(state?.status).toBe("PAID");
    expect(state?.cash_account_id).toBe(ctx.cashAccountId);

    const vouchers = await paymentVouchers(firstPayrollId);
    expect(vouchers).toHaveLength(1);
    expect(Number(vouchers[0].total_amount)).toBeCloseTo(800, 2);
    const legs = await voucherLegs(vouchers[0].id);
    expect(legs).toHaveLength(2);
    expect(legs.reduce((sum, row) => sum + Number(row.debit_amount), 0)).toBeCloseTo(800, 2);
    expect(legs.reduce((sum, row) => sum + Number(row.credit_amount), 0)).toBeCloseTo(800, 2);
    expect(legs.find((row) => row.ledger_account_id === ctx.cashAccountId)?.credit_amount).toBe("800.00");
    expect(await daybookCount(firstPayrollId, "PAYROLL_PAYMENT")).toBe(1);
  });

  it("reverses payment without reversing generation or the already-applied advance", async () => {
    const undo = await agent.post(`/api/factory/payroll/${firstPayrollId}/undo`).send({});
    expect(undo.status, undo.text).toBe(200);
    expect(undo.body.previousStatus).toBe("PAID");

    const state = await payrollState(firstPayrollId);
    expect(state?.status).toBe("DRAFT");
    expect(state?.cash_account_id).toBeNull();
    expect(Number(state?.advances)).toBeCloseTo(200, 2);
    expect(await paymentVouchers(firstPayrollId)).toHaveLength(0);
    expect(await daybookCount(firstPayrollId, "PAYROLL_PAYMENT")).toBe(0);
    expect(await daybookCount(firstPayrollId, "PAYROLL_GENERATED")).toBe(1);

    // Undoing payment is not the same thing as cancelling generation. The
    // salary advance was consumed when payroll was generated, so it must stay
    // settled while the generated DRAFT still exists.
    expect(Number((await advanceState()).remaining_balance)).toBeCloseTo(0, 2);
    expect((await advanceState()).fully_paid).toBe(true);
    expect(await repaymentCount(firstPayrollId)).toBe(1);
  });

  it("can pay again after reversal without duplicating the prior payment", async () => {
    const response = await agent
      .patch(`/api/factory/payrolls/${firstPayrollId}/mark-paid`)
      .set("X-Idempotency-Key", `${PREFIX}-pay-second`)
      .send({
        companyId: ctx.companyId,
        cashAccountId: ctx.cashAccountId,
        paymentDate: "2026-09-02",
        clientRequestId: `${PREFIX}-pay-second`,
      });

    expect(response.status, response.text).toBe(200);
    expect(await paymentVouchers(firstPayrollId)).toHaveLength(1);
    expect(await daybookCount(firstPayrollId, "PAYROLL_PAYMENT")).toBe(1);
    expect(Number((await advanceState()).remaining_balance)).toBeCloseTo(0, 2);
  });

  it("cancels the generated draft, restores its advance, then regenerates cleanly", async () => {
    const reversePaid = await agent.post(`/api/factory/payroll/${firstPayrollId}/undo`).send({});
    expect(reversePaid.status, reversePaid.text).toBe(200);
    expect((await payrollState(firstPayrollId))?.status).toBe("DRAFT");

    const cancelDraft = await agent.post(`/api/factory/payroll/${firstPayrollId}/undo`).send({});
    expect(cancelDraft.status, cancelDraft.text).toBe(200);
    expect(cancelDraft.body.previousStatus).toBe("DRAFT");
    expect(await payrollState(firstPayrollId)).toBeNull();
    expect(await repaymentCount(firstPayrollId)).toBe(0);
    expect(await daybookCount(firstPayrollId, "PAYROLL_GENERATED")).toBe(0);
    expect(Number((await advanceState()).remaining_balance)).toBeCloseTo(200, 2);
    expect((await advanceState()).fully_paid).toBe(false);

    const regenerated = await agent.post("/api/factory/payroll/generate").send({
      companyId: ctx.companyId,
      startDate: PERIOD_START,
      endDate: PERIOD_END,
    });
    expect(regenerated.status, regenerated.text).toBe(200);
    expect(regenerated.body).toHaveLength(1);
    const regeneratedId = Number(regenerated.body[0].id);
    expect(regeneratedId).toBeGreaterThan(0);
    expect(regeneratedId).not.toBe(firstPayrollId);

    const state = await payrollState(regeneratedId);
    expect(Number(state?.advances)).toBeCloseTo(200, 2);
    expect(Number(state?.net_salary)).toBeCloseTo(800, 2);
    expect(await repaymentCount(regeneratedId)).toBe(1);
    expect(await daybookCount(regeneratedId, "PAYROLL_GENERATED")).toBe(1);
    expect(Number((await advanceState()).remaining_balance)).toBeCloseTo(0, 2);
  });
});
