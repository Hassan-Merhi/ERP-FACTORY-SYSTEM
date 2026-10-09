/**
 * The factory daybook shows ERP vouchers that have no daybook entry yet with
 * their USD amount at cents: a 1.13 payment at a rate of 1.5 is 1.70 USD (the
 * float product was shown whole, 1.6949999999999998).
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "fdblive";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let voucherId: number;

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

  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, currency, exchange_rate)
     VALUES ($1, 'Payment', $2, '2026-09-10', '1.13', 'EUR', '1.5') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-PV1`]
  );
  voucherId = voucher.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM vouchers WHERE id = $1`, [voucherId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("GET /api/factory/daybook", () => {
  it("shows a live foreign-currency voucher's USD amount at cents", async () => {
    const response = await agent.get("/api/factory/daybook?startDate=2026-09-01&endDate=2026-09-30");

    expect(response.status).toBe(200);
    const rows = Array.isArray(response.body) ? response.body : response.body.rows;
    const row = rows.find((r: { referenceId: number }) => r.referenceId === voucherId);
    expect(row).toMatchObject({ amountCurrency: "1.13", fxRateToUsd: "1.5", amountUsd: "1.7" });
  });
});
