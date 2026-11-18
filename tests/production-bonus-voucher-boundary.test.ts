/**
 * Production bonus vouchers can only be corrected from the Production Bonus page.
 *
 * HMD manual bonus payment 1 was posted at 27.00 USD and its voucher was then
 * edited to 26.00 from the ordinary voucher screen, which left the bonus record
 * at 27.00. Every generic voucher writer now refuses a voucher that belongs to a
 * production bonus (server/middleware/productionBonusVoucherBoundary.ts), while
 * other vouchers stay editable.
 */
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "pbvb";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let bonusVoucherId: number;
let bonusEntryId: number;
let otherVoucherId: number;

async function postJournal(label: string): Promise<{ voucherId: number; entryId: number }> {
  const response = await agent.post("/api/vouchers/with-entries").send({
    voucher: {
      voucherNumber: `${TEST_PREFIX}-${label}`,
      voucherType: "Journal",
      voucherDate: "2026-10-31",
      description: `Production bonus boundary ${label}`,
      locationId: ctx.locationId,
    },
    entries: [
      { ledgerAccountId: ctx.cashAccountId, debitAmount: "26.00", creditAmount: "0", narration: "Debit" },
      { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "26.00", narration: "Credit" },
    ],
  });
  if (response.status !== 200 || !response.body?.voucher?.id) {
    throw new Error(`Voucher seed failed: ${response.status} ${response.text}`);
  }
  const voucherId = Number(response.body.voucher.id);
  const { rows } = await pool.query<{ id: number }>(
    "SELECT id FROM voucher_entries WHERE voucher_id = $1 ORDER BY id LIMIT 1",
    [voucherId]
  );
  return { voucherId, entryId: Number(rows[0].id) };
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const bonus = await postJournal("BONUS");
  bonusVoucherId = bonus.voucherId;
  bonusEntryId = bonus.entryId;
  otherVoucherId = (await postJournal("OTHER")).voucherId;

  const worker = await pool.query<{ id: number }>(
    "INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id",
    [ctx.companyId, `${TEST_PREFIX} worker`]
  );
  await pool.query(
    `INSERT INTO factory_target_bonus_manual_payments
       (company_id, worker_id, week_start, amount_usd, payment_date, request_key,
        expense_ledger_account_id, cash_ledger_account_id, payment_voucher_id, posted_by)
     VALUES ($1, $2, DATE '2026-10-26', 26, DATE '2026-10-31', $3, $4, $5, $6, $7)`,
    [ctx.companyId, worker.rows[0].id, randomUUID(), ctx.salesAccountId, ctx.cashAccountId, bonusVoucherId, ctx.userId]
  );
}, 120_000);

afterAll(async () => {
  await pool.query("DELETE FROM factory_target_bonus_manual_payments WHERE payment_voucher_id = $1", [bonusVoucherId]);
  await pool.query(
    `DELETE FROM factory_user_page_access WHERE user_id IN (SELECT id FROM users WHERE username = $1);
     DELETE FROM factory_user_profiles WHERE user_id IN (SELECT id FROM users WHERE username = $1);
     DELETE FROM user_company_roles WHERE user_id IN (SELECT id FROM users WHERE username = $1);
     DELETE FROM users WHERE username = $1;`.replaceAll("$1", `'${TEST_PREFIX}_floor'`)
  );
  await cleanupTestData(TEST_PREFIX);
  await closeTestServer();
});

describe("production bonus voucher boundary", () => {
  it("refuses every generic edit, delete, reversal and line change of a bonus voucher", async () => {
    // Built one at a time: supertest starts each request as soon as it is created.
    const attempts = [
      () => agent.patch(`/api/vouchers/${bonusVoucherId}/journal`).send({ description: "edited" }),
      () => agent.patch(`/api/vouchers/${bonusVoucherId}/payment-receipt`).send({ amount: "27.00" }),
      () => agent.delete(`/api/vouchers/${bonusVoucherId}`),
      () => agent.post(`/api/vouchers/${bonusVoucherId}/reverse`).send({ reason: "test" }),
      () => agent.post("/api/vouchers/bulk-delete").send({ voucherIds: [otherVoucherId, bonusVoucherId] }),
      () =>
        agent
          .post("/api/voucher-entries")
          .send({ voucherId: bonusVoucherId, ledgerAccountId: ctx.cashAccountId, debitAmount: "1", creditAmount: "0" }),
      () => agent.patch(`/api/voucher-entries/${bonusEntryId}`).send({ debitAmount: "27.00" }),
      // Spellings that Number() / parseInt() in the writers still read as the bonus voucher.
      () => agent.patch(`/api/vouchers/${bonusVoucherId}.0/journal`).send({ description: "edited" }),
      () => agent.delete(`/api/vouchers/${bonusVoucherId}.0`),
      () => agent.patch(`/api/voucher-entries/${bonusEntryId}x`).send({ debitAmount: "27.00" }),
      () =>
        agent
          .post("/api/voucher-entries/transfer-account")
          .send({ entryIds: [bonusEntryId], toAccountId: ctx.salesAccountId }),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      expect(response.status, response.text).toBe(409);
      expect(response.body.code).toBe("PRODUCTION_BONUS_VOUCHER_LOCKED");
    }
    const { rows } = await pool.query<{ total: string; deleted: boolean }>(
      "SELECT total_amount::text AS total, deleted_at IS NOT NULL AS deleted FROM vouchers WHERE id = $1",
      [bonusVoucherId]
    );
    expect(Number(rows[0].total)).toBe(26);
    expect(rows[0].deleted).toBe(false);
  });

  it("still reads a bonus voucher and leaves other vouchers editable", async () => {
    expect((await agent.get(`/api/vouchers/${bonusVoucherId}`)).status).not.toBe(409);
    const other = await agent.delete(`/api/vouchers/${otherVoucherId}`);
    expect(other.body?.code).not.toBe("PRODUCTION_BONUS_VOUCHER_LOCKED");
    expect(other.status).not.toBe(409);
  });
});

describe("factory users", () => {
  it("are created with the Normal User role, never the retired User role", async () => {
    // The Factory users route serves Factory companies only.
    await pool.query("UPDATE companies SET company_type = 'factory' WHERE id = $1", [ctx.companyId]);
    await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    // Creating a user is a privileged operation: it needs a recent step-up confirmation.
    expect((await agent.post("/api/auth/confirm-password").send({ password: "testpassword123" })).status).toBe(200);
    const response = await agent
      .post("/api/factory/users")
      .send({ username: `${TEST_PREFIX}_floor`, password: "floor-pass-1234", displayName: "Floor", pageAccess: [] });
    expect(response.status, response.text).toBe(201);
    const { rows } = await pool.query<{ role: string }>(
      "SELECT role FROM user_company_roles WHERE user_id = $1 AND company_id = $2",
      [response.body.id, ctx.companyId]
    );
    expect(rows.map((row) => row.role)).toEqual(["Normal User"]);
  });
});
