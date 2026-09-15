/**
 * Behavioural coverage for the payroll payment routes in
 * `server/routes/payroll/core/mark-paid.ts`.
 *
 * All three were guard-only. These are the routes that move a payroll record
 * to PAID and post the payment into the ledger, so what they write is wages.
 *
 * What is pinned here:
 *
 *   - **The posting is Dr Payroll Payable / Cr cash.** Paying wages settles a
 *     liability with cash. Reversed, the company would look like it had been
 *     paid the wages rather than having paid them, and the payable would grow
 *     with every run.
 *   - **No cash account means no voucher.** A payroll can be marked paid
 *     without nominating one — cash handed over outside the ledger — and in
 *     that case nothing may reach `vouchers` at all. A voucher with one leg is
 *     worse than none.
 *   - **Pending production bonuses block payment.** A payroll with undecided
 *     bonus allocations is not final: paying it fixes a net salary that the
 *     pending amounts were meant to change. The guard must reject with 409 and
 *     leave the record untouched — a 409 that had already flipped the status
 *     would be the worst of both.
 *   - **The bulk route's guard runs before the update.** It resolves every id
 *     against the company first and 404s the whole batch if any is unknown, so
 *     one bad id cannot half-pay a batch. `updated` counts deduplicated ids.
 *   - **`fix-accounting` is for payrolls that were paid without a voucher.**
 *     It refuses a payroll that already has a cash account, because posting
 *     again would double the payment, and refuses one still in DRAFT.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mkpaid";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let workerId: number;
let positionId: number;

interface PayrollRow {
  id: number;
  status: string;
  cash_account_id: number | null;
  paid_at: string | null;
  net_salary: string | null;
}

async function payrollRow(id: number): Promise<PayrollRow | null> {
  const result = await pool.query<PayrollRow>(
    `SELECT id, status, cash_account_id, paid_at, net_salary FROM factory_payrolls WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function createPayroll(netSalary: string, status = "APPROVED"): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, net_salary, status)
     VALUES ($1, $2, '2026-05-01', '2026-05-31', $3, $4) RETURNING id`,
    [ctx.companyId, workerId, netSalary, status]
  );
  return result.rows[0].id;
}

async function payrollLegs(payrollId: number) {
  const result = await pool.query<{ ledger_account_id: number; debit_amount: string; credit_amount: string }>(
    `SELECT ve.ledger_account_id, ve.debit_amount, ve.credit_amount
     FROM voucher_entries ve
     JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = $1 AND v.voucher_number LIKE $2
     ORDER BY ve.id`,
    [ctx.companyId, `PAYMENT-PAY-${payrollId}-%`]
  );
  return result.rows;
}

async function payrollVouchers(payrollId: number) {
  const result = await pool.query<{ id: number; total_amount: string; voucher_date: string }>(
    `SELECT id, total_amount, voucher_date::text AS voucher_date FROM vouchers
     WHERE company_id = $1 AND voucher_number LIKE $2`,
    [ctx.companyId, `PAYMENT-PAY-${payrollId}-%`]
  );
  return result.rows;
}

/** The payable side is resolved by name, so the test finds it the same way. */
async function payableAccountId(): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM ledger_accounts WHERE company_id = $1 AND name = 'Payroll Payable'`,
    [ctx.companyId]
  );
  return result.rows[0].id;
}

/** An undecided bonus allocation attached to a payroll, which must block payment. */
let bonusRunSeq = 0;

async function attachPendingBonus(payrollId: number, amount: string) {
  // One run per production date per position, so each call takes its own date.
  bonusRunSeq += 1;
  const productionDate = `2026-05-${String(bonusRunSeq).padStart(2, "0")}`;
  const run = await pool.query<{ id: number }>(
    `INSERT INTO factory_production_bonus_runs
       (company_id, production_date, position_id, position_name_snapshot, target_bales, actual_bales,
        extra_bales, bonus_per_extra_bale, bonus_pool, member_count, status)
     VALUES ($1, $2, $3, $4, 10, 12, 2, '5.00', $5, 1, 'PENDING') RETURNING id`,
    [ctx.companyId, productionDate, positionId, `${TEST_PREFIX} Position`, amount]
  );
  await pool.query(
    `INSERT INTO factory_production_bonus_allocations
       (company_id, run_id, worker_id, worker_name_snapshot, amount, decision_status, payroll_id)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)`,
    [ctx.companyId, run.rows[0].id, workerId, `${TEST_PREFIX} Worker`, amount, payrollId]
  );
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

  const worker = await pool.query<{ id: number }>(
    `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Worker`]
  );
  workerId = worker.rows[0].id;

  const position = await pool.query<{ id: number }>(
    `INSERT INTO factory_production_positions (company_id, name) VALUES ($1, $2) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Position`]
  );
  positionId = position.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM factory_production_bonus_allocations WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_production_bonus_runs WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_production_positions WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_payrolls WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("PATCH /api/factory/payrolls/:id/mark-paid", () => {
  it("marks the payroll paid and posts Dr Payroll Payable / Cr cash", async () => {
    const payrollId = await createPayroll("900.00");

    const response = await agent
      .patch(`/api/factory/payrolls/${payrollId}/mark-paid`)
      .send({ cashAccountId: ctx.cashAccountId, paymentDate: "2026-06-05" });
    expect(response.status).toBe(200);

    const row = await payrollRow(payrollId);
    expect(row?.status).toBe("PAID");
    expect(row?.cash_account_id).toBe(ctx.cashAccountId);
    expect(row?.paid_at).not.toBeNull();

    const legs = await payrollLegs(payrollId);
    expect(legs).toHaveLength(2);
    const payableId = await payableAccountId();
    const cashLeg = legs.find((leg) => leg.ledger_account_id === ctx.cashAccountId);
    const payableLeg = legs.find((leg) => leg.ledger_account_id === payableId);

    // Paying wages settles a liability with cash. Run the other way, the
    // payable grows with every run and the company reads as having been paid.
    expect(Number(payableLeg?.debit_amount)).toBeCloseTo(900, 2);
    expect(Number(payableLeg?.credit_amount)).toBeCloseTo(0, 2);
    expect(Number(cashLeg?.credit_amount)).toBeCloseTo(900, 2);
    expect(Number(cashLeg?.debit_amount)).toBeCloseTo(0, 2);

    const [voucher] = await payrollVouchers(payrollId);
    expect(Number(voucher.total_amount)).toBeCloseTo(900, 2);
    expect(voucher.voucher_date).toBe("2026-06-05");
  });

  it("refuses to pay a non-zero payroll with no cash account nominated", async () => {
    const payrollId = await createPayroll("400.00");

    // Paying real cash with no account nominated used to succeed and write no
    // voucher, which put the payment outside the ledger entirely. Every payment
    // flow now has to name the account the cash left.
    const response = await agent.patch(`/api/factory/payrolls/${payrollId}/mark-paid`).send({});
    expect(response.status).toBe(400);

    expect((await payrollRow(payrollId))?.status).toBe("APPROVED");
    expect(await payrollVouchers(payrollId)).toHaveLength(0);
  });

  it("writes no voucher for a zero-value payroll", async () => {
    const payrollId = await createPayroll("0.00");

    const response = await agent.patch(`/api/factory/payrolls/${payrollId}/mark-paid`).send({});
    expect(response.status).toBe(200);

    const row = await payrollRow(payrollId);
    expect(row?.status).toBe("PAID");
    expect(row?.cash_account_id).toBeNull();
    // Nothing moved, so a voucher would post two zero legs and nothing else.
    expect(await payrollVouchers(payrollId)).toHaveLength(0);
  });

  it("refuses to pay a payroll with undecided production bonuses, leaving it unpaid", async () => {
    const payrollId = await createPayroll("500.00");
    await attachPendingBonus(payrollId, "75.00");

    const response = await agent
      .patch(`/api/factory/payrolls/${payrollId}/mark-paid`)
      .send({ cashAccountId: ctx.cashAccountId });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/pending production bonuses/i);

    // The pending amounts were meant to change the net salary. Paying now
    // fixes a figure that is not final — and a 409 that had already flipped
    // the status would be the worst of both.
    const row = await payrollRow(payrollId);
    expect(row?.status).toBe("APPROVED");
    expect(await payrollVouchers(payrollId)).toHaveLength(0);
  });

  it("returns 404 for an unknown payroll and 400 for a bad id", async () => {
    expect(
      (await agent.patch("/api/factory/payrolls/99999999/mark-paid").send({ cashAccountId: ctx.cashAccountId })).status
    ).toBe(404);
    expect((await agent.patch("/api/factory/payrolls/0/mark-paid").send({})).status).toBe(400);
  });
});

describe("PATCH /api/factory/payrolls/:id/fix-accounting", () => {
  it("posts the missing voucher and records the cash account", async () => {
    const payrollId = await createPayroll("300.00");
    await agent.patch(`/api/factory/payrolls/${payrollId}/mark-paid`).send({});
    expect((await payrollRow(payrollId))?.cash_account_id).toBeNull();

    const response = await agent
      .patch(`/api/factory/payrolls/${payrollId}/fix-accounting`)
      .send({ cashAccountId: ctx.cashAccountId });
    expect(response.status).toBe(200);

    const legs = await payrollLegs(payrollId);
    expect(legs).toHaveLength(2);
    const debits = legs.reduce((sum, leg) => sum + Number(leg.debit_amount), 0);
    const credits = legs.reduce((sum, leg) => sum + Number(leg.credit_amount), 0);
    expect(debits).toBeCloseTo(300, 2);
    expect(credits).toBeCloseTo(300, 2);

    expect((await payrollRow(payrollId))?.cash_account_id).toBe(ctx.cashAccountId);
  });

  it("refuses a payroll that already has a cash account", async () => {
    const payrollId = await createPayroll("200.00");
    await agent
      .patch(`/api/factory/payrolls/${payrollId}/mark-paid`)
      .send({ cashAccountId: ctx.cashAccountId, paymentDate: "2026-06-05" });

    const response = await agent
      .patch(`/api/factory/payrolls/${payrollId}/fix-accounting`)
      .send({ cashAccountId: ctx.cashAccountId });

    // The payment is already in the ledger. Posting again doubles it.
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/already exists/i);
    expect(await payrollLegs(payrollId)).toHaveLength(2);
  });

  it("refuses a payroll still in DRAFT", async () => {
    const payrollId = await createPayroll("150.00", "DRAFT");

    const response = await agent
      .patch(`/api/factory/payrolls/${payrollId}/fix-accounting`)
      .send({ cashAccountId: ctx.cashAccountId });

    expect(response.status).toBe(400);
    expect(await payrollVouchers(payrollId)).toHaveLength(0);
  });

  it("requires a cash account, and one belonging to this company", async () => {
    const payrollId = await createPayroll("100.00");
    await agent.patch(`/api/factory/payrolls/${payrollId}/mark-paid`).send({});

    expect((await agent.patch(`/api/factory/payrolls/${payrollId}/fix-accounting`).send({})).status).toBe(400);

    const foreign = await pool.query<{ id: number }>(
      `SELECT id FROM ledger_accounts WHERE company_id <> $1 ORDER BY id LIMIT 1`,
      [ctx.companyId]
    );
    if (foreign.rowCount && foreign.rowCount > 0) {
      const response = await agent
        .patch(`/api/factory/payrolls/${payrollId}/fix-accounting`)
        .send({ cashAccountId: foreign.rows[0].id });
      expect(response.status).toBe(400);
    }

    expect(await payrollVouchers(payrollId)).toHaveLength(0);
  });

  it("returns 404 for an unknown payroll", async () => {
    const response = await agent
      .patch("/api/factory/payrolls/99999999/fix-accounting")
      .send({ cashAccountId: ctx.cashAccountId });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/factory/payrolls/mark-paid-bulk", () => {
  it("pays every record in the batch, one voucher each", async () => {
    const first = await createPayroll("110.00");
    const second = await createPayroll("220.00");

    const response = await agent
      .post("/api/factory/payrolls/mark-paid-bulk")
      .send({ payrollIds: [first, second], cashAccountId: ctx.cashAccountId, paymentDate: "2026-06-06" });
    expect(response.status).toBe(200);
    expect(response.body.updated).toBe(2);

    for (const [payrollId, amount] of [
      [first, 110],
      [second, 220],
    ] as const) {
      expect((await payrollRow(payrollId))?.status).toBe("PAID");
      // One voucher per payroll record. A single voucher for the batch total
      // reconciles against cash and is untraceable per worker.
      expect(await payrollVouchers(payrollId)).toHaveLength(1);
      const legs = await payrollLegs(payrollId);
      expect(legs).toHaveLength(2);
      const cashLeg = legs.find((leg) => leg.ledger_account_id === ctx.cashAccountId);
      expect(Number(cashLeg?.credit_amount)).toBeCloseTo(amount, 2);
    }
  });

  it("counts a repeated id once", async () => {
    const payrollId = await createPayroll("50.00");

    const response = await agent
      .post("/api/factory/payrolls/mark-paid-bulk")
      .send({ payrollIds: [payrollId, payrollId, payrollId], cashAccountId: ctx.cashAccountId });

    expect(response.status).toBe(200);
    expect(response.body.updated).toBe(1);
  });

  it("rejects the whole batch when one id is unknown, paying none of it", async () => {
    const payrollId = await createPayroll("70.00");

    const response = await agent
      .post("/api/factory/payrolls/mark-paid-bulk")
      .send({ payrollIds: [payrollId, 99999999], cashAccountId: ctx.cashAccountId });

    expect(response.status).toBe(404);
    // The guard resolves every id against the company before touching a row,
    // so one bad id cannot half-pay a batch.
    expect((await payrollRow(payrollId))?.status).toBe("APPROVED");
    expect(await payrollVouchers(payrollId)).toHaveLength(0);
  });

  it("refuses a batch containing a payroll with undecided production bonuses", async () => {
    const clean = await createPayroll("80.00");
    const blocked = await createPayroll("90.00");
    await attachPendingBonus(blocked, "12.00");

    const response = await agent
      .post("/api/factory/payrolls/mark-paid-bulk")
      .send({ payrollIds: [clean, blocked], cashAccountId: ctx.cashAccountId });

    expect(response.status).toBe(409);
    expect((await payrollRow(clean))?.status).toBe("APPROVED");
    expect((await payrollRow(blocked))?.status).toBe("APPROVED");
  });

  it("rejects a missing, empty or entirely invalid id list", async () => {
    expect((await agent.post("/api/factory/payrolls/mark-paid-bulk").send({})).status).toBe(400);
    expect((await agent.post("/api/factory/payrolls/mark-paid-bulk").send({ payrollIds: [] })).status).toBe(400);
    expect((await agent.post("/api/factory/payrolls/mark-paid-bulk").send({ payrollIds: ["x", 0, -3] })).status).toBe(
      400
    );
  });
});
