/**
 * Closed fiscal periods are locked (server/services/accounting/closedPeriodGuard.ts).
 *
 * Closing a fiscal period posts a closing journal that moves Income/Expense
 * balances to retained earnings. Before the guard, any later write dated inside
 * the closed range silently changed balances the closing journal had already
 * settled. The guard is a pair of database triggers, so these tests cover both
 * the HTTP surface (clean 409) and direct SQL (no write path can skip it):
 *
 *   - after a close, creating, editing the amounts of, or deleting a voucher
 *     dated on or before the close date is refused and leaves no trace;
 *   - entries of a closed voucher cannot be added, changed or removed;
 *   - narrative fields (description, narration) stay editable;
 *   - vouchers dated after the close date post normally;
 *   - an explicit transaction-local override and the maintenance scope bypass
 *     the lock (process-owned repair work);
 *   - a close waits for in-flight voucher writes in the company.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { ensureClosedPeriodGuard, CLOSED_PERIOD_ERROR_CODE } from "../server/services/accounting/closedPeriodGuard";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "closedperiod";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let retainedEarningsId: number;
let expenseAccountId: number;
let openVoucherId: number;
let seq = 0;

function voucherNumber(): string {
  seq += 1;
  return `${TEST_PREFIX}-V${seq}`;
}

function journal(date: string, amount = "100.00") {
  return {
    voucher: { voucherNumber: voucherNumber(), voucherType: "Journal", voucherDate: date },
    entries: [
      { ledgerAccountId: expenseAccountId, debitAmount: amount, creditAmount: "0" },
      { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: amount },
    ],
  };
}

async function voucherCountFor(number: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
    [ctx.companyId, number]
  );
  return Number(result.rows[0].count);
}

/** Runs SQL in its own transaction with no maintenance or override setting. */
async function inTenantTransaction<T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_scope_maintenance', 'off', true)");
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(ctx.companyId)]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function expectClosedPeriodRejection(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ code: CLOSED_PERIOD_ERROR_CODE });
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await ensureClosedPeriodGuard(pool);

  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const [retained] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}_RE`,
      name: "Retained Earnings",
      accountType: "Equity",
      openingBalance: "0",
      openingBalanceSide: "Cr",
    })
    .returning();
  retainedEarningsId = retained.id;

  const [expense] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}_RENT`,
      name: "Rent Expense",
      accountType: "Expense",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  expenseAccountId = expense.id;

  // Posted while 2025 is still open.
  const before = await agent.post("/api/vouchers/with-entries").send(journal("2025-06-15", "250.00"));
  expect(before.status).toBe(200);
  openVoucherId = before.body.voucher.id;

  const close = await agent.post("/api/fiscal-period/close").send({
    periodStartDate: "2025-01-01",
    periodEndDate: "2025-12-31",
    retainedEarningsAccountId: retainedEarningsId,
    notes: "FY2025",
  });
  expect(close.status).toBe(200);
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("closed fiscal period lock — HTTP", () => {
  it("refuses a new voucher dated inside the closed period with a 409 and writes nothing", async () => {
    const body = journal("2025-11-30");
    const response = await agent.post("/api/vouchers/with-entries").send(body);
    expect(response.status).toBe(409);
    expect(response.body.message).toContain("Accounting period closed");
    expect(response.body.message).toContain("2025-12-31");
    expect(await voucherCountFor(body.voucher.voucherNumber)).toBe(0);
  });

  it("refuses a voucher dated on the close date itself", async () => {
    const response = await agent.post("/api/vouchers/with-entries").send(journal("2025-12-31"));
    expect(response.status).toBe(409);
  });

  it("refuses a voucher dated before the closed period's start (books are closed through the end date)", async () => {
    const response = await agent.post("/api/vouchers/with-entries").send(journal("2024-03-01"));
    expect(response.status).toBe(409);
  });

  it("refuses a USD voucher on the central engine path too", async () => {
    const body = { ...journal("2025-10-01"), clientRequestId: `${TEST_PREFIX}-central-1` };
    const response = await agent.post("/api/vouchers/with-entries").send(body);
    expect(response.status).toBe(409);
    expect(response.body.message).toContain("Accounting period closed");
  });

  it("still posts a voucher dated after the closed period", async () => {
    const response = await agent.post("/api/vouchers/with-entries").send(journal("2026-01-02"));
    expect(response.status).toBe(200);
  });

  it("refuses deleting a voucher inside the closed period and leaves it posted", async () => {
    const response = await agent.delete(`/api/vouchers/${openVoucherId}`);
    expect(response.status).toBe(409);
    const [voucher] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, openVoucherId));
    expect(voucher.deletedAt).toBeNull();
  });

  it("refuses closing an earlier period once later books are closed", async () => {
    const response = await agent.post("/api/fiscal-period/close").send({
      periodStartDate: "2024-01-01",
      periodEndDate: "2024-12-31",
      retainedEarningsAccountId: retainedEarningsId,
    });
    expect(response.status).toBe(409);
  });
});

describe("closed fiscal period lock — database triggers", () => {
  it("refuses an amount change on a closed voucher's entry", async () => {
    await expectClosedPeriodRejection(
      inTenantTransaction((client) =>
        client.query(`UPDATE voucher_entries SET debit_amount = '999.00' WHERE voucher_id = $1 AND debit_amount > 0`, [
          openVoucherId,
        ])
      )
    );
  });

  it("refuses inserting or deleting entries of a closed voucher", async () => {
    await expectClosedPeriodRejection(
      inTenantTransaction((client) =>
        client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, '1.00', '0')`,
          [openVoucherId, expenseAccountId]
        )
      )
    );
    await expectClosedPeriodRejection(
      inTenantTransaction((client) =>
        client.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [openVoucherId])
      )
    );
  });

  it("refuses moving a closed voucher's date out of the period, and moving an open one into it", async () => {
    await expectClosedPeriodRejection(
      inTenantTransaction((client) =>
        client.query(`UPDATE vouchers SET voucher_date = '2026-02-01' WHERE id = $1`, [openVoucherId])
      )
    );

    const open = await agent.post("/api/vouchers/with-entries").send(journal("2026-01-10"));
    expect(open.status).toBe(200);
    await expectClosedPeriodRejection(
      inTenantTransaction((client) =>
        client.query(`UPDATE vouchers SET voucher_date = '2025-07-01' WHERE id = $1`, [open.body.voucher.id])
      )
    );
    await expectClosedPeriodRejection(
      inTenantTransaction((client) =>
        client.query(`UPDATE vouchers SET effective_date = '2025-07-01' WHERE id = $1`, [open.body.voucher.id])
      )
    );
  });

  it("keeps descriptions and narrations editable", async () => {
    await inTenantTransaction(async (client) => {
      await client.query(`UPDATE vouchers SET description = 'Reworded' WHERE id = $1`, [openVoucherId]);
      await client.query(`UPDATE voucher_entries SET narration = 'Reworded' WHERE voucher_id = $1`, [openVoucherId]);
    });
    const [voucher] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, openVoucherId));
    expect(voucher.description).toBe("Reworded");
  });

  it("lets an explicit transaction-local override and the maintenance scope through", async () => {
    await inTenantTransaction(async (client) => {
      await client.query("SELECT set_config('app.closed_period_override', 'on', true)");
      await client.query(`UPDATE vouchers SET total_amount = total_amount WHERE id = $1`, [openVoucherId]);
      await client.query(`UPDATE vouchers SET optional = optional WHERE id = $1`, [openVoucherId]);
      await client.query(`UPDATE voucher_entries SET debit_amount = debit_amount + 0 WHERE voucher_id = $1`, [
        openVoucherId,
      ]);
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      const result = await client.query(`UPDATE vouchers SET exchange_rate = '1' WHERE id = $1`, [openVoucherId]);
      expect(result.rowCount).toBe(1);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("makes a fiscal close wait for an in-flight voucher write in the same company", async () => {
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT set_config('app.company_scope_maintenance', 'off', true)");
      // Any guarded write takes the shared side of the company's close lock.
      await writer.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-06-30', '0')`,
        [ctx.companyId, voucherNumber()]
      );

      let closeFinished = false;
      const close = agent
        .post("/api/fiscal-period/close")
        .send({
          periodStartDate: "2026-01-01",
          periodEndDate: "2026-06-30",
          retainedEarningsAccountId: retainedEarningsId,
        })
        .then((response) => {
          closeFinished = true;
          return response;
        });

      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(closeFinished).toBe(false);

      await writer.query("COMMIT");
      const response = await close;
      expect(response.status).toBe(200);
    } finally {
      writer.release();
    }
  });
});
