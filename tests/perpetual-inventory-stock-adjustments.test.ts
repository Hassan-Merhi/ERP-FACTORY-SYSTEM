/**
 * Stock adjustments under perpetual inventory (wave 8.3).
 *
 * Once a company's cut-over is applied, a stock adjustment voucher carries the
 * inventory side of its posting: production Dr Inventory / Cr Stock
 * Adjustment, consumption Dr Stock Adjustment / Cr Inventory, for the value
 * the stock sub-ledger moved. An edit replaces the line, making the voucher
 * optional removes it and activating it posts it again. Before the cut-over,
 * and for vouchers dated before it, the voucher stays single-sided.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "piadj";
const today = new Date().toISOString().slice(0, 10);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;

async function voucherLines(voucherId: number) {
  const { rows } = await pool.query(
    `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
       FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE ve.voucher_id = $1 ORDER BY la.code, ve.id`,
    [voucherId]
  );
  return rows.map((row) => [row.code, row.d, row.c]);
}

async function adjust(
  adjustmentType: "Production" | "Consumption",
  quantity: number,
  rate: number,
  voucherDate = today
): Promise<number> {
  sequence += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherType: adjustmentType,
      voucherNumber: `${TEST_PREFIX.toUpperCase()}-${sequence}`,
      voucherDate,
      description: adjustmentType,
      totalAmount: "0",
      currency: "USD",
      optional: false,
      locationId: ctx.locationId,
    })
    .returning();
  const created = await agent.post("/api/stock-adjustments").send({
    voucherId: voucher.id,
    locationId: ctx.locationId,
    adjustmentType,
    notes: adjustmentType,
    items: [{ stockItemId: ctx.stockItemIds[0], quantity, rate }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return voucher.id;
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
      quantity: "100.000",
      averageRate: "10.00",
      totalValue: "1000.00",
    })
    .onConflictDoNothing();
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query("DELETE FROM inventory_negative_layers WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("stock adjustments under perpetual inventory", () => {
  it("stays single-sided before the company's cut-over is applied", async () => {
    const voucherId = await adjust("Production", 10, 20);
    expect(await voucherLines(voucherId)).toEqual([["STOCK_ADJUSTMENT", "0.00", "200.00"]]);
  }, 60_000);

  it("carries the inventory side once the cut-over applies, through edit and the optional flag", async () => {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [ctx.companyId, today]
    );

    const production = await adjust("Production", 10, 20);
    expect(await voucherLines(production)).toEqual([
      ["INVENTORY", "200.00", "0.00"],
      ["STOCK_ADJUSTMENT", "0.00", "200.00"],
    ]);

    // Edit: 5 at 30 replaces the line.
    const edited = await agent.patch(`/api/vouchers/${production}/adjustment`).send({
      voucherDate: today,
      description: "edited",
      locationId: ctx.locationId,
      adjustmentType: "Production",
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 5, rate: 30 }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(await voucherLines(production)).toEqual([
      ["INVENTORY", "150.00", "0.00"],
      ["STOCK_ADJUSTMENT", "0.00", "150.00"],
    ]);

    // Moving it before the cut-over leaves it single-sided again.
    const backdated = await agent.patch(`/api/vouchers/${production}/adjustment`).send({
      voucherDate: "2020-01-15",
      description: "edited",
      locationId: ctx.locationId,
      adjustmentType: "Production",
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 5, rate: 30 }],
    });
    expect(backdated.status, JSON.stringify(backdated.body)).toBe(200);
    expect(await voucherLines(production)).toEqual([["STOCK_ADJUSTMENT", "0.00", "150.00"]]);

    // Consumption is issued at the location's average cost.
    const consumption = await adjust("Consumption", 4, 0);
    const [[, , issued]] = (await voucherLines(consumption)).filter(([code]) => code === "INVENTORY");
    expect(await voucherLines(consumption)).toEqual([
      ["INVENTORY", "0.00", issued],
      ["STOCK_ADJUSTMENT", issued, "0.00"],
    ]);
    expect(Number(issued)).toBeGreaterThan(0);

    expect((await agent.patch(`/api/vouchers/${consumption}/optional`).send({ optional: true })).status).toBe(200);
    expect((await voucherLines(consumption)).filter(([code]) => code === "INVENTORY")).toEqual([]);
    expect((await agent.patch(`/api/vouchers/${consumption}/optional`).send({ optional: false })).status).toBe(200);
    const reactivated = await voucherLines(consumption);
    const stockAdjustment = reactivated.find(([code]) => code === "STOCK_ADJUSTMENT")!;
    expect(reactivated.find(([code]) => code === "INVENTORY")).toEqual(["INVENTORY", "0.00", stockAdjustment[1]]);
  }, 120_000);

  it("stays single-sided for a voucher dated before the cut-over", async () => {
    const voucherId = await adjust("Production", 1, 20, "2020-01-15");
    expect(await voucherLines(voucherId)).toEqual([["STOCK_ADJUSTMENT", "0.00", "20.00"]]);
  }, 60_000);
});
