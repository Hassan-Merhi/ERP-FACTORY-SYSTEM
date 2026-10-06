/**
 * Voucher edit integrity (2026-10 accounting audit, wave 2).
 *
 * The edit routes used to:
 *   - delete every line on a header-only PATCH /api/vouchers/:id;
 *   - insert lines with no account for the `{ accountType, accountId }` shape;
 *   - drop `customerId` on every edit, removing customer lines from the
 *     customer sub-ledger;
 *   - accept unbalanced active vouchers (no check, or a float check);
 *   - add or change single lines with no balance check;
 *   - move lines to a soft-deleted account and leave stale customer links.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w2vedit";
const TODAY = new Date().toISOString().slice(0, 10);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let customerAccountId: number;
let otherAccountId: number;
let deletedAccountId: number;

type Line = {
  ledger_account_id: number | null;
  customer_id: number | null;
  debit_amount: string;
  credit_amount: string;
};

async function lines(voucherId: number): Promise<Line[]> {
  const result = await pool.query<Line>(
    `SELECT ledger_account_id, customer_id, debit_amount, credit_amount
       FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucherId]
  );
  return result.rows;
}

let voucherSeq = 0;
async function journal(debitAccount: number, creditAccount: number, amount: string, withCustomer = false) {
  voucherSeq += 1;
  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, description)
     VALUES ($1, $2, 'Journal', $3, $4, 'wave2 journal') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-${voucherSeq}-${Date.now()}`, TODAY, amount]
  );
  const voucherId = voucher.rows[0].id;
  await pool.query(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, customer_id, debit_amount, credit_amount)
     VALUES ($1, $2, $3, $4, 0), ($1, $5, NULL, 0, $4)`,
    [voucherId, debitAccount, withCustomer ? customerId : null, amount, creditAccount]
  );
  return voucherId;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" }))
      .status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const account = async (code: string, name: string, type: string) =>
    (
      await pool.query<{ id: number }>(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id`,
        [ctx.companyId, `${TEST_PREFIX}-${code}`, `${TEST_PREFIX} ${name}`, type]
      )
    ).rows[0].id;
  customerAccountId = await account("CUSTAR", "Customer AR", "Asset");
  otherAccountId = await account("OTHER", "Other", "Asset");
  deletedAccountId = await account("GONE", "Gone", "Asset");
  await pool.query(`UPDATE ledger_accounts SET deleted_at = NOW() WHERE id = $1`, [deletedAccountId]);
  customerId = (
    await pool.query<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-C`, `${TEST_PREFIX} Customer`, customerAccountId]
    )
  ).rows[0].id;
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("PATCH /api/vouchers/:id", () => {
  it("keeps every line on a header-only edit", async () => {
    const voucherId = await journal(customerAccountId, ctx.cashAccountId, "125.00", true);
    const before = await lines(voucherId);
    const res = await agent.patch(`/api/vouchers/${voucherId}`).send({ description: "renamed only" });
    expect(res.status).toBe(200);
    expect(await lines(voucherId)).toEqual(before);
  });

  it("rejects an unbalanced replacement of an active voucher and leaves the lines untouched", async () => {
    const voucherId = await journal(customerAccountId, ctx.cashAccountId, "50.00");
    const before = await lines(voucherId);
    const res = await agent.patch(`/api/vouchers/${voucherId}`).send({
      entries: [
        { ledgerAccountId: customerAccountId, debitAmount: "50.00", creditAmount: "0" },
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "49.99" },
      ],
    });
    expect(res.status).toBe(400);
    expect(await lines(voucherId)).toEqual(before);
  });

  it("posts the Daybook { accountType, accountId } shape to the named accounts and re-links the customer", async () => {
    const voucherId = await journal(customerAccountId, ctx.cashAccountId, "80.00", true);
    const res = await agent.patch(`/api/vouchers/${voucherId}`).send({
      entries: [
        { accountType: "ledger", accountId: customerAccountId, debitAmount: "90.00", creditAmount: "0" },
        { accountType: "ledger", accountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "90.00" },
      ],
    });
    expect(res.status).toBe(200);
    const after = await lines(voucherId);
    expect(after.map((line) => line.ledger_account_id)).toEqual([customerAccountId, ctx.cashAccountId]);
    expect(after[0].customer_id).toBe(customerId);
    expect(after[1].customer_id).toBeNull();
  });

  it("rejects a replacement line with no account", async () => {
    const voucherId = await journal(otherAccountId, ctx.cashAccountId, "10.00");
    const res = await agent.patch(`/api/vouchers/${voucherId}`).send({
      entries: [
        { debitAmount: "10.00", creditAmount: "0" },
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "10.00" },
      ],
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/vouchers/:id/with-entries", () => {
  it("keeps the customer link on the customer's own account line", async () => {
    const voucherId = await journal(customerAccountId, ctx.cashAccountId, "200.00", true);
    const res = await agent.put(`/api/vouchers/${voucherId}/with-entries`).send({
      voucher: { voucherType: "Journal", voucherDate: TODAY, description: "edited", optional: false },
      entries: [
        { ledgerAccountId: customerAccountId, debitAmount: "210.00", creditAmount: "0" },
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "210.00" },
      ],
    });
    expect(res.status).toBe(200);
    const after = await lines(voucherId);
    expect(after[0]).toMatchObject({ ledger_account_id: customerAccountId, customer_id: customerId });
  });

  it("rejects a one-cent imbalance that the float check let through", async () => {
    const voucherId = await journal(otherAccountId, ctx.cashAccountId, "30.00");
    const before = await lines(voucherId);
    const res = await agent.put(`/api/vouchers/${voucherId}/with-entries`).send({
      voucher: { voucherType: "Journal", voucherDate: TODAY, optional: false },
      entries: [
        { ledgerAccountId: otherAccountId, debitAmount: "30.009", creditAmount: "0" },
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "30.00" },
      ],
    });
    expect(res.status).toBe(400);
    expect(await lines(voucherId)).toEqual(before);
  });
});

describe("single-line writes", () => {
  it("refuses a line that would unbalance an active journal", async () => {
    const voucherId = await journal(otherAccountId, ctx.cashAccountId, "40.00");
    const res = await agent
      .post("/api/voucher-entries")
      .send({ voucherId, ledgerAccountId: otherAccountId, debitAmount: "5.00", creditAmount: "0" });
    expect(res.status).toBe(400);
    expect(await lines(voucherId)).toHaveLength(2);
  });
});

describe("POST /api/voucher-entries/transfer-account", () => {
  it("refuses a soft-deleted destination account", async () => {
    const voucherId = await journal(otherAccountId, ctx.cashAccountId, "15.00");
    const entry = await pool.query<{ id: number }>(
      `SELECT id FROM voucher_entries WHERE voucher_id = $1 AND ledger_account_id = $2`,
      [voucherId, otherAccountId]
    );
    const res = await agent
      .post("/api/voucher-entries/transfer-account")
      .send({ entryIds: [entry.rows[0].id], toAccountId: deletedAccountId });
    expect(res.status).toBe(404);
  });

  it("clears the customer link when a customer line moves to an unrelated account", async () => {
    const voucherId = await journal(customerAccountId, ctx.cashAccountId, "60.00", true);
    const entry = await pool.query<{ id: number }>(
      `SELECT id FROM voucher_entries WHERE voucher_id = $1 AND customer_id = $2`,
      [voucherId, customerId]
    );
    const res = await agent
      .post("/api/voucher-entries/transfer-account")
      .send({ entryIds: [entry.rows[0].id], toAccountId: otherAccountId });
    expect(res.status).toBe(200);
    const after = await lines(voucherId);
    expect(after[0]).toMatchObject({ ledger_account_id: otherAccountId, customer_id: null });
  });
});
