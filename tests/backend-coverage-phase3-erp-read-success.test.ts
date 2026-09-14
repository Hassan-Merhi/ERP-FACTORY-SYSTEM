/**
 * Phase 3 backend coverage — ERP read-route success paths.
 *
 * These are deliberately behavioural integration tests: every request goes
 * through the real Express registrar/session middleware and reads rows seeded
 * into the PostgreSQL test database. No route handler or storage method is
 * mocked.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p3erprd";
const TRANSPORTER_NAME = `${TEST_PREFIX}_Carrier`;

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let containerId: number;

async function login(): Promise<void> {
  const loginResponse = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (loginResponse.status !== 200) {
    throw new Error(`Login failed: ${loginResponse.status} ${loginResponse.text}`);
  }

  const companyResponse = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (companyResponse.status !== 200) {
    throw new Error(`Company selection failed: ${companyResponse.status} ${companyResponse.text}`);
  }
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await login();

  // Re-use the seeded cash account as a Loans account so the transporter list
  // exercises its real EXISTS join instead of succeeding with an empty fixture.
  await pool.query(
    `UPDATE ledger_accounts
        SET account_type = 'Loans', name = $1
      WHERE id = $2 AND company_id = $3`,
    [TRANSPORTER_NAME, ctx.cashAccountId, ctx.companyId]
  );

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SUP`, `${TEST_PREFIX} Supplier`, `${TEST_PREFIX}@example.test`]
  );
  supplierId = supplier.rows[0].id;

  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers
       (company_id, container_number, supplier_id, status, import_date, transporter)
     VALUES ($1, $2, $3, 'OTW', '2026-09-01', $4)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX.toUpperCase()}0000001`, supplierId, TRANSPORTER_NAME]
  );
  containerId = container.rows[0].id;

  await pool.query(
    `INSERT INTO transporter_payment_settings
       (company_id, ledger_account_id, payment_terms_days)
     VALUES ($1, $2, 21)
     ON CONFLICT (company_id, ledger_account_id)
     DO UPDATE SET payment_terms_days = EXCLUDED.payment_terms_days, updated_at = now()`,
    [ctx.companyId, ctx.cashAccountId]
  );
}, 120000);

afterAll(async () => {
  if (ctx?.companyId) {
    await pool
      .query("DELETE FROM transporter_payment_settings WHERE company_id = $1", [ctx.companyId])
      .catch(() => undefined);
  }
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("Phase 3 ERP read success paths", () => {
  it("reads a seeded ledger pre-period balance from the account statement route", async () => {
    const response = await agent.get(
      `/api/accounts/ledger/${ctx.cashAccountId}/pre-period-balance?endDate=2026-09-14`
    );

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("balance");
    expect(Number.isFinite(Number(response.body.balance))).toBe(true);
  });

  it("reads deleted-voucher history for a seeded ledger account", async () => {
    const response = await agent.get(`/api/accounts/ledger/${ctx.cashAccountId}/deleted-vouchers`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it("returns the seeded stock item from the detail route", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const response = await agent.get(`/api/stock-items/${stockItemId}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(stockItemId);
    expect(response.body.companyId).toBe(ctx.companyId);
  });

  it("runs stock-item transaction and detail history against the seeded item", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const [transactions, details, voucherHistory] = await Promise.all([
      agent.get(`/api/stock-items/${stockItemId}/transactions`),
      agent.get(`/api/stock-items/${stockItemId}/details`),
      agent.get(`/api/stock-items/${stockItemId}/voucher-history`),
    ]);

    expect(transactions.status).toBe(200);
    expect(Array.isArray(transactions.body)).toBe(true);

    expect(details.status).toBe(200);
    expect(Array.isArray(details.body.purchases)).toBe(true);
    expect(Array.isArray(details.body.sales)).toBe(true);
    expect(Array.isArray(details.body.inventoryLocations)).toBe(true);
    expect(details.body.inventoryLocations.length).toBeGreaterThan(0);

    expect(voucherHistory.status).toBe(200);
    expect(Array.isArray(voucherHistory.body)).toBe(true);
  });

  it("reads location prices through the real stock-item lookup", async () => {
    const response = await agent.get(`/api/stock-items/${ctx.stockItemIds[0]}/location-prices`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it("discovers a seeded active transporter through the ranked transporter-statement read route", async () => {
    const response = await agent.get("/api/transporter-statement/transporters");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.some((row: { id?: number; name?: string }) => row.id === ctx.cashAccountId && row.name === TRANSPORTER_NAME)).toBe(true);
  });

  it("reads seeded transporter payment terms", async () => {
    const response = await agent.get(`/api/transporter-statement/${ctx.cashAccountId}/settings`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ paymentTermsDays: 21 });
  });

  it("keeps the transporter discovery fixture tied to this company", async () => {
    const row = await pool.query<{ company_id: number; supplier_id: number; transporter: string }>(
      `SELECT company_id, supplier_id, transporter FROM containers WHERE id = $1`,
      [containerId]
    );

    expect(row.rows[0]).toEqual({
      company_id: ctx.companyId,
      supplier_id: supplierId,
      transporter: TRANSPORTER_NAME,
    });
  });
});
