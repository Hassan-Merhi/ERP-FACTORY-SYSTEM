/**
 * The factory customer statement kept a float running balance, and the
 * customer list summed four float components into each balance: sales of 0.10
 * and 0.20 showed a balance of 0.30000000000000004.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mexact21";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;

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
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, '0', 'Dr') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C`, `${TEST_PREFIX} Customer`]
  );
  customerId = customer.rows[0].id;
  await pool.query(
    `INSERT INTO customer_balances
       (company_id, customer_id, transaction_date, transaction_type, debit_amount, credit_amount, balance, currency)
     VALUES ($1, $2, '2026-10-01', 'SALE', '0.10', '0', '0.10', 'USD'),
            ($1, $2, '2026-10-02', 'SALE', '0.20', '0', '0.30', 'USD')`,
    [ctx.companyId, customerId]
  );
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM customer_balances WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("factory customer balances", () => {
  it("runs the statement balance exactly", async () => {
    const response = await agent.get(`/api/factory/customers/${customerId}/statement`);
    expect(response.status).toBe(200);
    expect(response.body.balanceHistory.map((row: { runningBalance: number }) => row.runningBalance)).toEqual([
      0.1, 0.3,
    ]);
    expect(response.body.currentBalance).toBe(0.3);
  });

  it("lists the customer at the exact balance", async () => {
    const response = await agent.get("/api/factory/customers");
    expect(response.status).toBe(200);
    const listed = response.body.find((customer: { id: number }) => customer.id === customerId);
    expect(listed).toMatchObject({ balance: 0.3, balanceSide: "Dr" });
  });
});
