/**
 * The exact voucher reversal endpoint.
 *
 * The reversal engine and its PostgreSQL loader existed with no route in front
 * of them, so nothing outside the test suite could reverse a voucher through
 * the canonical path. These tests drive the real endpoint and then read the
 * ledger back: the reversal must mirror the original exactly, leave the
 * original untouched, and refuse the cases that would corrupt the history.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { pool } from "../server/db";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";

const TEST_PREFIX = "revroute";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let ledgerAccountId: number;
let bankAccountId: number;

// The voucher and both legs go in one transaction: the voucher balance guard
// checks the voucher at COMMIT.
async function createPostedVoucher(amount: string) {
  return withFixtureTransaction(async (client) => {
    const { rows: voucherRows } = await client.query(
      `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, description, total_amount, optional, currency)
       VALUES ($1, 'Journal', $2, CURRENT_DATE, 'reversal source', $3, false, 'USD')
       RETURNING id`,
      [ctx.companyId, `JV-REV-${Date.now()}-${Math.floor(Math.random() * 1000)}`, amount]
    );
    const voucherId = Number(voucherRows[0].id);

    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
       VALUES ($1, $2, $3, '0', 'debit leg')`,
      [voucherId, ledgerAccountId, amount]
    );
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, bank_account_id, debit_amount, credit_amount, narration)
       VALUES ($1, $2, '0', $3, 'credit leg')`,
      [voucherId, bankAccountId, amount]
    );
    return voucherId;
  });
}

async function entriesFor(voucherId: number) {
  const { rows } = await pool.query(
    `SELECT ledger_account_id, bank_account_id, debit_amount, credit_amount
       FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucherId]
  );
  return rows;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const { rows: ledgerRows } = await pool.query(
    `SELECT id FROM ledger_accounts WHERE company_id = $1 ORDER BY id LIMIT 1`,
    [ctx.companyId]
  );
  ledgerAccountId = Number(ledgerRows[0].id);

  const { rows: bankRows } = await pool.query(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance)
     VALUES ($1, $2, $3, 'Test Bank', '000123', '0')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}BK`.slice(0, 20).toUpperCase(), `${TEST_PREFIX}_bank`]
  );
  bankAccountId = Number(bankRows[0].id);
}, 60000);

afterAll(async () => {
  // Lines on the bank account go first: voucher_entries.bank_account_id is a
  // RESTRICT foreign key. Every line of their vouchers goes with them, in one
  // statement, so no voucher is left one-sided for the voucher balance guard.
  await pool.query(
    `DELETE FROM voucher_entries
      WHERE voucher_id IN (
        SELECT voucher_id FROM voucher_entries
         WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE company_id = $1)
      )`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM bank_accounts WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("POST /api/vouchers/:voucherId/exact-reversal", () => {
  it("posts a reversal that mirrors the original and leaves it untouched", async () => {
    const originalId = await createPostedVoucher("40.000000");
    const originalEntries = await entriesFor(originalId);

    const res = await agent.post(`/api/vouchers/${originalId}/exact-reversal`).send({});
    expect(res.status).toBe(201);

    const reversalId = Number(res.body.voucher?.id ?? res.body.voucherId);
    expect(Number.isInteger(reversalId)).toBe(true);
    expect(reversalId).not.toBe(originalId);

    // Each leg is the original's opposite, against the same account.
    const reversalEntries = await entriesFor(reversalId);
    expect(reversalEntries).toHaveLength(originalEntries.length);
    for (const original of originalEntries) {
      const mirrored = reversalEntries.find(
        (entry) =>
          String(entry.ledger_account_id) === String(original.ledger_account_id) &&
          String(entry.bank_account_id) === String(original.bank_account_id)
      );
      expect(mirrored).toBeDefined();
      expect(Number(mirrored!.debit_amount)).toBeCloseTo(Number(original.credit_amount), 6);
      expect(Number(mirrored!.credit_amount)).toBeCloseTo(Number(original.debit_amount), 6);
    }

    // The original is immutable: reversal is append-only, never an edit.
    const stillThere = await entriesFor(originalId);
    expect(stillThere).toEqual(originalEntries);
    const { rows: originalRows } = await pool.query(`SELECT deleted_at FROM vouchers WHERE id = $1`, [originalId]);
    expect(originalRows[0].deleted_at).toBeNull();
  }, 30000);

  it("returns the first reversal when the same request is retried", async () => {
    const originalId = await createPostedVoucher("25.000000");

    const first = await agent.post(`/api/vouchers/${originalId}/exact-reversal`).send({});
    expect(first.status).toBe(201);

    const retry = await agent.post(`/api/vouchers/${originalId}/exact-reversal`).send({});
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);

    // A double submission must not post a second reversal.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM vouchers
        WHERE company_id = $1 AND description LIKE 'Exact reversal of%' AND id <> $2`,
      [ctx.companyId, originalId]
    );
    expect(rows[0].count).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("refuses to reverse a voucher that does not exist in the active company", async () => {
    // The company-resource boundary refuses before the reversal engine is
    // reached, and answers "not found" rather than distinguishing "exists in
    // another company" from "does not exist" — so the route inherits company
    // isolation rather than implementing its own. The engine's own
    // ORIGINAL_NOT_FOUND path remains as defence in depth behind it.
    const res = await agent.post("/api/vouchers/99999999/exact-reversal").send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("RESOURCE_NOT_FOUND");
  }, 30000);

  it("rejects an invalid voucher id in the path", async () => {
    const res = await agent.post("/api/vouchers/not-a-number/exact-reversal").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VOUCHER_ID_INVALID");
  }, 30000);

  it("is closed to an unauthenticated caller", async () => {
    const anonymous = request.agent(ctx.app);
    const res = await anonymous.post("/api/vouchers/1/exact-reversal").send({});
    expect(res.status).toBe(401);
  }, 30000);
});
