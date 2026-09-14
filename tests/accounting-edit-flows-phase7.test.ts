import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p7acctedit";
const CREATE_DATE = "2026-09-10";
const EDIT_DATE = "2026-09-12";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let alternateCashId: number;
let alternateContraId: number;

type EntryRow = {
  id: number;
  ledger_account_id: number | null;
  debit_amount: string | null;
  credit_amount: string | null;
  narration: string | null;
  transaction_currency: string | null;
  transaction_debit_amount: string | null;
  transaction_credit_amount: string | null;
  base_debit_amount: string | null;
  base_credit_amount: string | null;
  historical_exchange_rate: string | null;
};

function extractVoucherId(body: Record<string, unknown>): number {
  const voucher = body.voucher as { id?: number } | undefined;
  const id = voucher?.id ?? (body.id as number | undefined) ?? (body.voucherId as number | undefined);
  if (!id) throw new Error(`Voucher id missing from response: ${JSON.stringify(body)}`);
  return Number(id);
}

async function voucherRow(voucherId: number) {
  const result = await pool.query<{
    id: number;
    voucher_type: string;
    voucher_date: string;
    description: string | null;
    total_amount: string;
    currency: string | null;
    exchange_rate: string | null;
    deleted_at: string | null;
  }>(
    `SELECT id, voucher_type, voucher_date::text, description, total_amount,
            currency, exchange_rate, deleted_at::text
       FROM vouchers
      WHERE id = $1`,
    [voucherId]
  );
  return result.rows[0];
}

async function entriesFor(voucherId: number): Promise<EntryRow[]> {
  const result = await pool.query<EntryRow>(
    `SELECT id, ledger_account_id, debit_amount, credit_amount, narration,
            transaction_currency, transaction_debit_amount, transaction_credit_amount,
            base_debit_amount, base_credit_amount, historical_exchange_rate
       FROM voucher_entries
      WHERE voucher_id = $1
      ORDER BY id`,
    [voucherId]
  );
  return result.rows;
}

function assertBalanced(entries: EntryRow[]): void {
  const debit = entries.reduce((sum, entry) => sum + Number(entry.debit_amount || 0), 0);
  const credit = entries.reduce((sum, entry) => sum + Number(entry.credit_amount || 0), 0);
  expect(debit).toBeCloseTo(credit, 6);
  expect(debit).toBeGreaterThan(0);
}

function paymentReceiptBody(voucherType: "Payment" | "Receipt", amount: string) {
  return {
    voucherType,
    voucherDate: CREATE_DATE,
    paymentAccountType: "ledger",
    paymentAccountId: ctx.cashAccountId,
    paymentAccountName: "Cash",
    entries: [
      {
        accountType: "ledger",
        accountId: ctx.salesAccountId,
        accountName: "Sales",
        amount,
      },
    ],
    notes: `${voucherType} before edit`,
    currency: "USD",
  };
}

function journalBody(amount: string) {
  return {
    voucherDate: CREATE_DATE,
    notes: "Journal before edit",
    currency: "USD",
    entries: [
      {
        type: "DR",
        accountType: "ledger",
        accountId: ctx.cashAccountId,
        amount,
        narration: "original debit",
      },
      {
        type: "CR",
        accountType: "ledger",
        accountId: ctx.salesAccountId,
        amount,
        narration: "original credit",
      },
    ],
  };
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const accounts = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES
       ($1, $2, $3, 'Cash', 'Cash', '0', 'Dr'),
       ($1, $4, $5, 'Expense', 'Expense', '0', 'Dr')
     RETURNING id`,
    [
      ctx.companyId,
      `${TEST_PREFIX.toUpperCase()}-CASH2`,
      `${TEST_PREFIX} Alternate Cash`,
      `${TEST_PREFIX.toUpperCase()}-CONTRA2`,
      `${TEST_PREFIX} Alternate Contra`,
    ]
  );
  alternateCashId = accounts.rows[0].id;
  alternateContraId = accounts.rows[1].id;
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("Phase 7 — Payment and Receipt edits replace accounting evidence", () => {
  for (const voucherType of ["Payment", "Receipt"] as const) {
    it(`${voucherType} edit replaces account, amount, date and particulars without duplicate legs`, async () => {
      const created = await agent.post("/api/vouchers/payment-receipt").send(paymentReceiptBody(voucherType, "100"));
      expect(created.status).toBe(200);
      const voucherId = extractVoucherId(created.body);
      const oldEntries = await entriesFor(voucherId);
      expect(oldEntries).toHaveLength(2);
      assertBalanced(oldEntries);
      const oldIds = new Set(oldEntries.map((entry) => entry.id));

      const editedBody = {
        voucherType,
        voucherDate: EDIT_DATE,
        paymentAccountType: "ledger",
        paymentAccountId: alternateCashId,
        paymentAccountName: "Alternate Cash",
        entries: [
          {
            accountType: "ledger",
            accountId: alternateContraId,
            accountName: "Alternate Contra",
            amount: "275.50",
          },
        ],
        notes: `${voucherType} edited particulars`,
        currency: "USD",
      };

      const edited = await agent.patch(`/api/vouchers/${voucherId}/payment-receipt`).send(editedBody);
      expect(edited.status).toBe(200);

      const header = await voucherRow(voucherId);
      expect(header.voucher_type).toBe(voucherType);
      expect(header.voucher_date).toBe(EDIT_DATE);
      expect(header.description).toBe(`${voucherType} edited particulars`);
      expect(Number(header.total_amount)).toBeCloseTo(275.5, 6);
      expect(header.deleted_at).toBeNull();

      const entries = await entriesFor(voucherId);
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => !oldIds.has(entry.id))).toBe(true);
      assertBalanced(entries);

      const alternateCash = entries.find((entry) => entry.ledger_account_id === alternateCashId);
      const alternateContra = entries.find((entry) => entry.ledger_account_id === alternateContraId);
      expect(alternateCash).toBeDefined();
      expect(alternateContra).toBeDefined();
      expect(entries.every((entry) => entry.narration === `${voucherType} edited particulars`)).toBe(true);

      if (voucherType === "Payment") {
        expect(Number(alternateContra?.debit_amount)).toBeCloseTo(275.5, 6);
        expect(Number(alternateCash?.credit_amount)).toBeCloseTo(275.5, 6);
      } else {
        expect(Number(alternateCash?.debit_amount)).toBeCloseTo(275.5, 6);
        expect(Number(alternateContra?.credit_amount)).toBeCloseTo(275.5, 6);
      }

      // The update path is state-replacement, not additive. Repeating the same
      // supported edit may replace row identities again, but it must leave one
      // and only one balanced accounting representation of the document.
      const repeated = await agent.patch(`/api/vouchers/${voucherId}/payment-receipt`).send(editedBody);
      expect(repeated.status).toBe(200);
      const afterRepeat = await entriesFor(voucherId);
      expect(afterRepeat).toHaveLength(2);
      assertBalanced(afterRepeat);
      expect(Number((await voucherRow(voucherId)).total_amount)).toBeCloseTo(275.5, 6);
    });
  }
});

describe("Phase 7 — Journal edit replaces account, amount, currency, date and particulars", () => {
  it("rewrites a USD journal as CFA using one balanced replacement set", async () => {
    const created = await agent.post("/api/vouchers/journal").send(journalBody("100"));
    expect(created.status).toBe(200);
    const voucherId = extractVoucherId(created.body);
    const oldEntries = await entriesFor(voucherId);
    expect(oldEntries).toHaveLength(2);
    assertBalanced(oldEntries);
    const oldIds = new Set(oldEntries.map((entry) => entry.id));

    const editBody = {
      voucherDate: EDIT_DATE,
      notes: "CFA journal edited particulars",
      currency: "CFA",
      exchangeRate: "650",
      entries: [
        {
          type: "DR",
          accountType: "ledger",
          accountId: alternateCashId,
          amount: "6500",
          narration: "edited debit particulars",
        },
        {
          type: "CR",
          accountType: "ledger",
          accountId: alternateContraId,
          amount: "6500",
          narration: "edited credit particulars",
        },
      ],
    };

    const edited = await agent.patch(`/api/vouchers/${voucherId}/journal`).send(editBody);
    expect(edited.status).toBe(200);

    const header = await voucherRow(voucherId);
    expect(header.voucher_date).toBe(EDIT_DATE);
    expect(header.description).toBe("CFA journal edited particulars");
    expect(header.currency).toBe("CFA");
    expect(Number(header.exchange_rate)).toBeCloseTo(650, 6);
    // TRANSACTION_PER_BASE: 6,500 CFA / 650 = 10 USD historical base.
    expect(Number(header.total_amount)).toBeCloseTo(10, 6);

    const entries = await entriesFor(voucherId);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => !oldIds.has(entry.id))).toBe(true);
    assertBalanced(entries);

    const debit = entries.find((entry) => entry.ledger_account_id === alternateCashId);
    const credit = entries.find((entry) => entry.ledger_account_id === alternateContraId);
    expect(debit?.transaction_currency).toBe("CFA");
    expect(credit?.transaction_currency).toBe("CFA");
    expect(Number(debit?.transaction_debit_amount)).toBeCloseTo(6500, 6);
    expect(Number(credit?.transaction_credit_amount)).toBeCloseTo(6500, 6);
    expect(Number(debit?.base_debit_amount)).toBeCloseTo(10, 6);
    expect(Number(credit?.base_credit_amount)).toBeCloseTo(10, 6);
    expect(Number(debit?.historical_exchange_rate)).toBeCloseTo(650, 6);
    expect(Number(credit?.historical_exchange_rate)).toBeCloseTo(650, 6);
    expect(debit?.narration).toBe("edited debit particulars");
    expect(credit?.narration).toBe("edited credit particulars");

    const repeated = await agent.patch(`/api/vouchers/${voucherId}/journal`).send(editBody);
    expect(repeated.status).toBe(200);
    const afterRepeat = await entriesFor(voucherId);
    expect(afterRepeat).toHaveLength(2);
    assertBalanced(afterRepeat);
    expect(Number((await voucherRow(voucherId)).total_amount)).toBeCloseTo(10, 6);
  });
});
