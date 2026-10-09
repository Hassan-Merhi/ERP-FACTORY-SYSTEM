/**
 * Behavioural coverage for the three company-wide advance maintenance routes.
 *
 * All three were guard-only, and all three act on every advance in the company
 * at once rather than on one record — which is what makes them worth pinning.
 * A mistake here does not damage one worker's balance, it rewrites the lot.
 *
 * What is pinned here:
 *
 *   - **Reconcile rebuilds balances from first principles.** Each advance is
 *     reset to its original amount less manual repayments, then the worker's
 *     total payroll deductions are applied oldest advance first. That ordering
 *     is the whole behaviour: applied newest-first, the same total would leave
 *     a different advance outstanding, and `fully_paid` would land on the wrong
 *     record.
 *   - **Deductions never push a balance below zero**, and an advance settled to
 *     zero is marked `fully_paid`.
 *   - **Posting accounting is idempotent.** An advance that already has a
 *     `PAYMENT-ADV-` voucher is skipped rather than posted again — the check is
 *     a scan of voucher numbers, so a second run would otherwise double every
 *     advance in the ledger. The voucher is dated to the advance, not to today.
 *   - **Bulk cash-account update patches the existing voucher's credit leg**
 *     instead of writing a second voucher for the same advance. Two vouchers
 *     for one advance credit two different cash accounts for money that left
 *     once.
 * Worth noting and not changed here: posting and the bulk update are behind an
 * Admin/Owner role check, reconcile is not. Reconcile only recomputes from data
 * already recorded, so it cannot invent a balance — but it can move which
 * advance is marked settled, which is more than a read.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "advmgt";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let workerId: number;
let secondCashAccountId: number;

async function createAdvance(fields: {
  amount: string;
  advanceDate: string;
  remaining?: string;
  cashAccountId?: number | null;
  repaymentType?: string;
}): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_worker_advances
       (company_id, worker_id, advance_date, amount, remaining_balance, cash_account_id, repayment_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      ctx.companyId,
      workerId,
      fields.advanceDate,
      fields.amount,
      fields.remaining ?? fields.amount,
      fields.cashAccountId ?? null,
      fields.repaymentType ?? "salary_deduction",
    ]
  );
  return result.rows[0].id;
}

async function advanceRow(id: number) {
  const result = await pool.query<{ remaining_balance: string; fully_paid: boolean; cash_account_id: number | null }>(
    `SELECT remaining_balance, fully_paid, cash_account_id FROM factory_worker_advances WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

/** A payroll row carrying the total advance deduction taken that period. */
async function createPayrollWithDeduction(advances: string, periodStart: string) {
  await pool.query(
    `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, advances, net_salary, status)
     VALUES ($1, $2, $3, $3, $4, '0', 'PAID')`,
    [ctx.companyId, workerId, periodStart, advances]
  );
}

async function addManualRepayment(advanceId: number, amount: string) {
  await pool.query(
    `INSERT INTO factory_advance_repayments (company_id, advance_id, worker_id, repayment_date, amount)
     VALUES ($1, $2, $3, '2026-05-15', $4)`,
    [ctx.companyId, advanceId, workerId, amount]
  );
}

async function advanceVouchers(advanceId: number) {
  const result = await pool.query<{ id: number; voucher_date: string; total_amount: string }>(
    `SELECT id, voucher_date::text AS voucher_date, total_amount FROM vouchers
     WHERE company_id = $1 AND voucher_number LIKE $2 ORDER BY id`,
    [ctx.companyId, `PAYMENT-ADV-${advanceId}-%`]
  );
  return result.rows;
}

async function legsOf(voucherId: number) {
  const result = await pool.query<{ ledger_account_id: number; debit_amount: string; credit_amount: string }>(
    `SELECT ledger_account_id, debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
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

  const worker = await pool.query<{ id: number }>(
    `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Worker`]
  );
  workerId = worker.rows[0].id;

  const second = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type)
     VALUES ($1, '9101', $2, 'Asset') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Second Cash`]
  );
  secondCashAccountId = second.rows[0].id;
}, 120000);

beforeEach(async () => {
  await pool.query(`DELETE FROM factory_advance_repayments WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_worker_advances WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_payrolls WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM voucher_entries WHERE voucher_id IN
       (SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'PAYMENT-ADV-%')`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'PAYMENT-ADV-%'`, [
    ctx.companyId,
  ]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM factory_advance_repayments WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_worker_advances WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_payrolls WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/advances/reconcile", () => {
  it("applies the worker's payroll deductions to the oldest advance first", async () => {
    const older = await createAdvance({ amount: "100.00", advanceDate: "2026-01-10", remaining: "100.00" });
    const newer = await createAdvance({ amount: "100.00", advanceDate: "2026-03-10", remaining: "100.00" });
    await createPayrollWithDeduction("120.00", "2026-04-01");

    const response = await agent.post("/api/factory/advances/reconcile").send({});
    expect(response.status).toBe(200);

    // 120 taken oldest-first settles the January advance entirely and leaves 80
    // of March outstanding. Newest-first would leave the same total owed but
    // mark the wrong advance paid, and the oldest debt would never clear.
    const olderRow = await advanceRow(older);
    expect(Number(olderRow.remaining_balance)).toBeCloseTo(0, 2);
    expect(olderRow.fully_paid).toBe(true);

    const newerRow = await advanceRow(newer);
    expect(Number(newerRow.remaining_balance)).toBeCloseTo(80, 2);
    expect(newerRow.fully_paid).toBe(false);
  });

  it("subtracts manual repayments before applying payroll deductions", async () => {
    const advanceId = await createAdvance({ amount: "200.00", advanceDate: "2026-01-10", remaining: "200.00" });
    await addManualRepayment(advanceId, "50.00");
    await createPayrollWithDeduction("30.00", "2026-04-01");

    expect((await agent.post("/api/factory/advances/reconcile").send({})).status).toBe(200);

    // 200 lent, 50 repaid by hand, 30 taken from wages.
    expect(Number((await advanceRow(advanceId)).remaining_balance)).toBeCloseTo(120, 2);
  });

  it("never drives a balance below zero however large the deductions", async () => {
    const advanceId = await createAdvance({ amount: "50.00", advanceDate: "2026-01-10", remaining: "50.00" });
    await createPayrollWithDeduction("500.00", "2026-04-01");

    expect((await agent.post("/api/factory/advances/reconcile").send({})).status).toBe(200);

    const row = await advanceRow(advanceId);
    expect(Number(row.remaining_balance)).toBeCloseTo(0, 2);
    expect(row.fully_paid).toBe(true);
  });

  it("recomputes from scratch, so a corrupted balance is repaired", async () => {
    // The stored balance is nonsense; nothing was ever repaid.
    const advanceId = await createAdvance({ amount: "300.00", advanceDate: "2026-01-10", remaining: "5.00" });

    expect((await agent.post("/api/factory/advances/reconcile").send({})).status).toBe(200);

    // Reconcile derives the balance rather than adjusting it, which is what
    // makes it a repair tool rather than another way to drift.
    expect(Number((await advanceRow(advanceId)).remaining_balance)).toBeCloseTo(300, 2);
  });

  it("settles an advance exactly when cents of repayments and deductions add up to it", async () => {
    const settled = await createAdvance({ amount: "0.70", advanceDate: "2026-01-10", remaining: "0.70" });
    const next = await createAdvance({ amount: "5.00", advanceDate: "2026-02-10", remaining: "5.00" });
    await addManualRepayment(settled, "0.10");
    await createPayrollWithDeduction("0.20", "2026-04-01");
    await createPayrollWithDeduction("0.40", "2026-05-01");

    const response = await agent.post("/api/factory/advances/reconcile").send({});
    expect(response.status).toBe(200);

    expect(await advanceRow(settled)).toMatchObject({ remaining_balance: "0.00", fully_paid: true });
    // Nothing is left over to spill into the next advance.
    expect(await advanceRow(next)).toMatchObject({ remaining_balance: "5.00", fully_paid: false });
    expect(response.body.message).toBe("Reconciliation complete — 1 advance record(s) updated");
  });

  it("leaves manual-repayment advances out of the payroll sweep", async () => {
    const advanceId = await createAdvance({
      amount: "100.00",
      advanceDate: "2026-01-10",
      remaining: "100.00",
      repaymentType: "manual_repayment",
    });
    await createPayrollWithDeduction("100.00", "2026-04-01");

    expect((await agent.post("/api/factory/advances/reconcile").send({})).status).toBe(200);

    // This advance is not repaid from wages, so a wage deduction must not
    // touch it — that deduction belongs to some other advance.
    expect(Number((await advanceRow(advanceId)).remaining_balance)).toBeCloseTo(100, 2);
  });
});

describe("POST /api/factory/advances/post-accounting", () => {
  it("posts Dr Factory Worker Advances / Cr cash dated to the advance", async () => {
    const advanceId = await createAdvance({ amount: "250.00", advanceDate: "2026-02-14" });

    const response = await agent
      .post("/api/factory/advances/post-accounting")
      .send({ cashAccountId: ctx.cashAccountId });
    expect(response.status).toBe(200);
    expect(response.body.posted).toBe(1);

    const [voucher] = await advanceVouchers(advanceId);
    // Backfilled accounting belongs in the period the money left, not today.
    expect(voucher.voucher_date).toBe("2026-02-14");
    expect(Number(voucher.total_amount)).toBeCloseTo(250, 2);

    const legs = await legsOf(voucher.id);
    const cashLeg = legs.find((leg) => leg.ledger_account_id === ctx.cashAccountId);
    const advancesLeg = legs.find((leg) => leg.ledger_account_id !== ctx.cashAccountId);
    expect(Number(advancesLeg?.debit_amount)).toBeCloseTo(250, 2);
    expect(Number(cashLeg?.credit_amount)).toBeCloseTo(250, 2);

    expect((await advanceRow(advanceId)).cash_account_id).toBe(ctx.cashAccountId);
  });

  it("does not post the same advance twice", async () => {
    const advanceId = await createAdvance({ amount: "80.00", advanceDate: "2026-02-14" });
    await agent.post("/api/factory/advances/post-accounting").send({ cashAccountId: ctx.cashAccountId });

    const second = await agent.post("/api/factory/advances/post-accounting").send({ cashAccountId: ctx.cashAccountId });

    // The guard is a scan of PAYMENT-ADV- voucher numbers. Without it a second
    // run doubles every advance the company has ever given.
    expect(second.status).toBe(200);
    expect(second.body.posted).toBe(0);
    expect(await advanceVouchers(advanceId)).toHaveLength(1);
  });

  it("requires a cash account belonging to this company", async () => {
    await createAdvance({ amount: "10.00", advanceDate: "2026-02-14" });

    expect((await agent.post("/api/factory/advances/post-accounting").send({})).status).toBe(400);

    const foreign = await pool.query<{ id: number }>(
      `SELECT id FROM ledger_accounts WHERE company_id <> $1 ORDER BY id LIMIT 1`,
      [ctx.companyId]
    );
    if (foreign.rowCount && foreign.rowCount > 0) {
      const response = await agent
        .post("/api/factory/advances/post-accounting")
        .send({ cashAccountId: foreign.rows[0].id });
      expect(response.status).toBe(400);
    }
  });
});

describe("POST /api/factory/advances/bulk-update-cash-account", () => {
  it("repoints an existing voucher's credit leg rather than writing a second voucher", async () => {
    const advanceId = await createAdvance({ amount: "150.00", advanceDate: "2026-02-14" });
    await agent.post("/api/factory/advances/post-accounting").send({ cashAccountId: ctx.cashAccountId });
    const [original] = await advanceVouchers(advanceId);

    const response = await agent
      .post("/api/factory/advances/bulk-update-cash-account")
      .send({ advanceIds: [advanceId], cashAccountId: secondCashAccountId });
    expect(response.status).toBe(200);

    // One advance, one voucher. A second voucher would credit two cash
    // accounts for money that left the business once.
    const after = await advanceVouchers(advanceId);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(original.id);

    const legs = await legsOf(original.id);
    const creditLeg = legs.find((leg) => Number(leg.credit_amount) > 0);
    expect(creditLeg?.ledger_account_id).toBe(secondCashAccountId);
    expect((await advanceRow(advanceId)).cash_account_id).toBe(secondCashAccountId);
  });

  it("creates the voucher when the advance never had one", async () => {
    const advanceId = await createAdvance({ amount: "60.00", advanceDate: "2026-02-14" });

    const response = await agent
      .post("/api/factory/advances/bulk-update-cash-account")
      .send({ advanceIds: [advanceId], cashAccountId: ctx.cashAccountId });

    expect(response.status).toBe(200);
    const vouchersForAdvance = await advanceVouchers(advanceId);
    expect(vouchersForAdvance).toHaveLength(1);
    const legs = await legsOf(vouchersForAdvance[0].id);
    const creditLeg = legs.find((leg) => Number(leg.credit_amount) > 0);
    expect(creditLeg?.ledger_account_id).toBe(ctx.cashAccountId);
  });

  it("ignores advances belonging to another company", async () => {
    const mine = await createAdvance({ amount: "20.00", advanceDate: "2026-02-14" });

    const response = await agent
      .post("/api/factory/advances/bulk-update-cash-account")
      .send({ advanceIds: [mine, 99999999], cashAccountId: ctx.cashAccountId });

    expect(response.status).toBe(200);
    expect(response.body.updated).toBe(1);
  });

  it("rejects an empty id list or a missing cash account", async () => {
    const advanceId = await createAdvance({ amount: "20.00", advanceDate: "2026-02-14" });
    expect(
      (await agent.post("/api/factory/advances/bulk-update-cash-account").send({ advanceIds: [], cashAccountId: 1 }))
        .status
    ).toBe(400);
    expect(
      (await agent.post("/api/factory/advances/bulk-update-cash-account").send({ advanceIds: [advanceId] })).status
    ).toBe(400);
  });
});
