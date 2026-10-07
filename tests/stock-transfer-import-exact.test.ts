/**
 * The stock-transfer import values transfers exactly: 1.3 units at 0.35 is
 * 0.455, stored as 0.46 on the voucher and the transfer line. The float
 * product 0.45499999999999996 was stored as 0.45.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "stimpx";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  await pool.query(`DELETE FROM inventory WHERE company_id = $1 AND stock_item_id = $2`, [
    ctx.companyId,
    ctx.stockItemIds[0],
  ]);
  await pool.query(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, 10, 0.35, 3.5)`,
    [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
  );
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/stock-transfer-import/import", () => {
  it("values the transfer exactly", async () => {
    const res = await agent.post("/api/stock-transfer-import/import").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      transferDate: "2026-01-15",
      items: [{ barcode: `${TEST_PREFIX}-ITEM1`, quantity: 1.3 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.totalValue).toBe("0.46");

    const rows = await pool.query<{ total_amount: string; line_total: string }>(
      `SELECT v.total_amount, sti.total_amount AS line_total
         FROM vouchers v
         JOIN stock_transfer_vouchers stv ON stv.voucher_id = v.id
         JOIN stock_transfer_items sti ON sti.transfer_id = stv.id
        WHERE v.company_id = $1 AND v.voucher_type = 'Stock Transfer'`,
      [ctx.companyId]
    );
    expect(rows.rows).toEqual([{ total_amount: "0.46", line_total: expect.stringMatching(/^0\.46/) }]);
  });
});
