/**
 * GET /api/offloads/:id prices the live per-bale charge exactly: 2.01 of
 * duty over 2 bales is 1.005 per bale, shown as 1.01. The float path
 * computed Math.round(1.005 * 100) / 100 on 100.49999999999999 and showed
 * 1.00.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "offlivx";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let offloadId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SUP`, `${TEST_PREFIX} Supplier`, `${TEST_PREFIX}@example.com`]
  );
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, offload_date)
     VALUES ($1, $2, $3, 'OFFLOADED', '2026-07-01', '2026-08-01') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CNT`, supplier.rows[0].id]
  );
  const offload = await pool.query<{ id: number }>(
    `INSERT INTO container_offloads (container_id, location_id, total_bales, additional_cost_per_bale, optional)
     VALUES ($1, $2, '2.000', '0.00', false) RETURNING id`,
    [container.rows[0].id, ctx.locationId]
  );
  offloadId = offload.rows[0].id;
  await pool.query(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Journal', '2026-08-01', '2.01')`,
    [ctx.companyId, `DUTY-${TEST_PREFIX}-CNT-1`]
  );
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("GET /api/offloads/:id live charges", () => {
  it("divides the live charges by the bales exactly", async () => {
    const res = await agent.get(`/api/offloads/${offloadId}`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.liveCharges).toMatchObject({ duties: 2.01, totalAllCharges: 2.01, additionalCostPerBale: 1.01 });
  });
});
