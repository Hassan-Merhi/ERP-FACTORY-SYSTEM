import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p9idem";
let ctx: TestContext;
let agent: request.SuperAgentTest;

async function persistedAccounting(voucherId: number) {
  const voucher = await pool.query<{ id: number; voucher_type: string }>(
    `SELECT id, voucher_type
       FROM vouchers
      WHERE id = $1 AND company_id = $2`,
    [voucherId, ctx.companyId]
  );
  const entries = await pool.query<{ debit_amount: string; credit_amount: string }>(
    `SELECT debit_amount, credit_amount
       FROM voucher_entries
      WHERE voucher_id = $1
      ORDER BY id`,
    [voucherId]
  );
  const requests = await pool.query<{ voucher_id: number; idempotency_key: string }>(
    `SELECT voucher_id, idempotency_key
       FROM accounting_posting_requests
      WHERE company_id = $1 AND voucher_id = $2`,
    [ctx.companyId, voucherId]
  );

  return { voucher, entries, requests };
}

function assertBalanced(entries: Array<{ debit_amount: string; credit_amount: string }>): void {
  const debit = entries.reduce((sum, row) => sum + Number(row.debit_amount || 0), 0);
  const credit = entries.reduce((sum, row) => sum + Number(row.credit_amount || 0), 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBeCloseTo(credit, 2);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);

  const company = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(company.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 9 accounting retry/idempotency", () => {
  it("replays the same generic voucher request without posting a second voucher", async () => {
    const clientRequestId = `${TEST_PREFIX}-generic-${Date.now()}`;
    const payload = {
      clientRequestId,
      voucher: {
        voucherNumber: `P9-GEN-${Date.now()}`,
        voucherType: "Contra",
        voucherDate: "2026-09-14",
        currency: "USD",
        description: "Phase 9 duplicate generic voucher",
      },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "17.25", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "17.25" },
      ],
    };

    const first = await agent.post("/api/vouchers/with-entries").send(payload);
    const retry = await agent.post("/api/vouchers/with-entries").send(payload);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.voucher.id).toBe(first.body.voucher.id);
    expect(retry.body.entries.map((entry: { id: number }) => entry.id)).toEqual(
      first.body.entries.map((entry: { id: number }) => entry.id)
    );

    const persisted = await persistedAccounting(Number(first.body.voucher.id));
    expect(persisted.voucher.rowCount).toBe(1);
    expect(persisted.entries.rowCount).toBe(2);
    expect(persisted.requests.rowCount).toBe(1);
    assertBalanced(persisted.entries.rows);
  }, 60_000);

  it.each(["Payment", "Receipt"] as const)(
    "replays a duplicate %s request and preserves one canonical posting",
    async (voucherType) => {
      const clientRequestId = `${TEST_PREFIX}-${voucherType.toLowerCase()}-${Date.now()}`;
      const payload = {
        voucherType,
        voucherDate: "2026-09-14",
        paymentAccountType: "ledger",
        paymentAccountId: ctx.cashAccountId,
        paymentAccountName: "Cash",
        clientRequestId,
        entries: [
          {
            accountType: "ledger",
            accountId: ctx.salesAccountId,
            accountName: "Sales",
            amount: "28.50",
            narration: `Phase 9 ${voucherType}`,
          },
        ],
      };

      const first = await agent.post("/api/vouchers/payment-receipt").send(payload);
      const retry = await agent.post("/api/vouchers/payment-receipt").send(payload);

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(first.body.replayed).toBe(false);
      expect(retry.body.replayed).toBe(true);
      expect(retry.body.voucher.id).toBe(first.body.voucher.id);

      const persisted = await persistedAccounting(Number(first.body.voucher.id));
      expect(persisted.voucher.rows[0].voucher_type).toBe(voucherType);
      expect(persisted.entries.rowCount).toBe(2);
      expect(persisted.requests.rowCount).toBe(1);
      assertBalanced(persisted.entries.rows);
    },
    60_000
  );

  it("reuses the committed Journal when the caller retries after losing the first response", async () => {
    const clientRequestId = `${TEST_PREFIX}-lost-response-${Date.now()}`;
    const payload = {
      voucherDate: "2026-09-14",
      notes: "Phase 9 simulated lost client response",
      clientRequestId,
      entries: [
        { type: "DR", accountType: "ledger", accountId: ctx.cashAccountId, amount: "41.00" },
        { type: "CR", accountType: "ledger", accountId: ctx.salesAccountId, amount: "41.00" },
      ],
    };

    // The server commits successfully, but this test deliberately discards the
    // response body to model a network/client failure after commit.
    const committedButForgotten = await agent.post("/api/vouchers/journal").send(payload);
    expect(committedButForgotten.status).toBe(200);

    // The route generates a fresh display voucher number for each HTTP attempt.
    // Waiting guarantees the second number differs, so this proves idempotency is
    // keyed to the financial request instead of incidental server metadata.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const retry = await agent.post("/api/vouchers/journal").send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);

    const voucherId = Number(retry.body.voucher.id);
    const persisted = await persistedAccounting(voucherId);
    expect(persisted.voucher.rowCount).toBe(1);
    expect(persisted.voucher.rows[0].voucher_type).toBe("Journal");
    expect(persisted.entries.rowCount).toBe(2);
    expect(persisted.requests.rowCount).toBe(1);
    assertBalanced(persisted.entries.rows);

    const matchingJournals = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM vouchers
        WHERE company_id = $1
          AND voucher_type = 'Journal'
          AND description = $2`,
      [ctx.companyId, payload.notes]
    );
    expect(Number(matchingJournals.rows[0].count)).toBe(1);
  }, 60_000);
});
