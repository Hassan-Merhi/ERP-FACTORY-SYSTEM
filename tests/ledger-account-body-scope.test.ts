/**
 * Paying a payroll run, a factory POS sale and a raw-stock offload each post
 * to ledger accounts named by id in the request body. The path-based company
 * scope never sees those ids, so each route refuses an account that belongs
 * to another company before it writes anything.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "ledgerscope";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let foreignAccountId: number;
let runId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, base_currency) VALUES ($1, $2, 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}F`, `${TEST_PREFIX}_Foreign`]
  );
  foreignCompanyId = company.rows[0].id;
  const account = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance)
     VALUES ($1, 'LSF-CASH', 'Foreign cash', 'Asset', '0') RETURNING id`,
    [foreignCompanyId]
  );
  foreignAccountId = account.rows[0].id;
  const run = await pool.query<{ id: number }>(
    `INSERT INTO erp_payroll_runs (company_id, status, date, created_at)
     VALUES ($1, 'DRAFT', '2026-10-01', '2026-10-01T00:00:00Z') RETURNING id`,
    [ctx.companyId]
  );
  runId = run.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM erp_payroll_runs WHERE id = $1`, [runId]);
  await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

async function voucherCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*) FROM vouchers WHERE company_id = $1`, [
    ctx.companyId,
  ]);
  return Number(result.rows[0].count);
}

describe("routes refuse another company's ledger account from the body", () => {
  it("payroll run payment refuses a foreign payment account and stays a draft", async () => {
    const before = await voucherCount();
    const response = await agent
      .patch(`/api/payroll/runs/${runId}`)
      .send({ action: "pay", paymentAccountId: foreignAccountId, date: "2026-10-01" });

    expect([response.status, response.body.message]).toEqual([404, "Payment account not found"]);
    const run = await pool.query(`SELECT status FROM erp_payroll_runs WHERE id = $1`, [runId]);
    expect(run.rows[0].status).toBe("DRAFT");
    expect(await voucherCount()).toBe(before);
  });

  it("factory POS sale refuses a foreign cash account, expense account or location", async () => {
    const before = await voucherCount();
    const items = [{ productName: "Item", quantity: 1, unitPrice: "10" }];
    const responses = [
      await agent.post("/api/factory/pos/sale").send({ items, cashAccountId: foreignAccountId }),
      await agent.post("/api/factory/pos/sale").send({
        items,
        cashAccountId: ctx.cashAccountId,
        expenses: [{ accountId: foreignAccountId, description: "Fee", amount: "1" }],
      }),
    ];
    expect(responses.map((response) => [response.status, response.body.message])).toEqual([
      [400, "Account not found"],
      [400, "Account not found"],
    ]);
    expect(await voucherCount()).toBe(before);
  });

  it("raw-stock offload refuses foreign freight, duty and commission accounts", async () => {
    const responses = [
      await agent.post("/api/factory/raw-stock/offload").send({ containerId: 1, freightAccountId: foreignAccountId }),
      await agent.post("/api/factory/raw-stock/offload").send({ containerId: 1, dutyAccountId: foreignAccountId }),
      await agent
        .post("/api/factory/raw-stock/offload")
        .send({ containerId: 1, commission: { ledgerAccountId: String(foreignAccountId) } }),
    ];
    expect(responses.map((response) => [response.status, response.body.message])).toEqual([
      [400, "Account not found"],
      [400, "Account not found"],
      [400, "Account not found"],
    ]);
  });

  it("still lets the company's own cash account past the account check", async () => {
    const response = await agent
      .post("/api/factory/raw-stock/offload")
      .send({ containerId: 999999999, freightAccountId: ctx.cashAccountId });
    expect(response.body.message).not.toBe("Account not found");
  });
});
