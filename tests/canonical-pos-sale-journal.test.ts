/**
 * Canonical journal evidence for POS sales.
 *
 * A sale issues stock and an edit reverses the original quantities before
 * issuing the new ones. Both must appear in the append-only journal, because a
 * sale that moved stock without recording it is exactly the gap the
 * reconciliation exists to find. The edit case matters most: the journal must
 * gain the reversal and the reissue rather than rewriting what the sale
 * originally recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";

const TEST_PREFIX = "canonpos";

let ctx: TestContext;
let agent: request.SuperAgentTest;

async function saleJournalRows(sourceId: string) {
  const { rows } = await pool.query(
    `SELECT quantity_delta, unit_cost, movement_kind, location_id, stock_item_id, idempotency_key
       FROM canonical_stock_movements
      WHERE company_id = $1 AND source_type = 'pos-sale' AND source_id = $2
      ORDER BY id`,
    [ctx.companyId, sourceId]
  );
  return rows;
}

function voucherIdFrom(body: Record<string, unknown>): number {
  const candidate =
    (body?.voucher as { id?: unknown })?.id ?? body?.voucherId ?? (body?.sale as { id?: unknown })?.id ?? body?.id;
  return Number(candidate);
}

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
      averageRate: "10.00",
      totalValue: "2000.00",
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

describe("canonical journal for POS sales", () => {
  it("records an issue for the stock a sale takes out", async () => {
    const res = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 3, rate: 50 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const voucherId = voucherIdFrom(res.body);
    expect(Number.isInteger(voucherId)).toBe(true);

    const rows = await saleJournalRows(String(voucherId));
    expect(rows).toHaveLength(1);
    expect(rows[0].movement_kind).toBe("issue");
    // Stock left the selling location, at the cost the sale was costed at.
    expect(Number(rows[0].quantity_delta)).toBe(-3);
    expect(Number(rows[0].location_id)).toBe(ctx.locationId);
    expect(Number(rows[0].unit_cost)).toBeGreaterThan(0);
  }, 30000);

  it("records every duplicate stock-item line with a unique canonical key", async () => {
    const res = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [
        { stockItemId: ctx.stockItemIds[0], quantity: 2, rate: 50 },
        { stockItemId: ctx.stockItemIds[0], quantity: 3, rate: 50 },
      ],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const voucherId = voucherIdFrom(res.body);
    const rows = await saleJournalRows(String(voucherId));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => Number(row.quantity_delta))).toEqual([-2, -3]);
    expect(rows.reduce((sum, row) => sum + Number(row.quantity_delta), 0)).toBe(-5);

    const keys = new Set(rows.map((row) => row.idempotency_key));
    expect(keys.size).toBe(2);
    for (const key of keys) expect(String(key)).toContain(":line:");
  }, 30000);

  it("appends a reversal and a reissue when the sale is edited", async () => {
    const created = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 5, rate: 50 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });
    expect(created.status).toBeLessThan(300);
    const voucherId = voucherIdFrom(created.body);

    const afterCreate = await saleJournalRows(String(voucherId));
    expect(afterCreate).toHaveLength(1);
    expect(Number(afterCreate[0].quantity_delta)).toBe(-5);

    const edited = await agent.put(`/api/vouchers/${voucherId}/sales`).send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 2, sellingPrice: 50 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
    });
    expect(edited.status).toBe(200);

    const afterEdit = await saleJournalRows(String(voucherId));

    // Append-only: the original issue is still there, plus the reversal that
    // put the five back and the reissue of two.
    expect(afterEdit.length).toBe(3);
    expect(Number(afterEdit[0].quantity_delta)).toBe(-5);
    const reversal = afterEdit[1];
    const reissue = afterEdit[2];
    expect(reversal.movement_kind).toBe("receipt");
    expect(Number(reversal.quantity_delta)).toBe(5);
    expect(reissue.movement_kind).toBe("issue");
    expect(Number(reissue.quantity_delta)).toBe(-2);

    // Net effect across the journal equals the edited sale: two units gone.
    const net = afterEdit.reduce((sum, row) => sum + Number(row.quantity_delta), 0);
    expect(net).toBe(-2);

    // Every batch carries its own idempotency key, so no edit is mistaken for
    // a replay of an earlier one.
    const keys = new Set(afterEdit.map((row) => row.idempotency_key));
    expect(keys.size).toBe(afterEdit.length);
  }, 30000);
});
