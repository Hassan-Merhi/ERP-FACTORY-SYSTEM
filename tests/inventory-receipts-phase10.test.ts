import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p10recv";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;

async function setInventory(quantity: number, averageRate: number, totalValue: number): Promise<void> {
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

async function inventorySnapshot(stockItemId = ctx.stockItemIds[0]) {
  const result = await pool.query<{ quantity: string; average_rate: string; total_value: string }>(
    `SELECT quantity, average_rate, total_value
       FROM inventory
      WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, ctx.locationId, stockItemId]
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0];
}

async function movementRows(sourceType: string, stockItemId = ctx.stockItemIds[0]) {
  const result = await pool.query<{
    quantity_delta: string;
    unit_cost: string;
    movement_kind: string;
    location_id: number;
    source_id: string;
    idempotency_key: string;
  }>(
    `SELECT quantity_delta, unit_cost, movement_kind, location_id, source_id, idempotency_key
       FROM canonical_stock_movements
      WHERE company_id = $1 AND stock_item_id = $2 AND source_type = $3
      ORDER BY id`,
    [ctx.companyId, stockItemId, sourceType]
  );
  return result.rows;
}

async function createPurchaseContainer(quantity: number, rate: number): Promise<number> {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date)
     VALUES ($1, $2, $3, 'OTW', CURRENT_DATE)
     RETURNING id`,
    [ctx.companyId, `P10-CN-${suffix}`.slice(0, 30), supplierId]
  );
  const containerId = Number(container.rows[0].id);

  const po = await pool.query<{ id: number }>(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [ctx.companyId, `P10-PO-${suffix}`.slice(0, 30), containerId, supplierId]
  );

  await pool.query(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'Phase 10 purchase receipt', $3, $4, $5)`,
    [Number(po.rows[0].id), ctx.stockItemIds[0], quantity, rate, (quantity * rate).toFixed(2)]
  );

  return containerId;
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

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [ctx.companyId, "P10SUP", `${TEST_PREFIX}_supplier`, `${TEST_PREFIX}@example.test`]
  );
  supplierId = Number(supplier.rows[0].id);
}, 120_000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM factory_bale_production_attributions
      WHERE bale_id IN (SELECT id FROM factory_bales WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 10 inventory receive and stock-in", () => {
  it("records an ordinary stock-in with quantity, value, rate and canonical movement evidence", async () => {
    await setInventory(20, 5, 100);
    const beforeMovements = await movementRows("inventory_quick_adjustment");

    const response = await agent.post("/api/inventory/quick-adjust").send({
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: 5,
      type: "add",
    });

    expect(response.status).toBe(200);
    const inventory = await inventorySnapshot();
    expect(Number(inventory.quantity)).toBeCloseTo(25, 3);
    expect(Number(inventory.average_rate)).toBeCloseTo(5, 2);
    expect(Number(inventory.total_value)).toBeCloseTo(125, 2);

    const movements = await movementRows("inventory_quick_adjustment");
    const written = movements.slice(beforeMovements.length);
    expect(written).toHaveLength(1);
    expect(written[0].movement_kind).toBe("adjustment");
    expect(Number(written[0].quantity_delta)).toBeCloseTo(5, 3);
    expect(Number(written[0].unit_cost)).toBeCloseTo(5, 2);
    expect(Number(written[0].location_id)).toBe(ctx.locationId);
  }, 60_000);

  it("offloads a purchase receipt into weighted-average inventory with matching movement value", async () => {
    await setInventory(20, 5, 100);
    const containerId = await createPurchaseContainer(10, 7);

    const response = await agent.post(`/api/containers/${containerId}/offload`).send({
      locationId: ctx.locationId,
      offloadDate: "2026-09-14",
      duties: "0",
      officeCharges: "0",
      transferCharges: "0",
      transportFees: "0",
    });

    expect(response.status).toBe(200);
    const offloadId = Number(response.body.id);
    expect(Number.isInteger(offloadId) && offloadId > 0).toBe(true);

    const inventory = await inventorySnapshot();
    expect(Number(inventory.quantity)).toBeCloseTo(30, 3);
    expect(Number(inventory.total_value)).toBeCloseTo(170, 2);
    expect(Number(inventory.average_rate)).toBeCloseTo(170 / 30, 2);

    const offloadLine = await pool.query<{ quantity: string; rate: string; total_value: string }>(
      `SELECT quantity, rate, total_value
         FROM container_offload_items
        WHERE offload_id = $1 AND stock_item_id = $2`,
      [offloadId, ctx.stockItemIds[0]]
    );
    expect(offloadLine.rowCount).toBe(1);
    expect(Number(offloadLine.rows[0].quantity)).toBeCloseTo(10, 3);
    expect(Number(offloadLine.rows[0].rate)).toBeCloseTo(7, 2);
    expect(Number(offloadLine.rows[0].total_value)).toBeCloseTo(70, 2);

    const movement = await pool.query<{ quantity_delta: string; unit_cost: string; movement_kind: string }>(
      `SELECT quantity_delta, unit_cost, movement_kind
         FROM canonical_stock_movements
        WHERE company_id = $1
          AND source_type = 'container-offload'
          AND source_id = $2
          AND stock_item_id = $3`,
      [ctx.companyId, String(offloadId), ctx.stockItemIds[0]]
    );
    expect(movement.rowCount).toBe(1);
    expect(movement.rows[0].movement_kind).toBe("receipt");
    expect(Number(movement.rows[0].quantity_delta)).toBeCloseTo(10, 3);
    expect(Number(movement.rows[0].unit_cost)).toBeCloseTo(7, 2);
    expect(Number(movement.rows[0].quantity_delta) * Number(movement.rows[0].unit_cost)).toBeCloseTo(70, 2);
  }, 60_000);

  it("factory stock entry updates ERP quantity and weighted value and writes one receipt per batch item", async () => {
    await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
    expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

    const stockItem = await pool.query<{ code: string }>(`SELECT code FROM stock_items WHERE id = $1`, [ctx.stockItemIds[0]]);
    const product = await pool.query<{ id: number }>(
      `INSERT INTO factory_bale_products (company_id, code, name, article_code, production_price)
       VALUES ($1, $2, $3, $4, '4.00')
       RETURNING id`,
      [ctx.companyId, "P10FACT", "Phase 10 factory product", stockItem.rows[0].code]
    );
    const productId = Number(product.rows[0].id);

    await setInventory(2, 50, 100);
    const first = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.locationId,
      entryDate: "2026-09-14",
      items: [{ productId, quantity: 2, weightPerBale: "25" }],
    });
    expect(first.status).toBe(200);

    let inventory = await inventorySnapshot();
    expect(Number(inventory.quantity)).toBeCloseTo(4, 3);
    expect(Number(inventory.total_value)).toBeCloseTo(300, 2);
    expect(Number(inventory.average_rate)).toBeCloseTo(75, 2);

    await pool.query(`UPDATE factory_bale_products SET production_price = '6.00' WHERE id = $1`, [productId]);
    const second = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.locationId,
      entryDate: "2026-09-14",
      items: [{ productId, quantity: 2, weightPerBale: "25" }],
    });
    expect(second.status).toBe(200);

    inventory = await inventorySnapshot();
    expect(Number(inventory.quantity)).toBeCloseTo(6, 3);
    expect(Number(inventory.total_value)).toBeCloseTo(600, 2);
    expect(Number(inventory.average_rate)).toBeCloseTo(100, 2);

    const movements = await movementRows("factory-stock-entry");
    expect(movements).toHaveLength(2);
    expect(movements.map((row) => row.movement_kind)).toEqual(["receipt", "receipt"]);
    expect(movements.map((row) => Number(row.quantity_delta))).toEqual([2, 2]);
    expect(Number(movements[0].unit_cost)).toBeCloseTo(100, 2);
    expect(Number(movements[1].unit_cost)).toBeCloseTo(150, 2);
    expect(new Set(movements.map((row) => row.idempotency_key)).size).toBe(2);
  }, 60_000);
});
