/**
 * Automatic Priority Printing & Loading — end-to-end business scenarios A–G,
 * driven through the real HTTP API against PostgreSQL (no browser, no printer).
 *
 * Red Priority #1 needs two Jogger Pant bales and Blue Priority #2 needs three.
 * The suite walks the approved Priority #1 recovery example: Red fills and
 * completes, Blue becomes #1, a Red bale is physically deleted, Red returns to
 * #1 with Blue at #2 (Blue keeps its bales), the replacement bale finishes Red
 * and the queue advances normally again. Inventory, loading totals and
 * allocation evidence are checked after every step.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { ensurePriorityScanSchema } from "../server/startup/priorityScanSchema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "autoe2e";
const MODE = "/api/factory/automatic-priority-mode";
const STOCK = "/api/factory/stock-entry";
const REMOVE = "/api/factory/stock-entry/remove";
const BATCH = "/api/factory/customer-orders/loading-list/automatic-print-preflight-batch";
const JOGGER = "E2E-JOGGER";
const OTHER = "E2E-OTHER";
const RED = "#B22222";
const BLUE = "#6A5ACD";
const GREEN = "#7FFF00";

type Bale = { id: number; referenceNumber: string };
type Allocation = { baleId: number; orderId: number; color: string; priority: number };

let ctx: TestContext;
let agent: request.SuperAgentTest;
let joggerId: number;
let otherId: number;
let customerId: number;
let red: number;
let blue: number;
let green: number;
let otherCompanyId: number | null = null;
let ordinaryBale: Bale;
let redBales: Bale[] = [];
let blueBales: Bale[] = [];
let looseOther: Bale;
let receipts = 0;
let deletions = 0;

async function inventory(code = JOGGER): Promise<number> {
  const { rows } = await pool.query<{ qty: string }>(
    `SELECT COALESCE(SUM(inv.quantity), 0)::text AS qty FROM inventory inv
       JOIN stock_items item ON item.id = inv.stock_item_id
      WHERE inv.company_id = $1 AND inv.location_id = $2 AND item.code = $3`,
    [ctx.companyId, ctx.locationId, code]
  );
  return Number(rows[0].qty);
}
async function removalMovements(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM canonical_stock_movements
      WHERE company_id = $1 AND source_type = 'factory_bale_removal'`,
    [ctx.companyId]
  );
  return Number(rows[0].count);
}
async function order(id: number) {
  const { rows } = await pool.query<{ total_qty_bales: number; subtotal_bales: string; status: string }>(
    "SELECT total_qty_bales, subtotal_bales, status FROM customer_orders WHERE id = $1",
    [id]
  );
  return { qty: rows[0].total_qty_bales, subtotal: Number(rows[0].subtotal_bales), status: rows[0].status };
}
async function links(orderId: number): Promise<number[]> {
  const { rows } = await pool.query<{ bale_id: number }>(
    "SELECT bale_id FROM customer_order_bales WHERE order_id = $1 ORDER BY bale_id",
    [orderId]
  );
  return rows.map((row) => row.bale_id);
}
async function activeQueue(): Promise<Array<{ orderId: number; priority: number; color: string }>> {
  const { rows } = await pool.query<{ order_id: number; priority: number; color: string }>(
    `SELECT order_id, priority, color FROM customer_order_priority_scan_configs
      WHERE company_id = $1 AND enabled = TRUE ORDER BY priority`,
    [ctx.companyId]
  );
  return rows.map((row) => ({ orderId: row.order_id, priority: row.priority, color: row.color }));
}
async function duplicateActiveAllocations(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM (
       SELECT bale_id FROM factory_priority_auto_allocations
        WHERE company_id = $1 AND reversed_at IS NULL GROUP BY bale_id HAVING COUNT(*) > 1) d`,
    [ctx.companyId]
  );
  return Number(rows[0].count);
}
async function balesOnMoreThanOneLoading(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM (
       SELECT cob.bale_id FROM customer_order_bales cob JOIN customer_orders co ON co.id = cob.order_id
        WHERE co.company_id = $1 GROUP BY cob.bale_id HAVING COUNT(*) > 1) d`,
    [ctx.companyId]
  );
  return Number(rows[0].count);
}
async function addLoading(quantity: number, priority: number, color: string, price: string): Promise<number> {
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, TRUE) RETURNING id`,
    [ctx.companyId, customerId, `${PREFIX}-${color}`]
  );
  await pool.query(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale, pricing_mode)
     VALUES ($1, $2, 'Adult Jogger Pant', $3, $4, 'per_bale')`,
    [proforma.rows[0].id, JOGGER, quantity, price]
  );
  const loading = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, CURRENT_DATE, 'LOADING', $3) RETURNING id`,
    [ctx.companyId, customerId, proforma.rows[0].id]
  );
  const config = await agent
    .put(`/api/factory/customer-orders/${loading.rows[0].id}/loading-list/priority-scan-config`)
    .send({ priority, color, enabled: true });
  expect(config.status).toBe(200);
  return loading.rows[0].id;
}
async function stockEntry(productId: number, quantity: number) {
  const response = await agent.post(STOCK).send({
    erpLocationId: ctx.locationId,
    items: [{ productId, quantity, weightPerBale: "30" }],
  });
  expect(response.status).toBe(200);
  receipts += quantity;
  return response.body as { bales: Bale[]; autoPriorityAllocations: Allocation[] };
}
function supervisorRemove(baleIds: number[]) {
  return agent.post(REMOVE).send({
    baleIds,
    supervisorUsername: `${PREFIX}_testuser`,
    supervisorPassword: "testpassword123",
    reason: "End-to-end deletion",
  });
}

beforeAll(async () => {
  await ensurePriorityScanSchema(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const customer = await pool.query<{ id: number }>(
    "INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'E2E Customer') RETURNING id",
    [ctx.companyId, `${PREFIX}-CUSTOMER`]
  );
  customerId = customer.rows[0].id;
  const products = await pool.query<{ id: number }>(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code, production_price, selling_price)
     VALUES ($1, 'E2EJ', 'Adult Jogger Pant', $2, '5', '20'), ($1, 'E2EO', 'Other Article', $3, '5', '20')
     RETURNING id`,
    [ctx.companyId, JOGGER, OTHER]
  );
  [joggerId, otherId] = products.rows.map((row) => row.id);
  red = await addLoading(2, 1, RED, "10.00");
  blue = await addLoading(3, 2, BLUE, "12.00");
}, 120000);

afterAll(async () => {
  if (ctx?.companyId) {
    for (const table of [
      "factory_physical_bale_deletions",
      "factory_priority_auto_allocations",
      "factory_priority_scan_history",
      "customer_order_priority_scan_configs",
      "bale_label_prints",
      "canonical_stock_movement_audit",
      "canonical_stock_movement_requests",
      "canonical_stock_movements",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [ctx.companyId]);
    }
    for (const table of ["customer_order_bale_removals", "customer_order_bales", "customer_order_lines"]) {
      await pool.query(
        `DELETE FROM ${table} WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`,
        [ctx.companyId]
      );
    }
    await pool.query(
      "DELETE FROM factory_bale_production_attributions WHERE bale_id IN (SELECT id FROM factory_bales WHERE company_id = $1)",
      [ctx.companyId]
    );
    await pool.query("DELETE FROM factory_daily_bale_scans WHERE company_id = $1", [String(ctx.companyId)]);
    await pool.query("DELETE FROM factory_bales WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_bale_sequences WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_bale_products WHERE company_id = $1", [ctx.companyId]);
  }
  if (otherCompanyId) {
    await pool.query("DELETE FROM factory_bales WHERE company_id = $1", [otherCompanyId]);
    await pool.query("DELETE FROM companies WHERE id = $1", [otherCompanyId]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 90000);

describe("Automatic Priority Printing & Loading: end-to-end scenarios", () => {
  it("A: mode OFF keeps ordinary Stock Entry and printing", async () => {
    expect((await agent.get(MODE)).body).toMatchObject({ enabled: false });
    const created = await stockEntry(joggerId, 1);
    expect(created.autoPriorityAllocations).toEqual([]);
    [ordinaryBale] = created.bales;
    expect(await inventory()).toBe(1);

    const print = await agent.post("/api/bale-label-prints").send({
      bales: [
        {
          productionBaleId: ordinaryBale.id,
          productId: joggerId,
          articleCode: JOGGER,
          pieces: 1,
          approxWeightKg: "30",
        },
      ],
    });
    expect(print.status).toBe(200);
    expect(print.body.priorityAllocations).toEqual([]);
    expect(await links(red)).toEqual([]);
    expect(await links(blue)).toEqual([]);
  }, 60000);

  it("B: mode ON fills Red (2) then Blue; a bale nobody needs stays unallocated", async () => {
    expect((await agent.put(MODE).send({ enabled: true })).status).toBe(200);
    const created = await stockEntry(joggerId, 4);
    expect(created.autoPriorityAllocations.map((a) => [a.orderId, a.color])).toEqual([
      [red, RED],
      [red, RED],
      [blue, BLUE],
      [blue, BLUE],
    ]);
    redBales = created.bales.filter((b) =>
      created.autoPriorityAllocations.some((a) => a.baleId === b.id && a.orderId === red)
    );
    blueBales = created.bales.filter((b) =>
      created.autoPriorityAllocations.some((a) => a.baleId === b.id && a.orderId === blue)
    );
    const other = await stockEntry(otherId, 1);
    expect(other.autoPriorityAllocations).toEqual([]);
    [looseOther] = other.bales;

    expect(await order(red)).toMatchObject({ qty: 2, subtotal: 20 });
    expect(await order(blue)).toMatchObject({ qty: 2, subtotal: 24 });
    // Red auto-completed; Blue (still needs one) is now Priority #1.
    expect(await activeQueue()).toEqual([{ orderId: blue, priority: 1, color: BLUE }]);
    // Loading allocation never touches ERP inventory: 1 + 4 Jogger, 1 Other.
    expect(await inventory()).toBe(5);
    expect(await inventory(OTHER)).toBe(1);
    expect(await removalMovements()).toBe(0);
  }, 60000);

  it("C: reprinting a Red bale after queue changes and with mode OFF stays Red with one assignment", async () => {
    const redBale = redBales[0];
    for (const enabled of [true, false]) {
      expect((await agent.put(MODE).send({ enabled })).status).toBe(200);
      for (let attempt = 0; attempt < 2; attempt++) {
        const batch = await agent.post(BATCH).send({ items: [{ baleId: redBale.id }] });
        expect(batch.status).toBe(200);
        expect(batch.body.results[0].priorityAllocation).toMatchObject({ orderId: red, color: RED, existing: true });
        const reprint = await agent.post("/api/bale-label-prints/reprint").send({ baleId: redBale.id });
        expect(reprint.status).toBe(200);
        expect(reprint.body.priorityAllocation).toMatchObject({ orderId: red, color: RED });
      }
    }
    expect((await agent.put(MODE).send({ enabled: true })).status).toBe(200);
    const { rows } = await pool.query<{ active: string; history: string }>(
      `SELECT (SELECT COUNT(*) FROM factory_priority_auto_allocations WHERE bale_id = $1 AND reversed_at IS NULL)::text AS active,
              (SELECT COUNT(*) FROM factory_priority_scan_history WHERE bale_id = $1)::text AS history`,
      [redBale.id]
    );
    expect(rows[0]).toEqual({ active: "1", history: "1" });
    expect(await links(red)).toEqual(redBales.map((b) => b.id).sort((a, b) => a - b));
  }, 60000);

  it("D: deleting a Red bale reverses it once and Red returns to Priority #1 ahead of Blue", async () => {
    const removed = await supervisorRemove([redBales[1].id]);
    expect(removed.status).toBe(200);
    deletions += 1;
    expect(await inventory()).toBe(receipts - 1 - deletions); // minus the Other bale
    expect(await removalMovements()).toBe(1);
    expect(await order(red)).toMatchObject({ qty: 1, subtotal: 10 });
    expect(await links(red)).toEqual([redBales[0].id]);
    // Blue keeps both bales; only the queue order changes.
    expect(await links(blue)).toEqual(blueBales.map((b) => b.id).sort((a, b) => a - b));
    expect(await activeQueue()).toEqual([
      { orderId: red, priority: 1, color: RED },
      { orderId: blue, priority: 2, color: BLUE },
    ]);
    const history = await agent
      .get("/api/factory/customer-orders/loading-list/priority-allocation-history")
      .query({ baleId: redBales[1].id });
    expect(history.body.items[0]).toMatchObject({ originalColor: RED, active: false });
  }, 60000);

  it("E: the replacement goes to Red before Blue, then the queue advances normally", async () => {
    const replacement = await stockEntry(joggerId, 1);
    expect(replacement.autoPriorityAllocations).toMatchObject([{ orderId: red, color: RED, priority: 1 }]);
    expect(await order(red)).toMatchObject({ qty: 2, subtotal: 20 });
    expect(await activeQueue()).toEqual([{ orderId: blue, priority: 1, color: BLUE }]);

    const next = await stockEntry(joggerId, 1);
    expect(next.autoPriorityAllocations).toMatchObject([{ orderId: blue, color: BLUE }]);
    expect(await order(blue)).toMatchObject({ qty: 3, subtotal: 36 });
    expect(await activeQueue()).toEqual([]);

    const nobody = await stockEntry(joggerId, 1);
    expect(nobody.autoPriorityAllocations).toEqual([]);
    expect(await inventory()).toBe(receipts - 1 - deletions);
  }, 60000);

  it("F: concurrent creation, printing and deletion never duplicate, overfill or double-count", async () => {
    green = await addLoading(3, 1, GREEN, "9.00");
    const entries = Array.from({ length: 6 }, () =>
      agent
        .post(STOCK)
        .send({ erpLocationId: ctx.locationId, items: [{ productId: joggerId, quantity: 1, weightPerBale: "30" }] })
    );
    const prints = Array.from({ length: 3 }, () => agent.post(BATCH).send({ items: [{ baleId: ordinaryBale.id }] }));
    const results = await Promise.all([...entries, ...prints]);
    for (const result of results) expect(result.status).toBe(200);
    receipts += 6;

    expect(await links(green)).toHaveLength(3);
    expect(await order(green)).toMatchObject({ qty: 3, subtotal: 27 });
    expect(await duplicateActiveAllocations()).toBe(0);
    expect(await balesOnMoreThanOneLoading()).toBe(0);
    expect(await activeQueue()).toEqual([]);

    // Two operators delete the same unallocated bale at the same moment.
    const { rows } = await pool.query<{ id: number }>(
      `SELECT fb.id FROM factory_bales fb
        WHERE fb.company_id = $1 AND fb.product_id = $2 AND fb.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM customer_order_bales cob WHERE cob.bale_id = fb.id)
        ORDER BY fb.id DESC LIMIT 1`,
      [ctx.companyId, joggerId]
    );
    const target = rows[0].id;
    const movementsBefore = await removalMovements();
    const racing = await Promise.all([supervisorRemove([target]), agent.delete(`/api/factory/bales/${target}`)]);
    expect(racing.filter((r) => r.status === 200)).toHaveLength(1);
    expect(racing.filter((r) => r.status >= 400)).toHaveLength(1);
    deletions += 1;
    expect(await removalMovements()).toBe(movementsBefore + 1);
    expect(await inventory()).toBe(receipts - 1 - deletions);
  }, 120000);

  it("G: invalid, deleted, cross-company and finalized operations are rejected without side effects", async () => {
    const company = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, base_currency, company_type)
       VALUES ('AUTOE2EX', '${PREFIX}-foreign', 'USD', 'factory') RETURNING id`
    );
    otherCompanyId = company.rows[0].id;
    const foreign = await pool.query<{ id: number }>(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, 'E2E-FOREIGN', 'E2E-FOREIGN', $2, '30', '1', '30', 'IN_STOCK') RETURNING id`,
      [otherCompanyId, JOGGER]
    );
    const foreignId = foreign.rows[0].id;
    const before = await inventory();
    const movementsBefore = await removalMovements();

    expect((await agent.delete(`/api/factory/bales/${foreignId}`)).status).toBe(404);
    expect((await supervisorRemove([foreignId])).status).toBe(400);
    expect((await agent.post(BATCH).send({ items: [{ baleId: foreignId }] })).status).toBe(400);
    expect((await agent.post("/api/bale-label-prints/reprint").send({ baleId: foreignId })).status).toBe(404);

    // Already deleted bale.
    expect((await agent.delete(`/api/factory/bales/${redBales[1].id}`)).status).toBe(404);
    expect((await agent.post("/api/bale-label-prints/reprint").send({ baleId: redBales[1].id })).status).toBe(404);

    // Finalized loading: physical deletion refused, link and inventory untouched.
    await pool.query("UPDATE customer_orders SET status = 'FINALIZED' WHERE id = $1", [blue]);
    const blocked = await agent.delete(`/api/factory/bales/${blueBales[0].id}`);
    expect(blocked.status).toBe(409);
    // A mixed batch with one valid bale and the finalized one must not partly succeed.
    const mixed = await supervisorRemove([looseOther.id, blueBales[0].id]);
    expect(mixed.status).toBe(400);
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM factory_bales WHERE id = $1", [
      looseOther.id,
    ]);
    expect(rows[0].status).toBe("IN_STOCK");
    expect(await links(blue)).toContain(blueBales[0].id);
    expect(await inventory()).toBe(before);
    expect(await inventory(OTHER)).toBe(1);
    expect(await removalMovements()).toBe(movementsBefore);
    await pool.query("UPDATE customer_orders SET status = 'LOADING' WHERE id = $1", [blue]);
  }, 60000);
});
