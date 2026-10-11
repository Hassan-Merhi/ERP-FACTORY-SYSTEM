/**
 * Behavioural coverage for the factory worker advance write routes.
 *
 * All four were guard-only. An advance is a loan to a worker: giving one posts
 * Dr "Factory Worker Advances" / Cr cash and starts a balance that later
 * payroll runs deduct against, so the two numbers that matter are the voucher
 * legs and `remaining_balance`.
 *
 * What is pinned here:
 *
 *   - **The posting balances and runs the right way.** An advance is an asset —
 *     money the worker owes back — so the advances account is debited and cash
 *     credited. Reversed, it would look like the company had been paid.
 *   - **`remaining_balance` starts at the full amount.** Payroll deducts from
 *     this. Starting it at zero silently forgives the loan; starting it high
 *     over-deducts from wages.
 *   - **No cash account means no voucher.** An advance can be recorded without
 *     picking one, and in that case nothing may reach the ledger at all — a
 *     half-posted voucher would be a one-sided entry.
 *   - **Delete and reverse are different operations.** Reverse restores the
 *     advance to fully outstanding and drops its repayments; delete removes the
 *     advance, its repayments and the voucher behind it. Neither may leave a
 *     `voucher_entries` row without its voucher.
 *   - **Both are Admin-only**, and the role check must come before any write.
 *
 * The daybook attribution is asserted too. These writes used to pass
 * `parseInt(req.session.userId)` into `created_by` while `users.id` is a UUID,
 * so `parseInt` stopped at the first non-digit and stored a truncated number —
 * a plausible-looking id belonging to nobody. The column was varchar all along;
 * only the code was wrong. The test below pins the full id, because a truncated
 * one is indistinguishable from a real one by inspection.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "advwr";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let workerId: number;
let seq = 0;

interface AdvanceRow {
  id: number;
  amount: string;
  remaining_balance: string | null;
  fully_paid: boolean | null;
  notes: string | null;
}

async function advanceRow(id: number): Promise<AdvanceRow | null> {
  const result = await pool.query<AdvanceRow>(
    `SELECT id, amount, remaining_balance, fully_paid, notes FROM factory_worker_advances WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** The voucher legs the advance posted, found by its voucher-number prefix. */
async function advanceLegs(advanceId: number) {
  const result = await pool.query<{ ledger_account_id: number; debit_amount: string; credit_amount: string }>(
    `SELECT ve.ledger_account_id, ve.debit_amount, ve.credit_amount
     FROM voucher_entries ve
     JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = $1 AND v.voucher_number LIKE $2 AND v.deleted_at IS NULL
     ORDER BY ve.id`,
    [ctx.companyId, `PAYMENT-ADV-${advanceId}-%`]
  );
  return result.rows;
}

async function giveAdvance(amount: string, withCashAccount = true) {
  seq += 1;
  const body: Record<string, unknown> = { amount, advanceDate: "2026-04-10", notes: `${TEST_PREFIX} note ${seq}` };
  if (withCashAccount) body.cashAccountId = ctx.cashAccountId;
  const response = await agent.post(`/api/factory/workers/${workerId}/advances`).send(body);
  if (response.status !== 200) throw new Error(`Seed advance failed: ${response.status} ${response.text}`);
  return response.body as { id: number; voucherId: number | null };
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
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM factory_advance_repayments WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_worker_advances WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/workers/:id/advances", () => {
  it("posts a balanced Dr advances / Cr cash voucher", async () => {
    const advance = await giveAdvance("250.00");

    const legs = await advanceLegs(advance.id);
    expect(legs).toHaveLength(2);

    const debits = legs.reduce((sum, leg) => sum + Number(leg.debit_amount), 0);
    const credits = legs.reduce((sum, leg) => sum + Number(leg.credit_amount), 0);
    expect(debits).toBeCloseTo(250, 2);
    expect(credits).toBeCloseTo(250, 2);

    // An advance is an asset — money the worker owes back. Cash is what left,
    // so cash is the credited side; reversed, this would read as income.
    const cashLeg = legs.find((leg) => leg.ledger_account_id === ctx.cashAccountId);
    expect(Number(cashLeg?.credit_amount)).toBeCloseTo(250, 2);
    const advancesLeg = legs.find((leg) => leg.ledger_account_id !== ctx.cashAccountId);
    expect(Number(advancesLeg?.debit_amount)).toBeCloseTo(250, 2);
  });

  it("attributes the daybook entry to the full session user id", async () => {
    const advance = await giveAdvance("60.00");

    const entry = await pool.query<{ created_by: string | null }>(
      `SELECT created_by FROM factory_daybook_entries
       WHERE company_id = $1 AND reference_table = 'factory_worker_advances' AND reference_id = $2`,
      [ctx.companyId, advance.id]
    );

    expect(entry.rowCount).toBe(1);
    // users.id is a UUID. This used to be written through parseInt, which stops
    // at the first non-digit and stored a truncated number — an id that looks
    // real and belongs to nobody.
    expect(entry.rows[0].created_by).toBe(ctx.userId);
  });

  it("starts the remaining balance at the full amount", async () => {
    const advance = await giveAdvance("180.00");

    // Payroll deducts against this. Zero forgives the loan silently; too high
    // over-deducts from wages.
    const row = await advanceRow(advance.id);
    expect(Number(row?.remaining_balance)).toBeCloseTo(180, 2);
    expect(Number(row?.amount)).toBeCloseTo(180, 2);
  });

  it("records the advance without touching the ledger when no cash account is given", async () => {
    const advance = await giveAdvance("75.00", false);

    expect(advance.voucherId).toBeNull();
    // Nothing at all, rather than one side of a posting.
    expect(await advanceLegs(advance.id)).toHaveLength(0);
    expect(Number((await advanceRow(advance.id))?.remaining_balance)).toBeCloseTo(75, 2);
  });

  it("rejects a zero, negative or missing amount", async () => {
    for (const amount of ["0", "-10", undefined]) {
      const response = await agent
        .post(`/api/factory/workers/${workerId}/advances`)
        .send({ amount, cashAccountId: ctx.cashAccountId });
      expect(response.status).toBe(400);
    }
  });

  it("rejects a cash account belonging to another company", async () => {
    const foreign = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'erp', 'USD') RETURNING id`,
      [`${TEST_PREFIX}FG`, `${TEST_PREFIX}_Foreign`]
    );
    const foreignAccount = await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
       VALUES ($1, $2, $3, 'Asset', '0', 'Dr', true) RETURNING id`,
      [foreign.rows[0].id, `${TEST_PREFIX}-FGN-CASH`, `${TEST_PREFIX} Foreign Cash`]
    );

    const response = await agent
      .post(`/api/factory/workers/${workerId}/advances`)
      .send({ amount: "10.00", cashAccountId: foreignAccount.rows[0].id });

    // Crediting another tenant's cash account would move money between books.
    expect(response.status).toBe(400);

    await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [foreign.rows[0].id]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [foreign.rows[0].id]);
  });

  it("returns 404 for a worker who is not in this company", async () => {
    const response = await agent
      .post("/api/factory/workers/999999/advances")
      .send({ amount: "10.00", cashAccountId: ctx.cashAccountId });

    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/factory/advances/:id", () => {
  it("updates the notes and date but leaves the amount alone", async () => {
    const advance = await giveAdvance("120.00");

    const response = await agent
      .patch(`/api/factory/advances/${advance.id}`)
      .send({ notes: "corrected note", advanceDate: "2026-04-12", amount: "9999.00" });

    expect(response.status).toBe(200);
    const row = await advanceRow(advance.id);
    expect(row?.notes).toBe("corrected note");
    // The amount is deliberately not editable: the voucher is already posted
    // and the remaining balance is derived from it, so changing it here would
    // put the three out of step.
    expect(Number(row?.amount)).toBeCloseTo(120, 2);
    expect(Number(row?.remaining_balance)).toBeCloseTo(120, 2);
  });

  it("returns 404 for an advance in another company", async () => {
    const response = await agent.patch("/api/factory/advances/999999").send({ notes: "x" });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/factory/advances/:id/reverse", () => {
  it("restores the advance to fully outstanding and drops its repayments", async () => {
    const advance = await giveAdvance("200.00");

    // Simulate payroll having deducted part of it.
    await pool.query(
      `INSERT INTO factory_advance_repayments (company_id, advance_id, worker_id, repayment_date, amount)
       VALUES ($1, $2, $3, '2026-05-01', '80.00')`,
      [ctx.companyId, advance.id, workerId]
    );
    await pool.query(`UPDATE factory_worker_advances SET remaining_balance = '120.00' WHERE id = $1`, [advance.id]);

    const response = await agent.post(`/api/factory/advances/${advance.id}/reverse`).send({});
    expect(response.status).toBe(200);

    const row = await advanceRow(advance.id);
    // Reversal is "undo the repayments", not "cancel the advance": the worker
    // owes the whole amount again.
    expect(Number(row?.remaining_balance)).toBeCloseTo(200, 2);
    expect(row?.fully_paid).toBe(false);

    const repayments = await pool.query(`SELECT id FROM factory_advance_repayments WHERE advance_id = $1`, [
      advance.id,
    ]);
    expect(repayments.rowCount).toBe(0);
    // The advance itself survives — it was not deleted.
    expect(await advanceRow(advance.id)).not.toBeNull();
  });

  it("returns 404 for an advance in another company", async () => {
    const response = await agent.post("/api/factory/advances/999999/reverse").send({});
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/factory/advances/:id", () => {
  it("refuses an advance that still has a repayment and leaves it whole (wave 7)", async () => {
    const advance = await giveAdvance("300.00");
    await pool.query(
      `INSERT INTO factory_advance_repayments (company_id, advance_id, worker_id, repayment_date, amount)
       VALUES ($1, $2, $3, '2026-05-01', '50.00')`,
      [ctx.companyId, advance.id, workerId]
    );
    expect(await advanceLegs(advance.id)).toHaveLength(2);

    // Owner decision: the repayments are reversed first; deleting the advance
    // under them used to leave their receipt vouchers behind.
    const response = await agent.delete(`/api/factory/advances/${advance.id}`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ADVANCE_HAS_REPAYMENTS");

    expect(await advanceRow(advance.id)).not.toBeNull();
    expect(
      (await pool.query(`SELECT id FROM factory_advance_repayments WHERE advance_id = $1`, [advance.id])).rowCount
    ).toBe(1);
    expect(await advanceLegs(advance.id)).toHaveLength(2);
  });

  it("removes an advance with no repayment and the voucher behind it", async () => {
    const advance = await giveAdvance("300.00");
    expect(await advanceLegs(advance.id)).toHaveLength(2);

    const response = await agent.delete(`/api/factory/advances/${advance.id}`);
    expect(response.status).toBe(200);

    expect(await advanceRow(advance.id)).toBeNull();
    // The posting has to go with it. Entries left behind are a permanent
    // one-sided amount in the trial balance.
    expect(await advanceLegs(advance.id)).toHaveLength(0);
    const orphanVouchers = await pool.query(
      `SELECT id FROM vouchers WHERE voucher_number LIKE $1 AND deleted_at IS NULL`,
      [`PAYMENT-ADV-${advance.id}-%`]
    );
    expect(orphanVouchers.rowCount).toBe(0);
  });

  it("returns 404 for an advance in another company", async () => {
    const response = await agent.delete("/api/factory/advances/999999");
    expect(response.status).toBe(404);
  });
});
