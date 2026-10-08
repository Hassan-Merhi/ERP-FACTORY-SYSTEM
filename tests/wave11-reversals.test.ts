/**
 * Wave 11 ("inventory fidelity"), agent B: value-exact reversals.
 *
 * Every new stock line records value_moved (what the sub-ledger moved), and a
 * reversal moves exactly that back:
 *   - a sale relieved at a true rate with three decimals (3 units holding
 *     10.00) comes back as 10.00, not 3 × the 2dp cost price (9.99);
 *   - a short sale comes back with the value it relieved;
 *   - deleting a stock adjustment, a transfer or a credit note, suspending a
 *     sale and editing a POS sale restore exactly value_moved, and the ledger's
 *     Inventory still equals the sub-ledger change (no residual journal);
 *   - a legacy sale line (value_moved NULL) falls back to its COGS journal;
 *   - inline edits of lines of posted stock documents are refused;
 *   - a location that holds stock cannot be deactivated.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { reverseOriginalSaleInventory } from "../server/services/pos/edit/reverseOriginalSaleInventory";
import { LocationHoldsStockError, updateLocation } from "../server/storage/inventory/locationInventoryStorage";
import { createStockAdjustment, createStockTransfer } from "../server/storage/stock-ops/transfers-create";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w11rv";
const today = new Date().toISOString().slice(0, 10);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;

async function newItem(): Promise<number> {
  sequence += 1;
  const code = `${TEST_PREFIX}-X${sequence}`;
  const [item] = await db
    .insert(schema.stockItems)
    .values({ companyId: ctx.companyId, code, name: code, uom: "PCS", stockGroupId: ctx.stockGroupId, active: true })
    .returning();
  return item.id;
}

async function setStock(locationId: number, stockItemId: number, quantity: string, rate: string, value: string) {
  await pool.query(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (location_id, stock_item_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, average_rate = EXCLUDED.average_rate, total_value = EXCLUDED.total_value`,
    [ctx.companyId, locationId, stockItemId, quantity, rate, value]
  );
}

async function stock(locationId: number, stockItemId: number) {
  const { rows } = await pool.query(
    `SELECT quantity::numeric::text AS q, total_value::text AS v FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
    [locationId, stockItemId]
  );
  return { quantity: Number(rows[0]?.q ?? 0), value: rows[0]?.v ?? "0.00" };
}

async function residualJournals() {
  const { rows } = await pool.query(
    `SELECT voucher_number FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL`,
    [ctx.companyId, `INV-MOVE-${ctx.companyId}-%`]
  );
  return rows.map((row) => row.voucher_number as string);
}

async function cogsJournal(saleVoucherId: number) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(ve.credit_amount), 0)::numeric(20,2)::text AS v
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.voucher_number = $2 AND la.code = 'INVENTORY'`,
    [ctx.companyId, `COGS-${saleVoucherId}`]
  );
  return rows[0].v as string;
}

async function sell(stockItemId: number, quantity: number): Promise<number> {
  const response = await agent.post("/api/pos/sales").send({
    locationId: ctx.locationId,
    items: [{ stockItemId, quantity, rate: 20 }],
    paymentAccountType: "ledger",
    paymentAccountId: ctx.cashAccountId,
    voucherDate: today,
  });
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  const { rows } = await pool.query(
    `SELECT voucher_id FROM sales_items WHERE stock_item_id = $1 ORDER BY id DESC LIMIT 1`,
    [stockItemId]
  );
  return rows[0].voucher_id as number;
}

async function voucher(voucherType: string, locationId = ctx.locationId): Promise<number> {
  sequence += 1;
  const [row] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherType,
      voucherNumber: `${TEST_PREFIX.toUpperCase()}-V${sequence}`,
      voucherDate: today,
      description: voucherType,
      totalAmount: "0",
      currency: "USD",
      optional: false,
      locationId,
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await pool.query(
    `UPDATE user_company_roles SET can_sell_negative_stock = true WHERE user_id = $1 AND company_id = $2`,
    [ctx.userId, ctx.companyId]
  );
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  await pool.query(
    `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, $2, '{}'::jsonb, 'test')`,
    [ctx.companyId, today]
  );
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [id]);
  await pool.query(
    `DELETE FROM accounting_posting_requests WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
    [id]
  );
  await pool.query(
    `DELETE FROM credit_note_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
    [id]
  );
  await pool.query(
    `DELETE FROM stock_adjustment_items WHERE adjustment_id IN (SELECT sav.id FROM stock_adjustment_vouchers sav JOIN vouchers v ON v.id = sav.voucher_id WHERE v.company_id = $1)`,
    [id]
  );
  await pool.query(
    `DELETE FROM stock_adjustment_vouchers WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
    [id]
  );
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [id]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

describe("value-exact reversals", () => {
  it("records a sale's relieved value and restores exactly it on delete (3dp true rate)", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item, "3", "3.3333333", "10.00");
    const saleId = await sell(item, 3);
    const { rows } = await pool.query(
      `SELECT value_moved::text AS v, cost_price::text AS c FROM sales_items WHERE voucher_id = $1`,
      [saleId]
    );
    expect(rows[0].v).toBe("10.00");
    // The 2dp display rate would have put back 9.99.
    expect(Number(rows[0].c) * 3).not.toBe(10);
    expect(await cogsJournal(saleId)).toBe("10.00");

    const deleted = await agent.delete(`/api/vouchers/${saleId}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await stock(ctx.locationId, item)).toEqual({ quantity: 3, value: "10.00" });
    expect(await cogsJournal(saleId)).toBe("0.00");
    expect(await residualJournals()).toEqual([]);
  }, 60_000);

  it("restores a short sale with the value it relieved", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item, "2", "10", "20.00");
    const saleId = await sell(item, 5);
    const { rows } = await pool.query(`SELECT value_moved::text AS v FROM sales_items WHERE voucher_id = $1`, [saleId]);
    const relieved = rows[0].v as string;
    expect(Number(relieved)).toBeGreaterThanOrEqual(20);
    expect(await cogsJournal(saleId)).toBe(relieved);
    expect((await stock(ctx.locationId, item)).quantity).toBe(-3);

    expect((await agent.delete(`/api/vouchers/${saleId}`)).status).toBe(200);
    expect(await stock(ctx.locationId, item)).toEqual({ quantity: 2, value: "20.00" });
    expect(await residualJournals()).toEqual([]);
  }, 60_000);

  it("suspends a sale (optional) exactly and re-relieves it on activation", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item, "3", "3.3333333", "10.00");
    const saleId = await sell(item, 1);
    const [{ v: relieved }] = (
      await pool.query(`SELECT value_moved::text AS v FROM sales_items WHERE voucher_id = $1`, [saleId])
    ).rows;
    const suspended = await agent.patch(`/api/vouchers/${saleId}/optional`).send({ optional: true });
    expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
    expect(await stock(ctx.locationId, item)).toEqual({ quantity: 3, value: "10.00" });
    expect(await cogsJournal(saleId)).toBe("0.00");

    const activated = await agent.patch(`/api/vouchers/${saleId}/optional`).send({ optional: false });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    const [{ v: again }] = (
      await pool.query(`SELECT value_moved::text AS v FROM sales_items WHERE voucher_id = $1`, [saleId])
    ).rows;
    expect(again).toBe(relieved);
    expect(await cogsJournal(saleId)).toBe(relieved);
    expect(await residualJournals()).toEqual([]);
  }, 60_000);

  it("restores a POS edit's old lines exactly and falls back to the COGS journal for a legacy line", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item, "3", "3.3333333", "10.00");
    const saleId = await sell(item, 3);
    const [line] = (await pool.query(`SELECT * FROM sales_items WHERE voucher_id = $1`, [saleId])).rows;
    // A legacy line: no value_moved, and a 2dp cost price that would restore 9.99.
    await pool.query(`UPDATE sales_items SET value_moved = NULL WHERE id = $1`, [line.id]);
    await db.transaction((tx) =>
      reverseOriginalSaleInventory(tx, { id: saleId, companyId: ctx.companyId, locationId: ctx.locationId }, [
        {
          id: line.id,
          stockItemId: item,
          quantity: line.quantity,
          costPrice: line.cost_price,
          totalCost: line.total_cost,
          valueMoved: null,
        },
      ])
    );
    expect(await stock(ctx.locationId, item)).toEqual({ quantity: 3, value: "10.00" });
  }, 60_000);

  it("deletes a stock adjustment by restoring exactly value_moved", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item, "3", "3.3333333", "10.00");
    const voucherId = await voucher("Consumption");
    await createStockAdjustment(voucherId, ctx.locationId, "Consumption", "w11", [
      { stockItemId: item, quantity: "3", rate: "3.33" },
    ]);
    const [{ v }] = (
      await pool.query(
        `SELECT sai.value_moved::text AS v FROM stock_adjustment_items sai JOIN stock_adjustment_vouchers sav ON sav.id = sai.adjustment_id WHERE sav.voucher_id = $1`,
        [voucherId]
      )
    ).rows;
    expect(v).toBe("10.00");
    expect((await agent.delete(`/api/vouchers/${voucherId}`)).status).toBe(200);
    expect(await stock(ctx.locationId, item)).toEqual({ quantity: 3, value: "10.00" });
    expect(await residualJournals()).toEqual([]);
  }, 60_000);

  it("deletes a transfer by moving exactly value_moved back", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item, "3", "3.3333333", "10.00");
    await setStock(ctx.location2Id, item, "1", "7", "7.00");
    const voucherId = await voucher("Stock Transfer");
    await createStockTransfer(
      voucherId,
      ctx.location2Id,
      "w11",
      [{ sourceLocationId: ctx.locationId, stockItemId: item, quantity: "3", rate: "3.33" }],
      { activeCompanyId: ctx.companyId }
    );
    expect(await stock(ctx.location2Id, item)).toEqual({ quantity: 4, value: "17.00" });
    expect((await agent.delete(`/api/vouchers/${voucherId}`)).status).toBe(200);
    expect(await stock(ctx.locationId, item)).toEqual({ quantity: 3, value: "10.00" });
    expect(await stock(ctx.location2Id, item)).toEqual({ quantity: 1, value: "7.00" });
    expect(await residualJournals()).toEqual([]);
  }, 60_000);

  it("deletes a credit note by taking back exactly value_moved", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item, "3", "3.3333333", "10.00");
    const note = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: today,
      cashAccountId: ctx.cashAccountId,
      cashAccountType: "ledger",
      items: [{ stockItemId: item, locationId: ctx.locationId, quantity: 2, refundRate: 6, inventoryCost: 4.005 }],
    });
    expect(note.status, JSON.stringify(note.body)).toBe(200);
    const [{ v }] = (
      await pool.query(`SELECT value_moved::text AS v FROM credit_note_items WHERE voucher_id = $1`, [
        note.body.voucherId,
      ])
    ).rows;
    expect(Number((await stock(ctx.locationId, item)).value) - 10).toBeCloseTo(Number(v), 6);
    expect((await agent.delete(`/api/vouchers/${note.body.voucherId}`)).status).toBe(200);
    expect(await stock(ctx.locationId, item)).toEqual({ quantity: 3, value: "10.00" });
    expect(await residualJournals()).toEqual([]);
  }, 60_000);
});

describe("frozen inline edits and location guard", () => {
  it("refuses inline edits of a posted transfer's or adjustment's lines", async () => {
    const item = await newItem();
    await setStock(ctx.locationId, item, "10", "2", "20.00");
    const transferVoucher = await voucher("Stock Transfer");
    const { items } = await createStockTransfer(
      transferVoucher,
      ctx.location2Id,
      "w11",
      [{ sourceLocationId: ctx.locationId, stockItemId: item, quantity: "1", rate: "2" }],
      { activeCompanyId: ctx.companyId }
    );
    const transferEdit = await agent.patch(`/api/stock-transfer-items/${items[0].id}`).send({ quantity: "5" });
    expect(transferEdit.status).toBe(409);

    const adjustmentVoucher = await voucher("Production");
    const { items: adjustmentItems } = await createStockAdjustment(
      adjustmentVoucher,
      ctx.locationId,
      "Production",
      "w11",
      [{ stockItemId: item, quantity: "1", rate: "2" }]
    );
    const adjustmentEdit = await agent
      .patch(`/api/stock-adjustment-items/${adjustmentItems[0].id}`)
      .send({ quantity: "5" });
    expect(adjustmentEdit.status).toBe(409);
    const { rows } = await pool.query(`SELECT quantity::numeric::text AS q FROM stock_adjustment_items WHERE id = $1`, [
      adjustmentItems[0].id,
    ]);
    expect(Number(rows[0].q)).toBe(1);
  }, 60_000);

  it("refuses to deactivate a location that holds stock", async () => {
    await expect(updateLocation(ctx.locationId, { active: false })).rejects.toBeInstanceOf(LocationHoldsStockError);
  });
});
