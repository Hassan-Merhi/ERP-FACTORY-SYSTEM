/**
 * Phase 6 physical deletion / inventory reversal integration contract.
 *
 * Intentionally authored WITHOUT executing tests. Claude verifies the single
 * feature PR later; do not interpret these assertions as passing yet.
 *
 * Merged into the accounting audit branch (phase 19 C, F3): the generic bale
 * routes (Bale History DELETE, status DELETED, bulk status) delete only a
 * pre-stock bale; a valued (IN_STOCK) bale answers 409 and is removed through
 * the supervised Stock Removal, which runs the same physical-deletion service
 * (and records the WASTE value event). The cases below that deleted IN_STOCK
 * bales through the generic routes now assert that refusal and remove the
 * bale through Stock Removal instead; the reversal assertions are unchanged.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { ensurePriorityScanSchema } from "../server/startup/priorityScanSchema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "autodel6";
const API = "/api/factory/stock-entry/remove";
const ARTICLE = "AUTO-DEL-6";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let productId: number;
let orderId: number;
let allocatedBale: { id: number; referenceNumber: string };
let unusedBale: { id: number; referenceNumber: string };
let beforeQty: number;

async function inventoryQty(): Promise<number> {
  const { rows } = await pool.query<{ qty: string }>(
    `SELECT COALESCE(SUM(inv.quantity), 0)::text AS qty FROM inventory inv
      JOIN stock_items item ON item.id = inv.stock_item_id
     WHERE inv.company_id = $1 AND inv.location_id = $2 AND item.code = $3`,
    [ctx.companyId, ctx.locationId, ARTICLE]
  );
  return Number(rows[0].qty);
}
async function removedMovements(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM canonical_stock_movements
     WHERE company_id = $1 AND source_type = 'factory_bale_removal'`,
    [ctx.companyId]
  );
  return Number(rows[0].count);
}
async function baleStatus(id: number): Promise<{ status: string; deleted_at: string | null }> {
  const { rows } = await pool.query<{ status: string; deleted_at: string | null }>(
    "SELECT status, deleted_at FROM factory_bales WHERE company_id = $1 AND id = $2",
    [ctx.companyId, id]
  );
  return rows[0];
}

beforeAll(async () => {
  await ensurePriorityScanSchema(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (
      await agent.post("/api/auth/login").send({
        username: `${PREFIX}_testuser`,
        password: "testpassword123",
      })
    ).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
    ctx.userId,
    ctx.companyId,
  ]);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-CUSTOMER`, "Deletion Test Customer"]
  );
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
      VALUES ($1, $2, 'Priority Physical Deletion', TRUE) RETURNING id`,
    [ctx.companyId, customer.rows[0].id]
  );
  await pool.query(
    `INSERT INTO customer_proforma_lines
      (proforma_id, article_code, product_name, quantity, price_per_bale)
      VALUES ($1, $2, 'Adult Jogger Pant', 1, '35.00')`,
    [proforma.rows[0].id, ARTICLE]
  );
  const order = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, CURRENT_DATE, 'LOADING', $3) RETURNING id`,
    [ctx.companyId, customer.rows[0].id, proforma.rows[0].id]
  );
  orderId = order.rows[0].id;
  const config = await agent
    .put(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`)
    .send({ enabled: true, priority: 1, color: "#dc2626" });
  expect(config.status).toBe(200);
  const product = await pool.query<{ id: number }>(
    `INSERT INTO factory_bale_products
      (company_id, code, name, article_code, production_price, selling_price)
     VALUES ($1, $2, 'Adult Jogger Pant', $2, '10', '35') RETURNING id`,
    [ctx.companyId, ARTICLE]
  );
  productId = product.rows[0].id;
  expect((await agent.put("/api/factory/automatic-priority-mode").send({ enabled: true })).status).toBe(200);
  const created = await agent.post("/api/factory/stock-entry").send({
    erpLocationId: ctx.locationId,
    entryDate: "2026-10-09",
    items: [{ productId, quantity: 2, weightPerBale: "40" }],
  });
  expect(created.status).toBe(200);
  expect(created.body.autoPriorityAllocations).toHaveLength(1);
  allocatedBale = created.body.bales.find(
    (b: { id: number }) => b.id === created.body.autoPriorityAllocations[0].baleId
  );
  unusedBale = created.body.bales.find((b: { id: number }) => b.id !== allocatedBale.id);
  beforeQty = await inventoryQty();
  expect(beforeQty).toBe(2);
}, 120000);

afterAll(async () => {
  if (ctx?.companyId) {
    await pool.query("DELETE FROM factory_physical_bale_deletions WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_priority_auto_allocations WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_priority_scan_history WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_priority_scan_configs WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_bale_removals WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM customer_order_bales WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM customer_order_lines WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM canonical_stock_movement_audit WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM canonical_stock_movement_requests WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM canonical_stock_movements WHERE company_id = $1", [ctx.companyId]);
    await pool.query(
      `DELETE FROM factory_bale_production_attributions WHERE bale_id IN
       (SELECT id FROM factory_bales WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await pool.query("DELETE FROM factory_daily_bale_scans WHERE company_id = $1", [String(ctx.companyId)]);
    await pool.query("DELETE FROM factory_bales WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_bale_sequences WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_bale_products WHERE company_id = $1", [ctx.companyId]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 90000);

describe("Phase 6: physical deletion is atomic and permanent-history safe", () => {
  it("supervisor removal reverses loading, live scan and location inventory exactly once", async () => {
    const removed = await agent.post(API).send({
      baleIds: [allocatedBale.id],
      supervisorUsername: `${PREFIX}_testuser`,
      supervisorPassword: "testpassword123",
      reason: "Production bale damaged",
    });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(1);
    expect((await baleStatus(allocatedBale.id)).status).toBe("DELETED");
    expect((await baleStatus(allocatedBale.id)).deleted_at).not.toBeNull();
    expect(await inventoryQty()).toBe(beforeQty - 1);
    expect(await removedMovements()).toBe(1);
    const { rows: deletionEvents } = await pool.query<{
      previous_status: string;
      reference_number: string;
      removed_by_name: string;
      reason: string;
    }>(
      "SELECT previous_status, reference_number, removed_by_name, reason FROM factory_physical_bale_deletions WHERE company_id = $1 AND bale_id = $2",
      [ctx.companyId, allocatedBale.id]
    );
    expect(deletionEvents).toHaveLength(1);
    expect(deletionEvents[0]).toMatchObject({
      previous_status: "IN_STOCK",
      reference_number: allocatedBale.referenceNumber,
      removed_by_name: `${PREFIX}_testuser`,
      reason: "Production bale damaged",
    });

    const { rows: links } = await pool.query(
      "SELECT id FROM customer_order_bales WHERE order_id = $1 AND bale_id = $2",
      [orderId, allocatedBale.id]
    );
    expect(links).toHaveLength(0);
    const { rows: order } = await pool.query<{ total_qty_bales: number }>(
      "SELECT total_qty_bales FROM customer_orders WHERE id = $1",
      [orderId]
    );
    expect(order[0].total_qty_bales).toBe(0);
    const history = await agent
      .get("/api/factory/customer-orders/loading-list/priority-allocation-history")
      .query({ baleId: allocatedBale.id });
    expect(history.status).toBe(200);
    expect(history.body.items[0]).toMatchObject({
      originalPriority: 1,
      originalColor: "#dc2626",
      active: false,
      reversedBy: `${PREFIX}_testuser`,
      reversalReason: "Production bale damaged",
    });
    expect(history.body.items[0].reversedAt).toBeTruthy();
    const { rows: audit } = await pool.query(
      "SELECT id FROM customer_order_bale_removals WHERE order_id = $1 AND bale_id = $2",
      [orderId, allocatedBale.id]
    );
    expect(audit).toHaveLength(1);
    const { rows: daily } = await pool.query(
      "SELECT id FROM factory_daily_bale_scans WHERE company_id = $1 AND reference_number = $2",
      [String(ctx.companyId), allocatedBale.referenceNumber]
    );
    expect(daily).toHaveLength(0);
    const { rows: daybook } = await pool.query(
      "SELECT id FROM factory_daybook_entries WHERE company_id = $1 AND tx_type = 'BALE_REMOVAL'",
      [ctx.companyId]
    );
    expect(daybook).toHaveLength(1);
  }, 60000);

  it("refuses repeated deletion without another inventory debit or audit row", async () => {
    const retried = await agent.post(API).send({
      baleIds: [allocatedBale.id],
      supervisorUsername: `${PREFIX}_testuser`,
      supervisorPassword: "testpassword123",
      reason: "Repeated confirmation",
    });
    expect(retried.status).toBeGreaterThanOrEqual(400);
    expect(await inventoryQty()).toBe(1);
    expect(await removedMovements()).toBe(1);
  });

  it("rejects duplicate IDs and rolls back batches containing an already deleted bale", async () => {
    const bad = await agent.post(API).send({
      baleIds: [unusedBale.id, allocatedBale.id],
      supervisorUsername: `${PREFIX}_testuser`,
      supervisorPassword: "testpassword123",
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const duplicate = await agent.post(API).send({
      baleIds: [unusedBale.id, unusedBale.id],
      supervisorUsername: `${PREFIX}_testuser`,
      supervisorPassword: "testpassword123",
    });
    expect(duplicate.status).toBe(400);
    expect((await baleStatus(unusedBale.id)).status).toBe("IN_STOCK");
    expect(await inventoryQty()).toBe(1);
    expect(await removedMovements()).toBe(1);
  });

  it("general Bale History delete refuses stock; Stock Removal removes unallocated stock inventory too", async () => {
    const refused = await agent.delete(`/api/factory/bales/${unusedBale.id}`);
    expect(refused.status).toBe(409);
    expect(await inventoryQty()).toBe(1);
    const deleted = await agent.post(API).send({
      baleIds: [unusedBale.id],
      supervisorUsername: `${PREFIX}_testuser`,
      supervisorPassword: "testpassword123",
      reason: "Unallocated bale removed",
    });
    expect(deleted.status).toBe(200);
    expect(await inventoryQty()).toBe(0);
    expect(await removedMovements()).toBe(2);
    expect((await baleStatus(unusedBale.id)).status).toBe("DELETED");
  });

  it("generic restore refuses to recreate physical stock after a canonical debit", async () => {
    const restore = await agent.post(`/api/deleted-items/factoryBale/${unusedBale.id}/restore`);
    expect(restore.status).toBe(409);
    expect(String(restore.body.message)).toMatch(/inventory|stock re-entry/i);
    expect((await baleStatus(unusedBale.id)).status).toBe("DELETED");
    expect(await inventoryQty()).toBe(0);
    expect(await removedMovements()).toBe(2);
  });

  it("cannot resurrect a physically deleted bale or bypass reversal through REMOVED", async () => {
    const revive = await agent.patch(`/api/factory/bales/${allocatedBale.id}/status`).send({ status: "IN_STOCK" });
    expect(revive.status).toBe(409);
    const removed = await agent.patch(`/api/factory/bales/${allocatedBale.id}/status`).send({ status: "REMOVED" });
    expect(removed.status).toBe(409);
    expect(await inventoryQty()).toBe(0);
  });

  it("bulk status DELETED refuses stock (Stock Removal reverses it), and bulk update cannot revive deleted stock", async () => {
    const newStock = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.locationId,
      items: [{ productId, quantity: 2, weightPerBale: "40" }],
    });
    expect(newStock.status).toBe(200);
    const ids = newStock.body.bales.map((b: { id: number }) => b.id);
    const refused = await agent.patch("/api/factory/bales/bulk-status").send({ ids, status: "DELETED" });
    expect(refused.status).toBe(409);
    expect(await removedMovements()).toBe(2);
    const deletion = await agent.post(API).send({
      baleIds: ids,
      supervisorUsername: `${PREFIX}_testuser`,
      supervisorPassword: "testpassword123",
      reason: "Bulk removal",
    });
    expect(deletion.status).toBe(200);
    expect(deletion.body.removed).toBe(2);
    expect(await removedMovements()).toBe(4);
    const revive = await agent.patch("/api/factory/bales/bulk-status").send({ ids, status: "IN_STOCK" });
    expect(revive.status).toBeGreaterThanOrEqual(400);
  }, 60000);

  it("blocks physical deletion of a bale linked to verified customer loading", async () => {
    const stock = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.locationId,
      items: [{ productId, quantity: 1, weightPerBale: "40" }],
    });
    expect(stock.status).toBe(200);
    const bale = stock.body.bales[0];
    await pool.query(
      `INSERT INTO customer_order_bales
        (order_id, bale_id, bale_reference, location_id, weight, article_code, bale_name, price_used)
       VALUES ($1, $2, $3, $4, '40', $5, 'Adult Jogger Pant', '35')`,
      [orderId, bale.id, bale.referenceNumber, ctx.locationId, ARTICLE]
    );
    await pool.query("UPDATE customer_orders SET status = 'VERIFIED' WHERE id = $1", [orderId]);
    const quantityBefore = await inventoryQty();
    const rejected = await agent.delete(`/api/factory/bales/${bale.id}`);
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect((await baleStatus(bale.id)).status).toBe("IN_STOCK");
    expect(await inventoryQty()).toBe(quantityBefore);
    expect(await removedMovements()).toBe(4);
  }, 60000);
});

describe("Phase 6 review fixes: every deletion path, live links only", () => {
  const extraOrders: number[] = [];

  async function customerId(): Promise<number> {
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM customers WHERE company_id = $1 AND code = $2", [
      ctx.companyId,
      `${PREFIX}-CUSTOMER`,
    ]);
    return rows[0].id;
  }
  async function newOrder(status: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO customer_orders (company_id, customer_id, order_date, status)
       VALUES ($1, $2, CURRENT_DATE, $3) RETURNING id`,
      [ctx.companyId, await customerId(), status]
    );
    extraOrders.push(rows[0].id);
    return rows[0].id;
  }
  async function newStockBales(quantity: number): Promise<Array<{ id: number; referenceNumber: string }>> {
    // Mode ON would route the bale into a priority loading; these cases need
    // ordinary stock, so turn it off just for the receipt.
    expect((await agent.put("/api/factory/automatic-priority-mode").send({ enabled: false })).status).toBe(200);
    const stock = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.locationId,
      items: [{ productId, quantity, weightPerBale: "40" }],
    });
    expect(stock.status).toBe(200);
    return stock.body.bales;
  }
  async function link(order: number, bale: { id: number; referenceNumber: string }): Promise<void> {
    await pool.query(
      `INSERT INTO customer_order_bales
        (order_id, bale_id, bale_reference, location_id, weight, article_code, bale_name, price_used)
       VALUES ($1, $2, $3, $4, '40', $5, 'Adult Jogger Pant', '35')`,
      [order, bale.id, bale.referenceNumber, ctx.locationId, ARTICLE]
    );
  }

  afterAll(async () => {
    if (!extraOrders.length) return;
    await pool.query("DELETE FROM customer_order_bale_removals WHERE order_id = ANY($1::int[])", [extraOrders]);
    await pool.query("DELETE FROM customer_order_bales WHERE order_id = ANY($1::int[])", [extraOrders]);
    await pool.query("DELETE FROM customer_order_lines WHERE order_id = ANY($1::int[])", [extraOrders]);
  });

  it("deletes a bale whose only link is a cancelled loading, keeping that order's history", async () => {
    const [bale] = await newStockBales(1);
    const cancelled = await newOrder("CANCELLED");
    await link(cancelled, bale);
    const before = await inventoryQty();
    const movementsBefore = await removedMovements();

    expect((await agent.delete(`/api/factory/bales/${bale.id}`)).status).toBe(409);
    const deleted = await agent.post(API).send({
      baleIds: [bale.id],
      supervisorUsername: `${PREFIX}_testuser`,
      supervisorPassword: "testpassword123",
      reason: "Cancelled loading bale removed",
    });
    expect(deleted.status).toBe(200);
    expect(await inventoryQty()).toBe(before - 1);
    expect(await removedMovements()).toBe(movementsBefore + 1);
    // The cancelled order's own record of the bale is left alone.
    const { rows } = await pool.query("SELECT id FROM customer_order_bales WHERE order_id = $1 AND bale_id = $2", [
      cancelled,
      bale.id,
    ]);
    expect(rows).toHaveLength(1);
  }, 60000);

  it("answers business rejections with 4xx, not 500", async () => {
    const missing = await agent.delete("/api/factory/bales/2147483000");
    expect(missing.status).toBe(404);
    const [bale] = await newStockBales(1);
    const locked = await newOrder("FINALIZED");
    await link(locked, bale);
    const rejected = await agent.delete(`/api/factory/bales/${bale.id}`);
    expect(rejected.status).toBe(409);
    expect((await baleStatus(bale.id)).status).toBe("IN_STOCK");
  }, 60000);

  it("quantity removal never picks bales on a live loading", async () => {
    // Earlier cases leave other stock at this location; isolate on fresh bales
    // by loading every existing in-stock bale of the product first.
    const live = await newOrder("LOADING");
    const { rows: existing } = await pool.query<{ id: number; reference_number: string }>(
      `SELECT id, reference_number FROM factory_bales fb
        WHERE company_id = $1 AND product_id = $2 AND status = 'IN_STOCK' AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM customer_order_bales cob WHERE cob.bale_id = fb.id)`,
      [ctx.companyId, productId]
    );
    for (const row of existing) await link(live, { id: row.id, referenceNumber: row.reference_number });
    const [loaded, free] = await newStockBales(2);
    await link(live, loaded);
    const before = await inventoryQty();

    const tooMany = await agent.post("/api/factory/stock-entry/remove-by-product").send({
      productId,
      locationId: ctx.locationId,
      qty: 2,
      supervisorUsername: `${PREFIX}_testuser`,
      supervisorPassword: "testpassword123",
    });
    expect(tooMany.status).toBe(400);
    expect(await inventoryQty()).toBe(before);

    const one = await agent.post("/api/factory/stock-entry/remove-by-product").send({
      productId,
      locationId: ctx.locationId,
      qty: 1,
      supervisorUsername: `${PREFIX}_testuser`,
      supervisorPassword: "testpassword123",
    });
    expect(one.status).toBe(200);
    expect(one.body.bales.map((b: { id: number }) => b.id)).toEqual([free.id]);
    expect((await baleStatus(loaded.id)).status).toBe("IN_STOCK");
    expect(await inventoryQty()).toBe(before - 1);
  }, 60000);

  it("Barcode Lookup delete-everywhere uses the same single inventory reversal", async () => {
    const [bale] = await newStockBales(1);
    const before = await inventoryQty();
    const movementsBefore = await removedMovements();
    const deleted = await agent.delete(
      `/api/lookup/reference/${encodeURIComponent(bale.referenceNumber)}/delete-everywhere`
    );
    expect(deleted.status).toBe(200);
    expect(await inventoryQty()).toBe(before - 1);
    expect(await removedMovements()).toBe(movementsBefore + 1);
    const { rows } = await pool.query(
      "SELECT id FROM factory_physical_bale_deletions WHERE company_id = $1 AND bale_id = $2",
      [ctx.companyId, bale.id]
    );
    expect(rows).toHaveLength(1);
    const again = await agent.delete(
      `/api/lookup/reference/${encodeURIComponent(bale.referenceNumber)}/delete-everywhere`
    );
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await inventoryQty()).toBe(before - 1);
  }, 60000);

  it("waste dispatch refuses a bale that is still on a live loading", async () => {
    const [loaded, free] = await newStockBales(2);
    const live = await newOrder("LOADING");
    await link(live, loaded);
    const before = await inventoryQty();
    const refused = await agent
      .post("/api/factory/waste-dispatch/submit")
      .send({ baleIds: [free.id, loaded.id], dispatchDate: "2026-10-09" });
    expect(refused.status).toBe(400);
    expect(String(refused.body.message)).toContain("customer loading");
    expect((await baleStatus(free.id)).status).toBe("IN_STOCK");
    expect(await inventoryQty()).toBe(before);
  }, 60000);

  it("status edits cannot move a bale on an open loading out of stock without reversal", async () => {
    const [bale] = await newStockBales(1);
    const live = await newOrder("LOADING");
    await link(live, bale);
    const single = await agent.patch(`/api/factory/bales/${bale.id}/status`).send({ status: "SOLD" });
    expect(single.status).toBe(409);
    const bulk = await agent.patch("/api/factory/bales/bulk-status").send({ ids: [bale.id], status: "PRESSED" });
    expect(bulk.status).toBe(409);
    expect((await baleStatus(bale.id)).status).toBe("IN_STOCK");
  }, 60000);
});
