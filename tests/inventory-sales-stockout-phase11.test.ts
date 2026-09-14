import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p11sale";
let ctx: TestContext;
let agent: request.SuperAgentTest;

async function setInventory(quantity: number, averageRate: number, totalValue: number): Promise<void> {
  await pool.query(
    `DELETE FROM inventory_negative_layers
      WHERE location_id = $1 AND stock_item_id = $2`,
    [ctx.locationId, ctx.stockItemIds[0]]
  );
  await pool.query(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (location_id, stock_item_id)
     DO UPDATE SET quantity = EXCLUDED.quantity,
                   average_rate = EXCLUDED.average_rate,
                   total_value = EXCLUDED.total_value`,
    [ctx.companyId, ctx.locationId, ctx.stockItemIds[0], quantity, averageRate, totalValue]
  );
}

async function inventorySnapshot() {
  const result = await pool.query<{ quantity: string; average_rate: string; total_value: string }>(
    `SELECT quantity, average_rate, total_value
       FROM inventory
      WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0];
}

async function switchRole(role: "Admin" | "POS" | "Normal User"): Promise<void> {
  await pool.query(
    `UPDATE user_company_roles
        SET role = $1,
            assigned_location_id = $2,
            cash_account_id = $3,
            can_sell_negative_stock = false
      WHERE user_id = $4 AND company_id = $5`,
    [role, ctx.locationId, ctx.cashAccountId, ctx.userId, ctx.companyId]
  );
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);
}

async function sale(voucherSuffix: string, quantity: number, rate: number) {
  return agent.post("/api/pos/sales").send({
    locationId: ctx.locationId,
    items: [{ stockItemId: ctx.stockItemIds[0], quantity, rate }],
    paymentAccountType: "ledger",
    paymentAccountId: ctx.cashAccountId,
    voucherDate: "2026-09-14",
    clientSaleId: `${TEST_PREFIX}-${voucherSuffix}-${Date.now()}-${Math.random()}`,
  });
}

async function assertSaleEconomics(voucherId: number, quantity: number, sellingRate: number, costRate: number) {
  const item = await pool.query<{
    quantity: string;
    selling_price: string;
    cost_price: string;
    total_sales: string;
    total_cost: string;
    profit: string;
  }>(
    `SELECT quantity, selling_price, cost_price, total_sales, total_cost, profit
       FROM sales_items
      WHERE voucher_id = $1 AND stock_item_id = $2`,
    [voucherId, ctx.stockItemIds[0]]
  );
  expect(item.rowCount).toBe(1);
  expect(Number(item.rows[0].quantity)).toBeCloseTo(quantity, 3);
  expect(Number(item.rows[0].selling_price)).toBeCloseTo(sellingRate, 2);
  expect(Number(item.rows[0].cost_price)).toBeCloseTo(costRate, 2);
  expect(Number(item.rows[0].total_sales)).toBeCloseTo(quantity * sellingRate, 2);
  expect(Number(item.rows[0].total_cost)).toBeCloseTo(quantity * costRate, 2);
  expect(Number(item.rows[0].profit)).toBeCloseTo(quantity * (sellingRate - costRate), 2);

  const entries = await pool.query<{ debit_amount: string; credit_amount: string }>(
    `SELECT debit_amount, credit_amount
       FROM voucher_entries
      WHERE voucher_id = $1`,
    [voucherId]
  );
  expect(entries.rowCount).toBe(2);
  const debit = entries.rows.reduce((sum, row) => sum + Number(row.debit_amount || 0), 0);
  const credit = entries.rows.reduce((sum, row) => sum + Number(row.credit_amount || 0), 0);
  expect(debit).toBeCloseTo(quantity * sellingRate, 2);
  expect(credit).toBeCloseTo(debit, 2);

  const movement = await pool.query<{ quantity_delta: string; unit_cost: string; movement_kind: string }>(
    `SELECT quantity_delta, unit_cost, movement_kind
       FROM canonical_stock_movements
      WHERE company_id = $1
        AND source_type = 'pos-sale'
        AND source_id = $2
        AND stock_item_id = $3`,
    [ctx.companyId, String(voucherId), ctx.stockItemIds[0]]
  );
  expect(movement.rowCount).toBe(1);
  expect(movement.rows[0].movement_kind).toBe("issue");
  expect(Number(movement.rows[0].quantity_delta)).toBeCloseTo(-quantity, 3);
  expect(Number(movement.rows[0].unit_cost)).toBeCloseTo(costRate, 2);
  expect(Math.abs(Number(movement.rows[0].quantity_delta) * Number(movement.rows[0].unit_cost))).toBeCloseTo(
    quantity * costRate,
    2
  );
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  await pool.query(
    `INSERT INTO user_locations (user_id, company_id, location_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [ctx.userId, ctx.companyId, ctx.locationId]
  );
  await pool.query(
    `INSERT INTO user_location_cash_accounts (user_id, company_id, location_id, cash_account_id, pos_station)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (user_id, company_id, location_id)
     DO UPDATE SET cash_account_id = EXCLUDED.cash_account_id, pos_station = EXCLUDED.pos_station`,
    [ctx.userId, ctx.companyId, ctx.locationId, ctx.cashAccountId]
  );
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM user_location_cash_accounts WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM inventory_negative_layers WHERE location_id IN ($1, $2)`, [ctx.locationId, ctx.location2Id]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 11 inventory sale and stock-out", () => {
  it("covers a real POS-role sale across COGS, inventory, canonical movement and accounting", async () => {
    await switchRole("POS");
    await setInventory(10, 8, 80);

    const response = await sale("pos", 3, 20);
    expect(response.status).toBe(200);
    const voucherId = Number(response.body.voucher.id);

    const inventory = await inventorySnapshot();
    expect(Number(inventory.quantity)).toBeCloseTo(7, 3);
    expect(Number(inventory.average_rate)).toBeCloseTo(8, 2);
    expect(Number(inventory.total_value)).toBeCloseTo(56, 2);
    await assertSaleEconomics(voucherId, 3, 20, 8);
  }, 60_000);

  it("covers an admin/manual sale through the same canonical sale service", async () => {
    await switchRole("Admin");
    await setInventory(12, 7, 84);

    const response = await sale("manual", 2, 15);
    expect(response.status).toBe(200);
    const voucherId = Number(response.body.voucher.id);

    const inventory = await inventorySnapshot();
    expect(Number(inventory.quantity)).toBeCloseTo(10, 3);
    expect(Number(inventory.total_value)).toBeCloseTo(70, 2);
    expect(Number(inventory.average_rate)).toBeCloseTo(7, 2);
    await assertSaleEconomics(voucherId, 2, 15, 7);
  }, 60_000);

  it("rejects insufficient stock when negative selling is not permitted and leaves every layer unchanged", async () => {
    await switchRole("Normal User");
    await setInventory(2, 9, 18);

    const beforeVouchers = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM vouchers WHERE company_id = $1 AND voucher_type = 'Sales'`,
      [ctx.companyId]
    );
    const beforeMovements = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM canonical_stock_movements
        WHERE company_id = $1 AND source_type = 'pos-sale'`,
      [ctx.companyId]
    );

    const response = await sale("insufficient", 3, 20);
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/stock/i);

    const inventory = await inventorySnapshot();
    expect(Number(inventory.quantity)).toBeCloseTo(2, 3);
    expect(Number(inventory.total_value)).toBeCloseTo(18, 2);

    const afterVouchers = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM vouchers WHERE company_id = $1 AND voucher_type = 'Sales'`,
      [ctx.companyId]
    );
    const afterMovements = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM canonical_stock_movements
        WHERE company_id = $1 AND source_type = 'pos-sale'`,
      [ctx.companyId]
    );
    expect(Number(afterVouchers.rows[0].count)).toBe(Number(beforeVouchers.rows[0].count));
    expect(Number(afterMovements.rows[0].count)).toBe(Number(beforeMovements.rows[0].count));
  }, 60_000);

  it("permits configured negative stock while keeping COGS, cost memory and accounting consistent", async () => {
    await switchRole("Admin");
    await setInventory(2, 9, 18);

    const response = await sale("negative", 5, 20);
    expect(response.status).toBe(200);
    const voucherId = Number(response.body.voucher.id);

    const inventory = await inventorySnapshot();
    expect(Number(inventory.quantity)).toBeCloseTo(-3, 3);
    expect(Number(inventory.total_value)).toBeCloseTo(0, 2);
    expect(Number(inventory.average_rate)).toBeCloseTo(9, 2);

    const layer = await pool.query<{ qty: string; provisional_rate: string }>(
      `SELECT qty, provisional_rate
         FROM inventory_negative_layers
        WHERE location_id = $1 AND stock_item_id = $2
        ORDER BY id DESC
        LIMIT 1`,
      [ctx.locationId, ctx.stockItemIds[0]]
    );
    expect(layer.rowCount).toBe(1);
    expect(Number(layer.rows[0].qty)).toBeCloseTo(3, 3);
    expect(Number(layer.rows[0].provisional_rate)).toBeCloseTo(9, 2);
    await assertSaleEconomics(voucherId, 5, 20, 9);
  }, 60_000);

  it("covers ordinary manual stock-out without changing the surviving weighted cost", async () => {
    await switchRole("Admin");
    await setInventory(10, 6, 60);

    const before = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM canonical_stock_movements
        WHERE company_id = $1
          AND stock_item_id = $2
          AND source_type = 'inventory_quick_adjustment'`,
      [ctx.companyId, ctx.stockItemIds[0]]
    );
    const response = await agent.post("/api/inventory/quick-adjust").send({
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: 4,
      type: "subtract",
    });
    expect(response.status).toBe(200);

    const inventory = await inventorySnapshot();
    expect(Number(inventory.quantity)).toBeCloseTo(6, 3);
    expect(Number(inventory.total_value)).toBeCloseTo(36, 2);
    expect(Number(inventory.average_rate)).toBeCloseTo(6, 2);

    const movements = await pool.query<{ quantity_delta: string; unit_cost: string; movement_kind: string }>(
      `SELECT quantity_delta, unit_cost, movement_kind
         FROM canonical_stock_movements
        WHERE company_id = $1
          AND stock_item_id = $2
          AND source_type = 'inventory_quick_adjustment'
        ORDER BY id`,
      [ctx.companyId, ctx.stockItemIds[0]]
    );
    const written = movements.rows.slice(Number(before.rows[0].count));
    expect(written).toHaveLength(1);
    expect(written[0].movement_kind).toBe("adjustment");
    expect(Number(written[0].quantity_delta)).toBeCloseTo(-4, 3);
    expect(Number(written[0].unit_cost)).toBeCloseTo(6, 2);
  }, 60_000);
});
