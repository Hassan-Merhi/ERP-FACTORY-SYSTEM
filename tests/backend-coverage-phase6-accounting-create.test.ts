/**
 * Phase 6 — canonical accounting create-flow coverage.
 *
 * Every create is verified twice: the business voucher row must exist in the
 * active company, and the persisted accounting entry set must be balanced.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p6acct";
let ctx: TestContext;
let agent: request.SuperAgentTest;

function voucherIdFrom(body: Record<string, any>): number {
  return Number(body?.voucher?.id ?? body?.posted?.voucher?.id ?? body?.voucherId ?? body?.id);
}

async function assertPersistedAndBalanced(voucherId: number, expectedType: string, expectedMinEntries = 2): Promise<void> {
  expect(Number.isInteger(voucherId) && voucherId > 0).toBe(true);

  const voucher = await pool.query<{
    id: number;
    company_id: number;
    voucher_type: string;
    deleted_at: Date | null;
  }>(
    `SELECT id, company_id, voucher_type, deleted_at
       FROM vouchers
      WHERE id = $1 AND company_id = $2`,
    [voucherId, ctx.companyId]
  );
  expect(voucher.rowCount).toBe(1);
  expect(voucher.rows[0].voucher_type).toBe(expectedType);
  expect(voucher.rows[0].deleted_at).toBeNull();

  const entries = await pool.query<{
    debit_amount: string | null;
    credit_amount: string | null;
  }>(
    `SELECT debit_amount, credit_amount
       FROM voucher_entries
      WHERE voucher_id = $1
      ORDER BY id`,
    [voucherId]
  );
  expect(entries.rowCount ?? 0).toBeGreaterThanOrEqual(expectedMinEntries);

  const debit = entries.rows.reduce((sum, row) => sum + Number(row.debit_amount ?? 0), 0);
  const credit = entries.rows.reduce((sum, row) => sum + Number(row.credit_amount ?? 0), 0);
  expect(debit).toBeGreaterThan(0);
  expect(credit).toBeGreaterThan(0);
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
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("Phase 6 canonical accounting creates", () => {
  it("creates a protected generic voucher and balanced accounting entries", async () => {
    const response = await agent.post("/api/vouchers/with-entries").send({
      clientRequestId: `${TEST_PREFIX}-generic-${Date.now()}`,
      voucher: {
        voucherNumber: `P6-GEN-${Date.now()}`,
        voucherType: "Contra",
        voucherDate: "2026-09-14",
        currency: "USD",
      },
      entries: [
        {
          ledgerAccountId: ctx.cashAccountId,
          debitAmount: "25.00",
          creditAmount: "0",
          narration: "Phase 6 generic debit",
        },
        {
          ledgerAccountId: ctx.salesAccountId,
          debitAmount: "0",
          creditAmount: "25.00",
          narration: "Phase 6 generic credit",
        },
      ],
    });

    expect(response.status).toBe(200);
    await assertPersistedAndBalanced(voucherIdFrom(response.body), "Contra");
  }, 60000);

  it.each(["Payment", "Receipt"] as const)(
    "creates a %s voucher and balanced accounting entries",
    async (voucherType) => {
      const response = await agent.post("/api/vouchers/payment-receipt").send({
        voucherType,
        voucherDate: "2026-09-14",
        paymentAccountType: "ledger",
        paymentAccountId: ctx.cashAccountId,
        paymentAccountName: "Cash",
        clientRequestId: `${TEST_PREFIX}-${voucherType.toLowerCase()}-${Date.now()}`,
        entries: [
          {
            accountType: "ledger",
            accountId: ctx.salesAccountId,
            accountName: "Sales",
            amount: "31.25",
            narration: `Phase 6 ${voucherType}`,
          },
        ],
      });

      expect(response.status).toBe(200);
      await assertPersistedAndBalanced(voucherIdFrom(response.body), voucherType);
    },
    60000
  );

  it("creates a Journal and balanced accounting entries", async () => {
    const response = await agent.post("/api/vouchers/journal").send({
      voucherDate: "2026-09-14",
      notes: "Phase 6 journal",
      clientRequestId: `${TEST_PREFIX}-journal-${Date.now()}`,
      entries: [
        {
          type: "DR",
          accountType: "ledger",
          accountId: ctx.cashAccountId,
          amount: "44.50",
          narration: "Phase 6 journal debit",
        },
        {
          type: "CR",
          accountType: "ledger",
          accountId: ctx.salesAccountId,
          amount: "44.50",
          narration: "Phase 6 journal credit",
        },
      ],
    });

    expect(response.status).toBe(200);
    await assertPersistedAndBalanced(voucherIdFrom(response.body), "Journal");
  }, 60000);

  it.each(["Credit Note", "Debit Note"] as const)(
    "creates a %s business document and balanced accounting entries",
    async (noteType) => {
      const response = await agent.post("/api/credit-notes").send({
        noteType,
        voucherDate: "2026-09-14",
        cashAccountType: "ledger",
        cashAccountId: ctx.cashAccountId,
        description: `Phase 6 ${noteType}`,
        items: [
          {
            stockItemId: ctx.stockItemIds[0],
            locationId: ctx.locationId,
            quantity: "2",
            refundRate: "10.00",
            inventoryCost: "10.00",
          },
        ],
      });

      expect(response.status).toBe(200);
      const voucherId = voucherIdFrom(response.body);
      await assertPersistedAndBalanced(voucherId, noteType);

      const lines = await pool.query<{ quantity: string; total_value: string }>(
        `SELECT quantity, total_value FROM credit_note_items WHERE voucher_id = $1`,
        [voucherId]
      );
      expect(lines.rowCount).toBe(1);
      expect(Number(lines.rows[0].quantity)).toBe(2);
      expect(Number(lines.rows[0].total_value)).toBeCloseTo(20, 2);
    },
    60000
  );
});
