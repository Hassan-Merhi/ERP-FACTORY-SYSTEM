/**
 * POST /api/stock-transfers prices each line at cents and totals the voucher
 * from those lines.
 *
 * 1.3 units at an average rate of 0.35 is 0.455. In floats that product is
 * 0.45499999999999996, so the line and the voucher were stored at 0.45; the
 * exact line is 0.46 and the voucher total now matches it.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { and, eq } from "drizzle-orm";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "xferexact";

let ctx: TestContext;
let agent: request.SuperAgentTest;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  await pool.query("DELETE FROM inventory_negative_layers WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("stock transfer create totals", () => {
  it("stores the line at exact cents and the voucher total as the sum of lines", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const values = { quantity: "100.000", averageRate: "0.35", totalValue: "35.00", lastUpdated: new Date() };
    const [existing] = await db
      .select({ id: schema.inventory.id })
      .from(schema.inventory)
      .where(and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, stockItemId)))
      .limit(1);
    if (existing) {
      await db.update(schema.inventory).set(values).where(eq(schema.inventory.id, existing.id));
    } else {
      await db
        .insert(schema.inventory)
        .values({ companyId: ctx.companyId, locationId: ctx.locationId, stockItemId, ...values });
    }

    const response = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      voucherDate: "2026-09-14",
      clientRequestId: `${TEST_PREFIX}-create`,
      items: [{ stockItemId, sourceLocationId: ctx.locationId, quantity: 1.3 }],
    });
    expect(response.status).toBe(201);

    const items = await pool.query<{ rate: string; total_amount: string }>(
      `SELECT rate, total_amount FROM stock_transfer_items WHERE transfer_id = $1`,
      [response.body.transfer.id]
    );
    expect(items.rows).toEqual([{ rate: "0.35", total_amount: "0.46" }]);

    const voucher = await pool.query<{ total_amount: string }>(`SELECT total_amount FROM vouchers WHERE id = $1`, [
      response.body.voucher.id,
    ]);
    expect(voucher.rows[0].total_amount).toBe("0.46");
  });
});
