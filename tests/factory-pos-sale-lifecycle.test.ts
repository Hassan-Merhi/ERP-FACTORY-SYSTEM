/**
 * Database-backed coverage for the restored Factory POS lifecycle:
 *
 *   - **Account options** list only the active, live cash and expense accounts
 *     of the session's own company.
 *   - **Voiding a sale takes it back out of the books**: its daybook rows and
 *     credit-customer balance rows go, and its receipt voucher is soft-deleted
 *     so balances exclude it while the audit trail keeps it.
 *   - **Editing a credit sale to cash** leaves no stale customer debt, and the
 *     sale gains a receipt voucher for the cash it now takes in; editing it back
 *     to credit with no deposit retires that voucher.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "fposlife";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let foreignCompanyId: number;
let posCashAccountId: number;
const accountIds: Record<string, number> = {};

async function seedAccount(companyId: number, code: string, accountType: string, extra = "") {
  const row = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active${extra ? ", deleted_at" : ""})
     VALUES ($1, $2, $3, $4, '0', $5${extra ? ", now()" : ""}) RETURNING id`,
    [companyId, `${TEST_PREFIX}-${code}`, `${TEST_PREFIX} ${code}`, accountType, code !== "INACTIVE"]
  );
  accountIds[code] = row.rows[0].id;
  return row.rows[0].id;
}

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

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CUST`, `${TEST_PREFIX} Customer`]
  );
  customerId = customer.rows[0].id;

  posCashAccountId = await seedAccount(ctx.companyId, "CASH", "Cash");
  await seedAccount(ctx.companyId, "EXP", "Direct Expense");
  await seedAccount(ctx.companyId, "INACTIVE", "Cash");
  await seedAccount(ctx.companyId, "DELETED", "Cash", "deleted");
  await seedAccount(ctx.companyId, "REVENUE", "Revenue");

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, base_currency) VALUES ($1, $2, 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}F`, `${TEST_PREFIX}_Foreign`]
  );
  foreignCompanyId = company.rows[0].id;
  await seedAccount(foreignCompanyId, "FOREIGN", "Cash");
}, 120000);

afterAll(async () => {
  const sales = `SELECT id FROM factory_pos_sales WHERE company_id = $1`;
  await pool.query(
    `DELETE FROM factory_daybook_entries WHERE company_id = $1 AND reference_table = 'factory_pos_sales'`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM customer_balances WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1 AND source_module = 'FACTORY_POS')`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1 AND source_module = 'FACTORY_POS'`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_pos_sale_items WHERE sale_id IN (${sales})`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_pos_sales WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

const items = [{ productName: "Mixed bale", quantity: 2, unitPrice: "50" }];

async function createSale(body: Record<string, unknown>): Promise<number> {
  const response = await agent.post("/api/factory/pos/sale").send({ items, txDate: "2026-10-01", ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.id;
}

async function books(saleId: number) {
  const [daybook, balances, liveVouchers, retiredVouchers] = await Promise.all([
    pool.query(
      `SELECT tx_type FROM factory_daybook_entries WHERE reference_table = 'factory_pos_sales' AND reference_id = $1`,
      [saleId]
    ),
    pool.query(
      `SELECT reference_type, debit_amount::numeric AS debit, credit_amount::numeric AS credit
         FROM customer_balances WHERE company_id = $1 AND reference_id = $2
          AND reference_type IN ('FACTORY_POS_SALE', 'FACTORY_POS_DEPOSIT')`,
      [ctx.companyId, saleId]
    ),
    pool.query<{ id: number; total_amount: string }>(
      `SELECT id, total_amount FROM vouchers WHERE company_id = $1 AND source_module = 'FACTORY_POS'
          AND voucher_number LIKE $2 AND deleted_at IS NULL`,
      [ctx.companyId, `FPOS-${saleId}-%`]
    ),
    pool.query(
      `SELECT id FROM vouchers WHERE company_id = $1 AND source_module = 'FACTORY_POS'
          AND voucher_number LIKE $2 AND deleted_at IS NOT NULL`,
      [ctx.companyId, `FPOS-${saleId}-%`]
    ),
  ]);
  return {
    daybook: daybook.rows.length,
    balances: balances.rows,
    liveVouchers: liveVouchers.rows,
    retiredVouchers: retiredVouchers.rows.length,
  };
}

describe("Factory POS account options", () => {
  it("lists the company's active, live cash and expense accounts only", async () => {
    const response = await agent.get("/api/factory/pos/account-options");
    expect(response.status).toBe(200);
    const ids = new Set((response.body as Array<{ id: number }>).map((account) => account.id));
    expect(ids.has(accountIds.CASH)).toBe(true);
    expect(ids.has(accountIds.EXP)).toBe(true);
    for (const excluded of ["INACTIVE", "DELETED", "REVENUE", "FOREIGN"]) {
      expect(ids.has(accountIds[excluded]), `${excluded} should not be offered`).toBe(false);
    }
  });
});

describe("voiding a Factory POS sale", () => {
  it("reverses a cash sale's daybook rows and receipt voucher", async () => {
    const saleId = await createSale({
      cashAccountId: posCashAccountId,
      expenses: [{ accountId: accountIds.EXP, amount: "5", description: "Loading" }],
    });
    const before = await books(saleId);
    expect(before.daybook).toBeGreaterThan(0);
    expect(before.liveVouchers).toHaveLength(1);

    expect((await agent.delete(`/api/factory/pos/sales/${saleId}`)).status).toBe(200);

    const after = await books(saleId);
    expect(after.daybook).toBe(0);
    expect(after.liveVouchers).toHaveLength(0);
    expect(after.retiredVouchers).toBe(1);
  });

  it("removes a credit sale's customer balance and deposit voucher", async () => {
    const saleId = await createSale({
      cashAccountId: posCashAccountId,
      paymentType: "CREDIT",
      customerId,
      depositAmount: "30",
    });
    const before = await books(saleId);
    expect(before.balances).toHaveLength(2);
    expect(before.liveVouchers).toHaveLength(1);

    expect((await agent.delete(`/api/factory/pos/sales/${saleId}`)).status).toBe(200);

    const after = await books(saleId);
    expect(after.balances).toHaveLength(0);
    expect(after.liveVouchers).toHaveLength(0);
    expect(after.daybook).toBe(0);
  });
});

describe("editing a Factory POS sale's payment type", () => {
  it("drops the customer debt and posts a receipt when a credit sale becomes cash", async () => {
    const saleId = await createSale({ cashAccountId: posCashAccountId, paymentType: "CREDIT", customerId });
    const before = await books(saleId);
    expect(before.balances).toHaveLength(1);
    expect(before.liveVouchers).toHaveLength(0);

    const edit = await agent
      .put(`/api/factory/pos/sales/${saleId}`)
      .send({ items, txDate: "2026-10-01", cashAccountId: posCashAccountId, paymentType: "CASH" });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    const after = await books(saleId);
    expect(after.balances).toHaveLength(0);
    expect(after.liveVouchers).toHaveLength(1);
    expect(Number(after.liveVouchers[0].total_amount)).toBe(100);
  });

  it("retires the receipt when a cash sale becomes credit with no deposit", async () => {
    const saleId = await createSale({ cashAccountId: posCashAccountId });
    expect((await books(saleId)).liveVouchers).toHaveLength(1);

    const edit = await agent.put(`/api/factory/pos/sales/${saleId}`).send({
      items,
      txDate: "2026-10-01",
      cashAccountId: posCashAccountId,
      paymentType: "CREDIT",
      customerId,
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    const after = await books(saleId);
    expect(after.liveVouchers).toHaveLength(0);
    expect(after.retiredVouchers).toBe(1);
    expect(after.balances).toHaveLength(1);
  });
});
