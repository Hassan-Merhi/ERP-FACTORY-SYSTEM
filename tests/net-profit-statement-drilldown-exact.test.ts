/**
 * The net-profit drill-downs sum each account's entries as decimals.
 * Purchases of 0.10 and 0.20 are 0.3, not the float 0.30000000000000004 the
 * per-account balance and the total used to show.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "npsdrill";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let accountId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const account = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, 'PURCHASES-NPSDRILL', 'Drill purchases', 'Expense', 'Purchase', '0', 'Dr') RETURNING id`,
    [ctx.companyId]
  );
  accountId = account.rows[0].id;

  for (const [index, amount] of ["0.10", "0.20"].entries()) {
    const voucher = await pool.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
       VALUES ($1, $2, 'Journal', '2026-05-01', $3, false) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-${index}`, amount]
    );
    await pool.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
       VALUES ($1, $2, $4, '0'), ($1, $3, '0', $4)`,
      [voucher.rows[0].id, accountId, ctx.cashAccountId, amount]
    );
  }
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("net profit purchase-accounts drill-down", () => {
  it("returns exact per-account and total balances", async () => {
    const response = await agent.get("/api/reports/net-profit-statement/purchase-accounts");
    expect(response.status).toBe(200);
    const account = response.body.accounts.find((a: { id: number }) => a.id === accountId);
    expect(account).toMatchObject({ debit: 0.3, credit: 0, balance: 0.3 });
    expect(response.body.total).toBe(0.3);
  });
});

describe("Analytics expense period filters", () => {
  it("uses only the selected period's indirect expenses, including the factory endpoint", async () => {
    const account = await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
       VALUES ($1, 'INDIRECT-NPSDRILL', 'Period expense test', 'Expense', 'Indirect Expense', '0', 'Dr') RETURNING id`,
      [ctx.companyId]
    );
    const expenseAccountId = account.rows[0].id;

    for (const [index, date, amount] of [
      [0, "2026-09-30", "10.00"],
      [1, "2026-10-08", "20.00"],
    ] as const) {
      const voucher = await pool.query<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
         VALUES ($1, $2, 'Journal', $3, $4, false) RETURNING id`,
        [ctx.companyId, `${TEST_PREFIX}-expense-${index}`, date, amount]
      );
      await pool.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, $4, '0'), ($1, $3, '0', $4)`,
        [voucher.rows[0].id, expenseAccountId, ctx.cashAccountId, amount]
      );
    }

    // The factory endpoint is pinned to a Factory company (tenantIsolationBoundary),
    // so the seeded company must be one for both endpoints to read it.
    await pool.query("UPDATE companies SET company_type = 'factory' WHERE id = $1", [ctx.companyId]);

    for (const path of [
      "/api/reports/net-profit-statement/indirect-expenses",
      "/api/factory/analytics/indirect-expenses",
    ]) {
      const october = await agent.get(path).query({ startDate: "2026-10-01", endDate: "2026-10-15" });
      expect(october.status).toBe(200);
      expect(october.body.accounts.find((a: { id: number }) => a.id === expenseAccountId)).toMatchObject({
        debit: 20,
        credit: 0,
        balance: 20,
      });
      const allTime = await agent.get(path);
      expect(allTime.status).toBe(200);
      expect(allTime.body.accounts.find((a: { id: number }) => a.id === expenseAccountId)?.balance).toBe(30);
    }
  });
});
