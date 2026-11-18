import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `zpcust${Date.now().toString(36)}`;
let ctx: TestContext;
let agent: request.SuperAgentTest;
let cashierId = "";
let createdCustomerId = 0;

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  const bcrypt = await import("bcryptjs");
  const hash = await bcrypt.hash("testpassword123", 10);
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users (username, password, active) VALUES ($1, $2, true) RETURNING id",
    [`${PREFIX}_pos`, hash]
  );
  cashierId = user.rows[0].id;
  await pool.query(
    `INSERT INTO user_company_roles
       (user_id, company_id, role, assigned_location_id, cash_account_id, can_access_customers)
     VALUES ($1, $2, 'POS', $3, $4, false)`,
    [cashierId, ctx.companyId, ctx.locationId, ctx.cashAccountId]
  );
  agent = request.agent(ctx.app) as request.SuperAgentTest;
  const login = await agent.post("/api/auth/login").send({ username: `${PREFIX}_pos`, password: "testpassword123" });
  expect(login.status, login.text).toBe(200);
  const company = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(company.status, company.text).toBe(200);
}, 120_000);

afterAll(async () => {
  if (ctx) await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("Phase 2 Zambia POS customer creation", () => {
  it("blocks the customer list, statements and creation when disabled", async () => {
    const rows = await agent.get("/api/pos/customers");
    expect(rows.status).toBe(403);
    expect((await agent.get("/api/pos/customers/1/transactions")).status).toBe(403);
    const created = await agent.post("/api/pos/customers").send({ legalName: "Forbidden customer" });
    expect(created.status).toBe(403);
  });

  it("grants access from the live company role without requiring another login", async () => {
    await pool.query(
      "UPDATE user_company_roles SET can_access_customers = true WHERE user_id = $1 AND company_id = $2",
      [cashierId, ctx.companyId]
    );
    const list = await agent.get("/api/pos/customers");
    expect(list.status, list.text).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);

    const created = await agent.post("/api/pos/customers").send({
      legalName: "Authorized Cash Customer",
      phone: "+260999000123",
      openingBalance: "0",
      openingBalanceSide: "Dr",
      companyId: ctx.companyId + 100_000,
      active: false,
    });
    expect(created.status, created.text).toBe(201);
    createdCustomerId = Number(created.body.id);
    expect(createdCustomerId).toBeGreaterThan(0);

    const saved = await pool.query<{
      company_id: number;
      legal_name: string;
      opening_balance: string;
      opening_balance_side: string;
      ledger_account_id: number;
      active: boolean;
    }>(
      `SELECT company_id, legal_name, opening_balance, opening_balance_side, ledger_account_id, active
         FROM customers WHERE id = $1`,
      [createdCustomerId]
    );
    expect(saved.rows[0]).toMatchObject({
      company_id: ctx.companyId,
      legal_name: "Authorized Cash Customer",
      opening_balance: "0.00",
      opening_balance_side: "Dr",
      active: true,
    });
    const linked = await pool.query<{ company_id: number; opening_balance: string }>(
      "SELECT company_id, opening_balance FROM ledger_accounts WHERE id = $1",
      [saved.rows[0].ledger_account_id]
    );
    expect(linked.rows[0]).toEqual({ company_id: ctx.companyId, opening_balance: "0.00" });
    expect((await agent.get(`/api/pos/customers/${createdCustomerId}/transactions`)).status).toBe(200);
  });

  it("prevents forged opening balances and arbitrary ledger links", async () => {
    const nonzero = await agent.post("/api/pos/customers").send({
      legalName: "Forged opening balance",
      openingBalance: "5000",
    });
    expect(nonzero.status).toBe(403);
    expect(nonzero.body.code).toBe("POS_CUSTOMER_OPENING_BALANCE_DENIED");

    const linked = await agent.post("/api/pos/customers").send({
      legalName: "Forged linked account",
      ledgerAccountId: ctx.cashAccountId,
    });
    expect(linked.status).toBe(403);
    expect(linked.body.code).toBe("POS_CUSTOMER_LEDGER_LINK_DENIED");
  });

  it("revokes access immediately, even while the session still says enabled", async () => {
    const refreshed = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    expect(refreshed.status, refreshed.text).toBe(200);
    await pool.query(
      "UPDATE user_company_roles SET can_access_customers = false WHERE user_id = $1 AND company_id = $2",
      [cashierId, ctx.companyId]
    );
    expect((await agent.get("/api/pos/customers")).status).toBe(403);
    expect((await agent.post("/api/pos/customers").send({ legalName: "Revoked" })).status).toBe(403);
    expect((await agent.get(`/api/pos/customers/${createdCustomerId}/transactions`)).status).toBe(403);
  });

  it("leaves company customers readable but blocks writes for POS view-only users", async () => {
    await pool.query(
      "UPDATE user_company_roles SET can_access_customers = true, pos_view_only = true WHERE user_id = $1 AND company_id = $2",
      [cashierId, ctx.companyId]
    );
    expect((await agent.get("/api/pos/customers")).status).toBe(200);
    expect((await agent.post("/api/pos/customers").send({ legalName: "View-only" })).status).toBe(403);
  });
});
