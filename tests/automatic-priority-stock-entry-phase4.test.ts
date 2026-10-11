/**
 * Phase 4: Stock Entry -> authoritative Priority Scan allocation.
 *
 * Authored for Claude's later review. Do not run as part of this phase.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { ensurePriorityScanSchema } from "../server/startup/priorityScanSchema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "autostk4";
const MODE = "/api/factory/automatic-priority-mode";
const STOCK = "/api/factory/stock-entry";
const HISTORY = "/api/factory/customer-orders/loading-list/priority-allocation-history";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let matchingProductId: number;
let unmatchedProductId: number;
let redOrderId: number;
let blueOrderId: number;
const articleCode = "AUTOSTK4-JOGGER";
const noMatchArticle = "AUTOSTK4-OTHER";

async function addLoading(priority: number, color: string, price: string) {
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, (SELECT id FROM customers WHERE code = $2 AND company_id = $1),
       $3, TRUE) RETURNING id`,
    [ctx.companyId, `${PREFIX}-CUSTOMER`, `${PREFIX}-proforma-${priority}`]
  );
  const proformaId = proforma.rows[0].id;
  await pool.query(
    `INSERT INTO customer_proforma_lines
      (proforma_id, article_code, product_name, quantity, price_per_bale, pricing_mode)
     VALUES ($1, $2, 'Adult Jogger Pant', 2, $3, 'per_bale')`,
    [proformaId, articleCode, price]
  );
  const loading = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders
      (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, (SELECT id FROM customers WHERE code = $2 AND company_id = $1),
       CURRENT_DATE, 'LOADING', $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-CUSTOMER`, proformaId]
  );
  const orderId = loading.rows[0].id;
  const config = await agent
    .put(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`)
    .send({ priority, color, enabled: true });
  expect(config.status).toBe(200);
  return orderId;
}

async function createStock(productId: number, qty: number) {
  return agent.post(STOCK).send({
    erpLocationId: ctx.locationId,
    items: [{ productId, quantity: qty, weightPerBale: "25" }],
    entryDate: new Date().toISOString().slice(0, 10),
  });
}

async function countRows(table: "factory_priority_auto_allocations" | "factory_priority_scan_history") {
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE company_id = $1`,
    [ctx.companyId]
  );
  return Number(res.rows[0].count);
}

beforeAll(async () => {
  await ensurePriorityScanSchema(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);

  await pool.query("INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3)", [
    ctx.companyId,
    `${PREFIX}-CUSTOMER`,
    "Automatic Priority Customer",
  ]);
  const matching = await pool.query<{ id: number }>(
    `INSERT INTO factory_bale_products
      (company_id, code, name, article_code, production_price, selling_price)
     VALUES ($1, 'ASTK4J', 'Adult Jogger Pant', $2, '4', '19') RETURNING id`,
    [ctx.companyId, articleCode]
  );
  matchingProductId = matching.rows[0].id;
  const other = await pool.query<{ id: number }>(
    `INSERT INTO factory_bale_products
      (company_id, code, name, article_code, production_price, selling_price)
     VALUES ($1, 'ASTK4O', 'Other Item', $2, '4', '19') RETURNING id`,
    [ctx.companyId, noMatchArticle]
  );
  unmatchedProductId = other.rows[0].id;

  redOrderId = await addLoading(1, "#B22222", "10.00");
  blueOrderId = await addLoading(2, "#6A5ACD", "12.00");
}, 120000);

afterAll(async () => {
  if (ctx?.companyId) {
    // Remove append-only evidence before deleting shared fixture parents.
    await pool.query("DELETE FROM factory_priority_auto_allocations WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_priority_scan_history WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_priority_scan_configs WHERE company_id = $1", [ctx.companyId]);
    await pool.query(
      `DELETE FROM customer_order_bales WHERE order_id IN
       (SELECT id FROM customer_orders WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await pool.query(
      `DELETE FROM customer_order_lines WHERE order_id IN
       (SELECT id FROM customer_orders WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await pool.query("DELETE FROM canonical_stock_movement_audit WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM canonical_stock_movement_requests WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM canonical_stock_movements WHERE company_id = $1", [ctx.companyId]);
    await pool.query(
      `DELETE FROM factory_bale_production_attributions WHERE bale_id IN
       (SELECT id FROM factory_bales WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await pool.query("DELETE FROM factory_bales WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_bale_sequences WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_bale_products WHERE company_id = $1", [ctx.companyId]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 90000);

describe("Phase 4: atomic new-stock priority routing", () => {
  it("with the company mode OFF, creates normal unallocated stock and inventory", async () => {
    expect((await agent.get(MODE)).body.enabled).toBe(false);
    const created = await createStock(matchingProductId, 1);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      automaticPriorityModeEnabled: false,
      autoPrioritySummary: { allocated: 0, leftInStock: 1 },
      autoPriorityAllocations: [],
    });
    expect(created.body.bales).toHaveLength(1);
    expect(await countRows("factory_priority_auto_allocations")).toBe(0);
    expect(await countRows("factory_priority_scan_history")).toBe(0);
  }, 60000);

  it("allocates a batch sequentially to Red then Blue with exact original pricing", async () => {
    const on = await agent.put(MODE).send({ enabled: true });
    expect(on.status).toBe(200);
    const created = await createStock(matchingProductId, 3);
    expect(created.status).toBe(200);
    expect(created.body.automaticPriorityModeEnabled).toBe(true);
    expect(created.body.autoPrioritySummary).toEqual({ allocated: 3, leftInStock: 0 });
    const assignments = created.body.autoPriorityAllocations as Array<{
      baleId: number;
      referenceNumber: string;
      orderId: number;
      priority: number;
      color: string;
      source: string;
      existing: boolean;
    }>;
    expect(assignments).toHaveLength(3);
    expect(assignments.map((a) => a.orderId)).toEqual([redOrderId, redOrderId, blueOrderId]);
    expect(assignments.map((a) => a.color)).toEqual(["#B22222", "#B22222", "#6A5ACD"]);
    expect(assignments.map((a) => a.source)).toEqual(["stock-entry", "stock-entry", "stock-entry"]);
    expect(assignments.every((a) => !a.existing)).toBe(true);

    const bales = await pool.query<{ id: number; status: string }>(
      "SELECT id, status FROM factory_bales WHERE company_id = $1 ORDER BY id DESC LIMIT 3",
      [ctx.companyId]
    );
    expect(bales.rows.every((row) => row.status === "IN_STOCK")).toBe(true); // V5: linked but physically IN_STOCK

    const links = await pool.query<{ order_id: number; price_used: string }>(
      `SELECT order_id, price_used FROM customer_order_bales
       WHERE bale_id = ANY($1::int[]) ORDER BY bale_id`,
      [assignments.map((a) => a.baleId)]
    );
    expect(links.rows.map((r) => r.order_id)).toEqual([redOrderId, redOrderId, blueOrderId]);
    expect(links.rows.map((r) => Number(r.price_used))).toEqual([10, 10, 12]);

    const firstOrder = await pool.query<{ total_qty_bales: number }>(
      "SELECT total_qty_bales FROM customer_orders WHERE id = $1",
      [redOrderId]
    );
    expect(firstOrder.rows[0].total_qty_bales).toBe(2);
    const config = await pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM customer_order_priority_scan_configs WHERE order_id = $1",
      [redOrderId]
    );
    expect(config.rows[0].enabled).toBe(false); // completed priority automatically advanced

    const original = await agent.get(HISTORY).query({ baleId: assignments[0].baleId });
    expect(original.status).toBe(200);
    expect(original.body.items[0]).toMatchObject({
      orderId: redOrderId,
      originalPriority: 1,
      originalColor: "#B22222",
      allocationSource: "stock-entry",
      active: true,
    });
    expect(await countRows("factory_priority_auto_allocations")).toBe(3);
    expect(await countRows("factory_priority_scan_history")).toBe(3);
  }, 60000);

  it("never overfills Blue: next matching bale goes there, extra stays in stock", async () => {
    const created = await createStock(matchingProductId, 2);
    expect(created.status).toBe(200);
    expect(created.body.autoPrioritySummary).toEqual({ allocated: 1, leftInStock: 1 });
    expect(created.body.autoPriorityAllocations).toHaveLength(1);
    expect(created.body.autoPriorityAllocations[0].orderId).toBe(blueOrderId);
    const blue = await pool.query<{ total_qty_bales: number }>(
      "SELECT total_qty_bales FROM customer_orders WHERE id = $1",
      [blueOrderId]
    );
    expect(blue.rows[0].total_qty_bales).toBe(2);
    const blueConfig = await pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM customer_order_priority_scan_configs WHERE order_id = $1",
      [blueOrderId]
    );
    expect(blueConfig.rows[0].enabled).toBe(false);
    expect(await countRows("factory_priority_auto_allocations")).toBe(4);
  }, 60000);

  it("creates unmatched product in stock without inventing an allocation", async () => {
    const created = await createStock(unmatchedProductId, 1);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      automaticPriorityModeEnabled: true,
      autoPrioritySummary: { allocated: 0, leftInStock: 1 },
      autoPriorityAllocations: [],
    });
    expect(await countRows("factory_priority_auto_allocations")).toBe(4);
  }, 60000);

  it("does not deduct a second inventory receipt or movement for auto-loading", async () => {
    const rows = await pool.query<{ qty: string }>(
      `SELECT COALESCE(SUM(quantity_delta), 0)::text AS qty FROM canonical_stock_movements
       WHERE company_id = $1 AND source_type = 'factory-stock-entry'`,
      [ctx.companyId]
    );
    // 1 OFF + 3 Red/Blue + 2 Blue/full + 1 unmatched.
    expect(Number(rows.rows[0].qty)).toBe(7);
    const inventory = await pool.query<{ qty: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS qty FROM inventory
       WHERE company_id = $1 AND location_id = $2
         AND stock_item_id IN (SELECT id FROM stock_items
                              WHERE company_id = $1 AND code IN ($3, $4))`,
      [ctx.companyId, ctx.locationId, articleCode, noMatchArticle]
    );
    expect(Number(inventory.rows[0].qty)).toBe(7);
  }, 60000);

  it("serializes concurrent Stock Entry batches against the same remaining proforma capacity", async () => {
    const thirdOrderId = await addLoading(1, "#7FFF00", "9.00");
    const [left, right] = await Promise.all([createStock(matchingProductId, 2), createStock(matchingProductId, 2)]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const assignments = [
      ...(left.body.autoPriorityAllocations || []),
      ...(right.body.autoPriorityAllocations || []),
    ] as Array<{ baleId: number; orderId: number }>;
    const newlyCreatedIds = [
      ...left.body.bales.map((b: { id: number }) => b.id),
      ...right.body.bales.map((b: { id: number }) => b.id),
    ];
    expect(assignments).toHaveLength(2);
    expect(assignments.every((a) => a.orderId === thirdOrderId)).toBe(true);
    expect(new Set(assignments.map((a) => a.baleId)).size).toBe(2);

    const linked = await pool.query<{ qty: string }>(
      `SELECT COUNT(*)::text AS qty FROM customer_order_bales
       WHERE order_id = $1 AND bale_id = ANY($2::int[])`,
      [thirdOrderId, newlyCreatedIds]
    );
    expect(Number(linked.rows[0].qty)).toBe(2);

    const inventoryReceipts = await pool.query<{ qty: string }>(
      `SELECT COALESCE(SUM(quantity_delta), 0)::text AS qty
       FROM canonical_stock_movements
       WHERE company_id = $1 AND source_type = 'factory-stock-entry'`,
      [ctx.companyId]
    );
    expect(Number(inventoryReceipts.rows[0].qty)).toBe(11);
  }, 90000);

  it("switching OFF stops new automatic loading but does not reverse the old snapshots", async () => {
    const off = await agent.put(MODE).send({ enabled: false });
    expect(off.status).toBe(200);
    const oldAssignments = await countRows("factory_priority_auto_allocations");
    const created = await createStock(matchingProductId, 1);
    expect(created.status).toBe(200);
    expect(created.body.autoPrioritySummary).toEqual({ allocated: 0, leftInStock: 1 });
    expect(await countRows("factory_priority_auto_allocations")).toBe(oldAssignments);
    const archived = await agent.get(HISTORY).query({ orderId: redOrderId });
    expect(archived.status).toBe(200);
    expect(archived.body.items.every((item: { originalColor: string }) => item.originalColor === "#B22222")).toBe(true);
  }, 60000);

  it("rolls back the complete Stock Entry if an item is invalid", async () => {
    const before = await pool.query<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM factory_bales WHERE company_id = $1",
      [ctx.companyId]
    );
    const attempted = await agent.post(STOCK).send({
      erpLocationId: ctx.locationId,
      items: [
        { productId: matchingProductId, quantity: 1, weightPerBale: "25" },
        { productId: 2147483646, quantity: 1, weightPerBale: "25" },
      ],
    });
    expect(attempted.status).toBeGreaterThanOrEqual(400);
    const after = await pool.query<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM factory_bales WHERE company_id = $1",
      [ctx.companyId]
    );
    expect(after.rows[0].total).toBe(before.rows[0].total);
  }, 60000);
});
