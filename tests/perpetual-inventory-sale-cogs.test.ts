/**
 * Cost of goods sold for ERP sales under perpetual inventory (wave 8.1).
 *
 * Once a company's cut-over is applied, every POS sale posts a linked journal
 * COGS-{saleVoucherId}: Dr COGS / Cr Inventory for the exact value the stock
 * sub-ledger relieved. An edit replaces it, making the sale optional removes
 * it and activating it again re-posts it, and deleting the sale deletes it.
 * Before the cut-over, and for documents dated before it, nothing is posted.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../shared/schema";
import { db, pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "picogs";
const today = new Date().toISOString().slice(0, 10);

let ctx: TestContext;
let agent: request.SuperAgentTest;

async function cogsLines(saleVoucherId: number) {
  const { rows } = await pool.query(
    `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c, v.optional
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.voucher_number = $2 ORDER BY ve.id`,
    [ctx.companyId, `COGS-${saleVoucherId}`]
  );
  return rows.map((row) => [row.code, row.d, row.c]);
}

async function sell(quantity: number, voucherDate = today) {
  const res = await agent.post("/api/pos/sales").send({
    locationId: ctx.locationId,
    items: [{ stockItemId: ctx.stockItemIds[0], quantity, rate: 50 }],
    paymentAccountType: "ledger",
    paymentAccountId: ctx.cashAccountId,
    voucherDate,
  });
  expect(res.status).toBeLessThan(300);
  return Number(res.body?.voucher?.id ?? res.body?.voucherId ?? res.body?.id);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
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
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'COGS-%')`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'COGS-%'`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("sale COGS under perpetual inventory", () => {
  it("posts nothing before the company's cut-over is applied", async () => {
    const saleId = await sell(1);
    expect(await cogsLines(saleId)).toEqual([]);
  }, 30000);

  it("posts the exact relieved value, replaces it on edit, follows the optional flag and goes with the sale", async () => {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [ctx.companyId, today]
    );

    const saleId = await sell(3);
    expect(await cogsLines(saleId)).toEqual([
      ["COGS", "30.00", "0.00"],
      ["INVENTORY", "0.00", "30.00"],
    ]);

    const edited = await agent.put(`/api/vouchers/${saleId}/sales`).send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 2, sellingPrice: 50 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
    });
    expect(edited.status).toBe(200);
    expect(await cogsLines(saleId)).toEqual([
      ["COGS", "20.00", "0.00"],
      ["INVENTORY", "0.00", "20.00"],
    ]);

    expect((await agent.patch(`/api/vouchers/${saleId}/optional`).send({ optional: true })).status).toBe(200);
    expect(await cogsLines(saleId)).toEqual([]);
    expect((await agent.patch(`/api/vouchers/${saleId}/optional`).send({ optional: false })).status).toBe(200);
    expect(await cogsLines(saleId)).toEqual([
      ["COGS", "20.00", "0.00"],
      ["INVENTORY", "0.00", "20.00"],
    ]);

    expect((await agent.delete(`/api/vouchers/${saleId}`)).status).toBeLessThan(300);
    expect(await cogsLines(saleId)).toEqual([]);
  }, 60000);

  it("posts nothing for a sale dated before the cut-over", async () => {
    const saleId = await sell(1, "2020-01-15");
    expect(await cogsLines(saleId)).toEqual([]);
  }, 30000);
});
