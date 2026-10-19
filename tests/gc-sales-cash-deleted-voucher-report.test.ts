/**
 * Regression: soft-deleted GC Sales Cash vouchers must not remain posted.
 *
 * Voucher lines are retained for auditing, but active payable movements,
 * account transfer selection and account transfer writes must ignore them.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "gcdelpay";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let payableId: number;
let destinationId: number;
let deletedVoucherId: number;
let deletedEntryId: number;
let activeVoucherId: number;
let optionalVoucherId: number;

async function makeJournal(suffix: string, amount: string, optional = false): Promise<number> {
  const created = await pool.query<{ id: number }>(
    "INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, description) " +
      "VALUES ($1, $2, 'Journal', CURRENT_DATE, $3, $4, $5) RETURNING id",
    [ctx.companyId, PREFIX + "-" + suffix, amount, optional, suffix]
  );
  const id = created.rows[0].id;
  // Multiple credit lines model a multi-item journal against GC Sales Cash.
  await pool.query(
    "INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) " +
      "VALUES ($1, $2, 0, $4), ($1, $2, 0, $4), ($1, $3, $5, 0)",
    [id, payableId, destinationId, Number(amount) / 2, amount]
  );
  return id;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query("UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1", [ctx.companyId]);
  const account = await pool.query<{ id: number }>(
    "INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side) " +
      "VALUES ($1, $2, 'GC Sales Cash Test', 'Liability', 'sp_payable', 0, 'Cr') RETURNING id",
    [ctx.companyId, PREFIX + "-SP-PAY"]
  );
  payableId = account.rows[0].id;
  destinationId = ctx.cashAccountId;
  agent = request.agent(ctx.app);
  expect((await agent.post("/api/auth/login").send({
    username: PREFIX + "_testuser", password: "testpassword123"
  })).status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  activeVoucherId = await makeJournal("active", "40.00");
  deletedVoucherId = await makeJournal("deleted-multiple-items", "120.00");
  optionalVoucherId = await makeJournal("optional", "800.00", true);
  deletedEntryId = (await pool.query<{ id: number }>(
    "SELECT id FROM voucher_entries WHERE voucher_id = $1 AND ledger_account_id = $2 ORDER BY id LIMIT 1",
    [deletedVoucherId, payableId]
  )).rows[0].id;
  // Simulate the soft-deleted state produced by normal single/bulk deletion.
  await pool.query("UPDATE vouchers SET deleted_at = NOW() WHERE id = $1", [deletedVoucherId]);
}, 120000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("GC Sales Cash deleted voucher exclusion", () => {
  it("keeps deleted multi-line and optional journals out of payable movements and balance", async () => {
    const res = await agent.get("/api/sp/report/payable");
    expect(res.status, res.text).toBe(200);
    expect(res.body.movements).toHaveLength(2);
    expect(res.body.movements.every((row: { voucherNumber: string }) =>
      row.voucherNumber === PREFIX + "-active"
    )).toBe(true);
    expect(res.body.closingBalance).toBe(40);
    const retained = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM voucher_entries WHERE voucher_id = $1",
      [deletedVoucherId]
    );
    expect(Number(retained.rows[0].count)).toBe(3);
  });

  it("lists only active posted lines for account transfer, including paged results", async () => {
    const unpaged = await agent.get("/api/voucher-entries/by-account/" + payableId);
    expect(unpaged.status, unpaged.text).toBe(200);
    expect(unpaged.body).toHaveLength(2);
    expect(unpaged.body.every((row: { voucherId: number }) => row.voucherId === activeVoucherId)).toBe(true);

    const paged = await agent.get(
      "/api/voucher-entries/by-account/" + payableId + "?pagination=1&page=1&pageSize=100"
    );
    expect(paged.status, paged.text).toBe(200);
    expect(paged.body.total).toBe(2);
    expect(paged.body.items).toHaveLength(2);
  });

  it("refuses transferring a stale entry from a deleted voucher", async () => {
    const res = await agent.post("/api/voucher-entries/transfer-account").send({
      entryIds: [deletedEntryId], toAccountId: destinationId
    });
    expect(res.status, res.text).toBe(409);
    const entry = await pool.query<{ ledger_account_id: number }>(
      "SELECT ledger_account_id FROM voucher_entries WHERE id = $1",
      [deletedEntryId]
    );
    expect(entry.rows[0].ledger_account_id).toBe(payableId);
    expect(optionalVoucherId).toBeGreaterThan(0);
  });
});
