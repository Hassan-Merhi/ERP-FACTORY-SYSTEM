/**
 * A POS sale's voucher total is the sum of its lines at cents. 1.3 units at
 * 0.35 is 0.455: the stored sale line was 0.46 but the voucher total and both
 * legs were built from the float product 0.45499999999999996 and stored 0.45.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";

const TEST_PREFIX = "posexact";

let ctx: TestContext;
let agent: request.SuperAgentTest;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  await db
    .insert(schema.inventory)
    .values({
      companyId: ctx.companyId,
      locationId: ctx.locationId,
      stockItemId: ctx.stockItemIds[0],
      quantity: "200.000",
      averageRate: "0.10",
      totalValue: "20.00",
    })
    .onConflictDoNothing();
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("POS sale totals", () => {
  it("totals the voucher and its legs from the lines at cents", async () => {
    const res = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 1.3, rate: 0.35 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });
    expect(res.status).toBeLessThan(300);
    const voucherId = Number(res.body?.voucher?.id ?? res.body?.voucherId ?? res.body?.id);

    const lines = await pool.query<{ total_sales: string }>(
      `SELECT total_sales FROM sales_items WHERE voucher_id = $1`,
      [voucherId]
    );
    expect(lines.rows.map((row) => row.total_sales)).toEqual(["0.46"]);

    const voucher = await pool.query<{ total_amount: string }>(`SELECT total_amount FROM vouchers WHERE id = $1`, [
      voucherId,
    ]);
    expect(voucher.rows[0].total_amount).toBe("0.46");

    const legs = await pool.query<{ debit: string; credit: string }>(
      `SELECT SUM(debit_amount)::text AS debit, SUM(credit_amount)::text AS credit FROM voucher_entries WHERE voucher_id = $1`,
      [voucherId]
    );
    expect(legs.rows[0]).toEqual({ debit: "0.46", credit: "0.46" });
  });
});
