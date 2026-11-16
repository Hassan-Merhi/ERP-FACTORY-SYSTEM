/**
 * Phase 5 — authentication, authorization, not-found and tenant-scope paths.
 *
 * The important property is behavioral isolation: foreign-company IDs must not
 * become readable merely because the caller is authenticated in another tenant.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p5authz";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let foreignLedgerId: number;

async function selectCompany(): Promise<void> {
  const response = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  await selectCompany();

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'erp', true, 'USD') RETURNING id`,
    ["P5FRGN", `${TEST_PREFIX}_ForeignCompany`]
  );
  foreignCompanyId = company.rows[0].id;

  const ledger = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, $3, 'Cash', '777.00', 'Dr', true)
     RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX}_FOREIGN_CASH`, `${TEST_PREFIX} Foreign Cash`]
  );
  foreignLedgerId = ledger.rows[0].id;
}, 120000);

afterAll(async () => {
  // cleanupTestData finds both companies because both names contain TEST_PREFIX.
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("Phase 5 authentication and authorization branches", () => {
  it("returns 401 when a protected route is requested without a session", async () => {
    const response = await request(ctx.app).get("/api/vouchers");
    expect(response.status).toBe(401);
  });

  it("returns 403 when a POS role attempts a non-POS accounting create", async () => {
    await pool.query(
      `UPDATE user_company_roles SET role = 'POS' WHERE user_id = $1 AND company_id = $2`,
      [ctx.userId, ctx.companyId]
    );
    await selectCompany();

    const response = await agent.post("/api/vouchers/journal").send({
      voucherDate: "2026-09-14",
      clientRequestId: `${TEST_PREFIX}-pos-denied`,
      entries: [
        { type: "DR", accountType: "ledger", accountId: ctx.cashAccountId, amount: "10" },
        { type: "CR", accountType: "ledger", accountId: ctx.salesAccountId, amount: "10" },
      ],
    });
    expect(response.status).toBe(403);

    await pool.query(
      `UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2`,
      [ctx.userId, ctx.companyId]
    );
    await selectCompany();
  });

  it("does not allow selecting a company for which the user has no role", async () => {
    const response = await agent.post("/api/auth/set-company").send({ companyId: foreignCompanyId });
    expect(response.status).toBe(403);

    // A rejected company selection must not mutate the active tenant.
    const current = await agent.get(`/api/accounts/ledger/${ctx.cashAccountId}/balance`);
    expect(current.status).toBe(200);
  });

  it("returns 404 for a ledger account owned by another company", async () => {
    const [balance, currencies] = await Promise.all([
      agent.get(`/api/accounts/ledger/${foreignLedgerId}/balance`),
      agent.get(`/api/accounts/ledger/${foreignLedgerId}/currency-balances`),
    ]);

    expect(balance.status).toBe(404);
    expect(currencies.status).toBe(404);
  });

  it("returns 404 for a missing company-scoped resource", async () => {
    const response = await agent.get("/api/stock-items/2147483647");
    expect(response.status).toBe(404);
  });

  it("rejects factory routes while the active company is an ERP tenant", async () => {
    const response = await agent.get("/api/factory/suppliers");
    expect(response.status).toBe(403);
  });
});
