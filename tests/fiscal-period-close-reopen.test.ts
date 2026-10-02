/**
 * Fiscal close and reopen (server/storage/accounting/fiscal-periods.ts).
 *
 *   - The closing journal zeroes every Income/Expense balance exactly
 *     (decimal arithmetic, a debit-balance income account included) and
 *     balances against retained earnings.
 *   - Periods are contiguous; the first close cannot leave earlier
 *     income/expense entries locked but never closed.
 *   - Reopening the latest close removes the closing journal from the books,
 *     restores the opening balances the close zeroed, and lifts the lock back
 *     to the previous close; the same period can then be closed again.
 *   - Only the latest close can be reopened, and only with a reason.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull, like } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { ensureClosedPeriodGuard } from "../server/services/accounting/closedPeriodGuard";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "fiscalreopen";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let retainedId: number;
let rentId: number;
let refundsId: number;
let seq = 0;

async function account(code: string, name: string, accountType: string, openingBalance = "0", side = "Dr") {
  const [row] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}_${code}`,
      name,
      accountType,
      openingBalance,
      openingBalanceSide: side,
    })
    .returning();
  return row.id;
}

async function post(date: string, debitAccountId: number, creditAccountId: number, amount: string) {
  seq += 1;
  return agent.post("/api/vouchers/with-entries").send({
    voucher: { voucherNumber: `${TEST_PREFIX}-V${seq}`, voucherType: "Journal", voucherDate: date },
    entries: [
      { ledgerAccountId: debitAccountId, debitAmount: amount, creditAmount: "0" },
      { ledgerAccountId: creditAccountId, debitAmount: "0", creditAmount: amount },
    ],
  });
}

async function closingLines(periodEndDate: string) {
  const [voucher] = await db
    .select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, ctx.companyId),
        like(schema.vouchers.voucherNumber, `FISCAL-CLOSE-${periodEndDate}-%`),
        isNull(schema.vouchers.deletedAt)
      )
    );
  const entries = await db.select().from(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, voucher.id));
  return { voucher, entries };
}

async function openingOf(accountId: number) {
  const [row] = await db.select().from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.id, accountId));
  return `${Number(row.openingBalance).toFixed(2)} ${row.openingBalanceSide}`;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await ensureClosedPeriodGuard(pool);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" }))
      .status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  retainedId = await account("RE", "Retained Earnings", "Equity", "0", "Cr");
  rentId = await account("RENT", "Rent Expense", "Expense", "40.00", "Dr");
  // An income account that ends the period with a debit balance.
  refundsId = await account("REFUNDS", "Refunds Income", "Income");

  expect((await post("2026-01-10", ctx.cashAccountId, ctx.salesAccountId, "0.10")).status).toBe(200);
  expect((await post("2026-01-11", ctx.cashAccountId, ctx.salesAccountId, "0.20")).status).toBe(200);
  expect((await post("2026-01-12", rentId, ctx.cashAccountId, "100.00")).status).toBe(200);
  expect((await post("2026-01-13", refundsId, ctx.cashAccountId, "5.00")).status).toBe(200);
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("fiscal close", () => {
  it("refuses a first close that would leave earlier income/expense entries unclosed", async () => {
    const response = await agent.post("/api/fiscal-period/close").send({
      periodStartDate: "2026-01-12",
      periodEndDate: "2026-01-31",
      retainedEarningsAccountId: retainedId,
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("2026-01-10");
  });

  it("closes every income/expense balance exactly against retained earnings", async () => {
    const response = await agent.post("/api/fiscal-period/close").send({
      periodStartDate: "2026-01-01",
      periodEndDate: "2026-01-31",
      retainedEarningsAccountId: retainedId,
    });
    expect(response.status).toBe(200);
    // Income 0.30 - 5.00 refunds = -4.70; expense 40 opening + 100 = 140.
    expect(response.body.totalIncome).toBe("-4.70");
    expect(response.body.totalExpense).toBe("140.00");
    expect(response.body.netIncome).toBe("-144.70");

    const { voucher, entries } = await closingLines("2026-01-31");
    const side = (id: number) => entries.find((entry) => entry.ledgerAccountId === id)!;
    expect(side(ctx.salesAccountId).debitAmount).toBe("0.30");
    expect(side(rentId).creditAmount).toBe("140.00");
    expect(side(refundsId).creditAmount).toBe("5.00");
    expect(side(retainedId).debitAmount).toBe("144.70");
    const debits = entries.reduce((sum, entry) => sum + Math.round(Number(entry.debitAmount) * 100), 0);
    const credits = entries.reduce((sum, entry) => sum + Math.round(Number(entry.creditAmount) * 100), 0);
    expect(debits).toBe(credits);
    expect(voucher.totalAmount).toBe((debits / 100).toFixed(2));
    for (const entry of entries) {
      expect(Number(entry.debitAmount)).toBeGreaterThanOrEqual(0);
      expect(Number(entry.creditAmount)).toBeGreaterThanOrEqual(0);
    }
    expect(await openingOf(rentId)).toBe("0.00 Dr");
  });

  it("requires the next period to start the day after the last close", async () => {
    const response = await agent.post("/api/fiscal-period/close").send({
      periodStartDate: "2026-02-02",
      periodEndDate: "2026-02-28",
      retainedEarningsAccountId: retainedId,
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("2026-02-01");
  });
});

describe("fiscal reopen", () => {
  it("reopens only the latest close, with a reason, and restores the books", async () => {
    expect((await post("2026-02-05", rentId, ctx.cashAccountId, "10.00")).status).toBe(200);
    const february = await agent.post("/api/fiscal-period/close").send({
      periodStartDate: "2026-02-01",
      periodEndDate: "2026-02-28",
      retainedEarningsAccountId: retainedId,
    });
    expect(february.status).toBe(200);

    const closures = (await agent.get("/api/fiscal-period/closures")).body as Array<{
      id: number;
      periodEndDate: string;
    }>;
    const january = closures.find((closure) => closure.periodEndDate === "2026-01-31")!;
    expect((await agent.post(`/api/fiscal-period/${january.id}/reopen`).send({ reason: "Correction" })).status).toBe(
      409
    );
    expect((await agent.post(`/api/fiscal-period/${february.body.id}/reopen`).send({})).status).toBe(400);

    const reopenFebruary = await agent
      .post(`/api/fiscal-period/${february.body.id}/reopen`)
      .send({ reason: "Missed invoice" });
    expect(reopenFebruary.status).toBe(200);
    // February is open again, January still closed.
    expect((await post("2026-02-20", rentId, ctx.cashAccountId, "1.00")).status).toBe(200);
    expect((await post("2026-01-20", rentId, ctx.cashAccountId, "1.00")).status).toBe(409);

    const reopenJanuary = await agent.post(`/api/fiscal-period/${january.id}/reopen`).send({ reason: "Audit" });
    expect(reopenJanuary.status).toBe(200);
    expect(await openingOf(rentId)).toBe("40.00 Dr");
    expect((await post("2026-01-20", rentId, ctx.cashAccountId, "1.00")).status).toBe(200);

    // The same period closes again, with its own posting identity.
    const again = await agent.post("/api/fiscal-period/close").send({
      periodStartDate: "2026-01-01",
      periodEndDate: "2026-01-31",
      retainedEarningsAccountId: retainedId,
    });
    expect(again.status).toBe(200);
    expect(again.body.totalExpense).toBe("141.00");
    const { voucher } = await closingLines("2026-01-31");
    expect(voucher.voucherNumber).toBe("FISCAL-CLOSE-2026-01-31-2");
  });

  it("reconstructs opening balances for a close recorded before snapshots existed", async () => {
    const closures = (await agent.get("/api/fiscal-period/closures")).body as Array<{
      id: number;
      periodEndDate: string;
    }>;
    const january = closures.find((closure) => closure.periodEndDate === "2026-01-31")!;
    await pool.query("UPDATE fiscal_period_closures SET opening_balance_snapshot = NULL WHERE id = $1", [january.id]);

    const response = await agent.post(`/api/fiscal-period/${january.id}/reopen`).send({ reason: "Legacy" });
    expect(response.status).toBe(200);
    expect(await openingOf(rentId)).toBe("40.00 Dr");
    expect(await openingOf(ctx.salesAccountId)).toBe("0.00 Cr");
  });
});
