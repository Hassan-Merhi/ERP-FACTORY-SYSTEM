/**
 * Balance sheet built on the trial balance (wave 9).
 *
 * /api/reports/balance-sheet used to read raw lines without the optional and
 * deleted filters, ignore opening sides and recognise only three account
 * types. It now classifies the trial balance's rows, so a balanced posting
 * moves both sides by the same amount, the income-statement accounts land in
 * the current earnings line, an optional voucher changes nothing, and the
 * remaining difference is exactly the trial balance's unexplained difference.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "bstb";
const today = new Date().toISOString().slice(0, 10);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;

async function account(code: string, accountType: string): Promise<number> {
  const [created] = await db
    .insert(schema.ledgerAccounts)
    .values({ companyId: ctx.companyId, code: `${TEST_PREFIX}-${code}`, name: `${TEST_PREFIX} ${code}`, accountType })
    .returning();
  return created.id;
}

async function journal(lines: Array<[number, string, string]>, optional = false): Promise<void> {
  sequence += 1;
  await db.transaction(async (tx) => {
    const [voucher] = await tx
      .insert(schema.vouchers)
      .values({
        companyId: ctx.companyId,
        voucherNumber: `${TEST_PREFIX.toUpperCase()}-J${sequence}-${Date.now()}`,
        voucherType: "Journal",
        voucherDate: today,
        totalAmount: lines.reduce((sum, [, debit]) => sum + Number(debit), 0).toFixed(2),
        currency: "USD",
        optional,
      })
      .returning();
    await tx.insert(schema.voucherEntries).values(
      lines.map(([ledgerAccountId, debitAmount, creditAmount]) => ({
        voucherId: voucher.id,
        ledgerAccountId,
        debitAmount,
        creditAmount,
      }))
    );
  });
}

async function balanceSheet() {
  const res = await agent.get(`/api/reports/balance-sheet?asOfDate=${today}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    assets: { total: string };
    liabilities: { total: string };
    equity: { total: string; currentEarnings: string };
    unclassified: { total: string };
    difference: string;
  };
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("balance sheet from the trial balance", () => {
  it("moves both sides by a balanced posting and keeps the trial balance's difference", async () => {
    const cash = await account("CASH", "Cash");
    const capital = await account("CAPITAL", "Equity");
    const rent = await account("RENT", "Indirect Expense");
    const before = await balanceSheet();

    // Owner puts 1,000 in; 200 of rent is paid; an optional voucher changes nothing.
    await journal([
      [cash, "1000.00", "0"],
      [capital, "0", "1000.00"],
    ]);
    await journal([
      [rent, "200.00", "0"],
      [cash, "0", "200.00"],
    ]);
    await journal(
      [
        [cash, "5000.00", "0"],
        [capital, "0", "5000.00"],
      ],
      true
    );
    const after = await balanceSheet();

    const delta = (key: (sheet: typeof after) => string) => Number(key(after)) - Number(key(before));
    expect(delta((sheet) => sheet.assets.total)).toBeCloseTo(800, 2);
    expect(delta((sheet) => sheet.equity.total)).toBeCloseTo(800, 2);
    expect(delta((sheet) => sheet.equity.currentEarnings)).toBeCloseTo(-200, 2);
    expect(delta((sheet) => sheet.liabilities.total)).toBeCloseTo(0, 2);
    expect(after.difference).toBe(before.difference);

    const trialBalance = await agent.get(`/api/accounting/trial-balance?asOf=${today}`);
    expect(trialBalance.status).toBe(200);
    expect(Number(after.difference)).toBeCloseTo(Number(trialBalance.body.unexplainedDifference), 2);
  }, 60_000);
});
