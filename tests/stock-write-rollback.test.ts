/**
 * A stock write that fails partway leaves nothing behind.
 *
 * Transfers and adjustments touch several tables — the voucher, the document,
 * its items, inventory, and the canonical movement journal — and a half-applied
 * write is worse than a rejected one: stock has moved, the paperwork says it
 * did not, and nobody is looking for the difference.
 *
 * Each case here provokes a real failure in the middle of the write (a line
 * referencing a stock item that does not exist, which is what a concurrently
 * deleted item looks like from inside the transaction) and then reads every
 * table the operation touches.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, getInventoryQty, type TestContext } from "./setup";
import { pool } from "../server/db";

const TEST_PREFIX = "stkroll";
const MISSING_STOCK_ITEM_ID = 2147483000;

let ctx: TestContext;
let agent: request.SuperAgentTest;

async function countWhere(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0].count);
}

const voucherCount = () =>
  countWhere(`SELECT count(*)::int AS count FROM vouchers WHERE company_id = $1`, [ctx.companyId]);

const transferCount = () =>
  countWhere(
    `SELECT count(*)::int AS count FROM stock_transfer_vouchers stv
       JOIN vouchers v ON v.id = stv.voucher_id
      WHERE v.company_id = $1`,
    [ctx.companyId]
  );

const journalCount = () =>
  countWhere(`SELECT count(*)::int AS count FROM canonical_stock_movements WHERE company_id = $1`, [ctx.companyId]);

const journalRequestCount = () =>
  countWhere(`SELECT count(*)::int AS count FROM canonical_stock_movement_requests WHERE company_id = $1`, [
    ctx.companyId,
  ]);

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("stock writes roll back completely", () => {
  it("leaves no voucher, transfer, movement or stock change when a transfer line fails", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const before = {
      vouchers: await voucherCount(),
      transfers: await transferCount(),
      journal: await journalCount(),
      requests: await journalRequestCount(),
      sourceQuantity: await getInventoryQty(ctx.locationId, stockItemId),
      destinationQuantity: await getInventoryQty(ctx.location2Id, stockItemId),
    };

    const res = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [
        // The first line is entirely valid and is written before the second one
        // fails, so this is a genuine mid-write failure rather than a rejection
        // at the door.
        { stockItemId, quantity: "2", sourceLocationId: ctx.locationId },
        { stockItemId: MISSING_STOCK_ITEM_ID, quantity: "1", sourceLocationId: ctx.locationId },
      ],
      notes: "rollback probe",
      voucherDate: new Date().toISOString().split("T")[0],
      clientRequestId: `roll-transfer-${Date.now()}`,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);

    expect(await voucherCount()).toBe(before.vouchers);
    expect(await transferCount()).toBe(before.transfers);
    expect(await journalCount()).toBe(before.journal);
    // The journal's request rows are its idempotency record. A surviving
    // request row would make a later, legitimate retry look like a replay.
    expect(await journalRequestCount()).toBe(before.requests);
    expect(await getInventoryQty(ctx.locationId, stockItemId)).toBe(before.sourceQuantity);
    expect(await getInventoryQty(ctx.location2Id, stockItemId)).toBe(before.destinationQuantity);
  }, 60000);

  it("lets the same request id succeed after the failed attempt rolled back", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const clientRequestId = `roll-retry-${Date.now()}`;
    const sourceBefore = await getInventoryQty(ctx.locationId, stockItemId);

    const failed = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [{ stockItemId: MISSING_STOCK_ITEM_ID, quantity: "1", sourceLocationId: ctx.locationId }],
      notes: "rollback probe",
      voucherDate: new Date().toISOString().split("T")[0],
      clientRequestId,
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);

    const corrected = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [{ stockItemId, quantity: "2", sourceLocationId: ctx.locationId }],
      notes: "rollback probe",
      voucherDate: new Date().toISOString().split("T")[0],
      clientRequestId,
    });

    // The marker is written in the same transaction as the transfer, so a
    // rolled-back attempt cannot claim the key and lock the user out of
    // correcting and resubmitting.
    expect(corrected.status).toBe(201);
    expect(corrected.body.replayed).toBe(false);
    expect(await getInventoryQty(ctx.locationId, stockItemId)).toBe(sourceBefore - 2);
  }, 60000);

  it("removes the orphan voucher when an adjustment fails", async () => {
    const { rows } = await pool.query(
      `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, description, total_amount, optional)
       VALUES ($1, 'Stock Adjustment', $2, CURRENT_DATE, 'rollback probe', '0', false)
       RETURNING id`,
      [ctx.companyId, `ADJ-ROLL-${Date.now()}`]
    );
    const voucherId = Number(rows[0].id);
    const journalBefore = await journalCount();

    const res = await agent.post("/api/stock-adjustments").send({
      voucherId,
      locationId: ctx.locationId,
      adjustmentType: "Production",
      notes: "rollback probe",
      items: [{ stockItemId: MISSING_STOCK_ITEM_ID, quantity: "3", rate: "1.00" }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // The form creates the voucher first and the adjustment second, so a failed
    // adjustment must take its own empty voucher with it rather than leave a
    // shell in the Daybook. The voucher is retired (soft-deleted, wave 16 A), not erased.
    const survivors = await countWhere(
      `SELECT count(*)::int AS count FROM vouchers WHERE id = $1 AND deleted_at IS NULL`,
      [voucherId]
    );
    expect(survivors).toBe(0);
    expect(await journalCount()).toBe(journalBefore);
  }, 60000);
});
