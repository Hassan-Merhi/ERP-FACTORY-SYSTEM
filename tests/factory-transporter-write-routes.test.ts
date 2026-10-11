/**
 * Behavioural coverage for the factory transporter write routes.
 *
 * All five were guard-only. Two of them post double-entry vouchers straight
 * into `vouchers` and `voucher_entries` — a charge is Dr expense / Cr
 * transporter, a payment is Dr transporter / Cr cash — and a third deletes a
 * transaction along with the voucher behind it.
 *
 * The invariant asserted is the one the ledger exists to hold: every posting
 * balances, and it balances against the right two accounts in the right
 * direction. A charge posted with both legs on the same side, or with the
 * transporter's leg debited instead of credited, still looks like a successful
 * request and still returns a transaction row — it just moves the transporter's
 * balance the wrong way, which is exactly the failure the smoke sweep cannot
 * see because it never calls a mutating endpoint.
 *
 * Deletion is held to the same standard from the other side: the voucher and
 * both its entries have to go with the transaction. A voucher_entries row left
 * behind is a permanent, unattributable imbalance in the trial balance.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "transwr";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let expenseAccountId: number;

interface Leg {
  ledger_account_id: number;
  debit_amount: string;
  credit_amount: string;
}

/** The voucher entries a transporter transaction posted, by transaction id. */
async function legsFor(txId: number): Promise<Leg[]> {
  const result = await pool.query<Leg>(
    `SELECT ve.ledger_account_id, ve.debit_amount, ve.credit_amount
     FROM voucher_entries ve
     JOIN factory_transporter_transactions t ON t.voucher_id = ve.voucher_id
     WHERE t.id = $1
     ORDER BY ve.id`,
    [txId]
  );
  return result.rows;
}

async function transporterLedgerAccountId(transporterId: number): Promise<number> {
  const result = await pool.query<{ ledger_account_id: number }>(
    `SELECT ledger_account_id FROM factory_transporters WHERE id = $1`,
    [transporterId]
  );
  return result.rows[0].ledger_account_id;
}

async function createTransporter(name: string) {
  const response = await agent.post("/api/factory/transporters").send({ name });
  if (response.status !== 200) throw new Error(`Seed transporter failed: ${response.status} ${response.text}`);
  return response.body as { id: number; name: string; ledgerAccountId: number };
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

  const expense = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, $3, 'Expense', '0', 'Dr', true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-EXP`, `${TEST_PREFIX} Transport Expense`]
  );
  expenseAccountId = expense.rows[0].id;
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/transporters", () => {
  it("creates the transporter with its own ledger account", async () => {
    const created = await createTransporter(`${TEST_PREFIX}_alpha`);

    // Every charge and payment posts against this account, so a transporter
    // created without one would post its second leg to null.
    expect(created.ledgerAccountId).toBeTruthy();
    const account = await pool.query<{ company_id: number }>(`SELECT company_id FROM ledger_accounts WHERE id = $1`, [
      created.ledgerAccountId,
    ]);
    expect(account.rows[0].company_id).toBe(ctx.companyId);
  });

  it("rejects a transporter with no name", async () => {
    const response = await agent.post("/api/factory/transporters").send({ phone: "123" });
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/factory/transporters/:id", () => {
  it("updates the fields sent", async () => {
    const created = await createTransporter(`${TEST_PREFIX}_patch`);

    const response = await agent.patch(`/api/factory/transporters/${created.id}`).send({ phone: "+961-1-000000" });

    expect(response.status).toBe(200);
    const row = await pool.query<{ phone: string | null; name: string }>(
      `SELECT phone, name FROM factory_transporters WHERE id = $1`,
      [created.id]
    );
    expect(row.rows[0].phone).toBe("+961-1-000000");
    // An omitted name must not blank the stored one.
    expect(row.rows[0].name).toBe(`${TEST_PREFIX}_patch`);
  });

  it("rejects an empty name rather than storing it", async () => {
    const created = await createTransporter(`${TEST_PREFIX}_patch_bad`);
    const response = await agent.patch(`/api/factory/transporters/${created.id}`).send({ name: "" });

    expect(response.status).not.toBe(200);
    const row = await pool.query<{ name: string }>(`SELECT name FROM factory_transporters WHERE id = $1`, [created.id]);
    expect(row.rows[0].name).toBe(`${TEST_PREFIX}_patch_bad`);
  });
});

describe("POST /api/factory/transporters/:id/charges", () => {
  it("posts a balanced Dr expense / Cr transporter voucher", async () => {
    const created = await createTransporter(`${TEST_PREFIX}_charge`);
    const transporterAccount = await transporterLedgerAccountId(created.id);

    const response = await agent
      .post(`/api/factory/transporters/${created.id}/charges`)
      .send({ amount: "150.00", txDate: "2026-02-01", expenseAccountId, description: "Beirut run" });

    expect(response.status).toBe(200);
    const legs = await legsFor(response.body.id);
    expect(legs).toHaveLength(2);

    const debits = legs.reduce((sum, leg) => sum + Number(leg.debit_amount), 0);
    const credits = legs.reduce((sum, leg) => sum + Number(leg.credit_amount), 0);
    expect(debits).toBeCloseTo(150, 2);
    expect(credits).toBeCloseTo(150, 2);

    // Direction matters as much as balance: a charge increases what the company
    // owes the transporter, so their account is the credited side.
    const expenseLeg = legs.find((leg) => leg.ledger_account_id === expenseAccountId);
    const transporterLeg = legs.find((leg) => leg.ledger_account_id === transporterAccount);
    expect(Number(expenseLeg?.debit_amount)).toBeCloseTo(150, 2);
    expect(Number(transporterLeg?.credit_amount)).toBeCloseTo(150, 2);
  });

  it("rejects a charge with no amount, date or expense account", async () => {
    const created = await createTransporter(`${TEST_PREFIX}_charge_bad`);

    for (const body of [
      { txDate: "2026-02-01", expenseAccountId },
      { amount: "10", expenseAccountId },
      { amount: "10", txDate: "2026-02-01" },
    ]) {
      const response = await agent.post(`/api/factory/transporters/${created.id}/charges`).send(body);
      expect(response.status).toBe(400);
    }

    const vouchers = await pool.query(`SELECT id FROM factory_transporter_transactions WHERE transporter_id = $1`, [
      created.id,
    ]);
    expect(vouchers.rowCount).toBe(0);
  });

  it("returns 404 for a transporter that does not exist in this company", async () => {
    const response = await agent
      .post("/api/factory/transporters/999999/charges")
      .send({ amount: "10", txDate: "2026-02-01", expenseAccountId });

    expect(response.status).toBe(404);
  });
});

describe("POST /api/factory/transporters/:id/payments", () => {
  it("posts a balanced Dr transporter / Cr cash voucher", async () => {
    const created = await createTransporter(`${TEST_PREFIX}_payment`);
    const transporterAccount = await transporterLedgerAccountId(created.id);

    const response = await agent
      .post(`/api/factory/transporters/${created.id}/payments`)
      .send({ amount: "90.50", txDate: "2026-02-02", cashAccountId: ctx.cashAccountId });

    expect(response.status).toBe(200);
    const legs = await legsFor(response.body.id);
    expect(legs).toHaveLength(2);

    const debits = legs.reduce((sum, leg) => sum + Number(leg.debit_amount), 0);
    const credits = legs.reduce((sum, leg) => sum + Number(leg.credit_amount), 0);
    expect(debits).toBeCloseTo(90.5, 2);
    expect(credits).toBeCloseTo(90.5, 2);

    // A payment settles the debt, so it runs the opposite way to a charge.
    const transporterLeg = legs.find((leg) => leg.ledger_account_id === transporterAccount);
    const cashLeg = legs.find((leg) => leg.ledger_account_id === ctx.cashAccountId);
    expect(Number(transporterLeg?.debit_amount)).toBeCloseTo(90.5, 2);
    expect(Number(cashLeg?.credit_amount)).toBeCloseTo(90.5, 2);
  });

  it("rejects a payment with no cash account", async () => {
    const created = await createTransporter(`${TEST_PREFIX}_payment_bad`);
    const response = await agent
      .post(`/api/factory/transporters/${created.id}/payments`)
      .send({ amount: "10", txDate: "2026-02-02" });

    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/factory/transporters/:id/transactions/:txId", () => {
  it("removes the voucher and both its entries with the transaction", async () => {
    const created = await createTransporter(`${TEST_PREFIX}_delete`);
    const charge = await agent
      .post(`/api/factory/transporters/${created.id}/charges`)
      .send({ amount: "75.00", txDate: "2026-02-03", expenseAccountId });
    expect(charge.status).toBe(200);

    const voucherId = (
      await pool.query<{ voucher_id: number }>(
        `SELECT voucher_id FROM factory_transporter_transactions WHERE id = $1`,
        [charge.body.id]
      )
    ).rows[0].voucher_id;

    const response = await agent.delete(`/api/factory/transporters/${created.id}/transactions/${charge.body.id}`);
    expect(response.status).toBe(200);

    // All three have to go together. An orphaned voucher_entries row is a
    // permanent one-sided amount in the trial balance with nothing to explain it.
    expect(
      (await pool.query(`SELECT id FROM factory_transporter_transactions WHERE id = $1`, [charge.body.id])).rowCount
    ).toBe(0);
    expect(
      (await pool.query(`SELECT id FROM vouchers WHERE id = $1 AND deleted_at IS NULL`, [voucherId])).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT ve.id FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL WHERE ve.voucher_id = $1`,
          [voucherId]
        )
      ).rowCount
    ).toBe(0);
  });

  it("returns 404 for a transaction in another company", async () => {
    const response = await agent.delete("/api/factory/transporters/1/transactions/999999");
    expect(response.status).toBe(404);
  });
});

describe("POST /api/transporter-statement/:accountId/reallocate", () => {
  it("allocates payments to charges exactly, leaving no sub-cent remainder", async () => {
    const created = await createTransporter(`${TEST_PREFIX}_fifo`);
    const transporterAccount = await transporterLedgerAccountId(created.id);
    for (const amount of ["0.10", "0.20"]) {
      const charge = await agent
        .post(`/api/factory/transporters/${created.id}/charges`)
        .send({ amount, txDate: "2026-03-01", expenseAccountId });
      expect(charge.status).toBe(200);
    }
    for (const [amount, txDate] of [
      ["0.30", "2026-03-02"],
      ["1.00", "2026-03-03"],
    ]) {
      const payment = await agent
        .post(`/api/factory/transporters/${created.id}/payments`)
        .send({ amount, txDate, cashAccountId: ctx.cashAccountId });
      expect(payment.status).toBe(200);
    }

    const response = await agent.post(`/api/transporter-statement/${transporterAccount}/reallocate`).send({});

    expect(response.status).toBe(200);
    // 0.30 pays 0.10 and 0.20 in full. In floats the second charge kept a
    // 2.8e-17 remainder, which the 1.00 payment then "allocated" a third time.
    expect(response.body.allocationsCreated).toBe(2);
    const allocations = await pool.query<{ allocated_amount: string }>(
      `SELECT allocated_amount FROM transporter_payment_allocations WHERE company_id = $1 ORDER BY id`,
      [ctx.companyId]
    );
    expect(allocations.rows.map((row) => Number(row.allocated_amount))).toEqual([0.1, 0.2]);
  });
});
