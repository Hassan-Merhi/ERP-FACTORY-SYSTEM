/**
 * Phase 5 integration verification contract for Claude.
 * These tests are authored but must NOT be run during implementation.
 */
import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { ensurePriorityScanSchema } from "../server/startup/priorityScanSchema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "autoprt5";
const BATCH = "/api/factory/customer-orders/loading-list/automatic-print-preflight-batch";
const MODE = "/api/factory/automatic-priority-mode";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let productId: number;
let orderId: number;
let firstBale: { id: number; referenceNumber: string };
let secondBale: { id: number; referenceNumber: string };

async function allocations() {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM factory_priority_auto_allocations
      WHERE company_id = $1 AND reversed_at IS NULL`, [ctx.companyId]
  );
  return Number(rows[0].count);
}
async function history() {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM factory_priority_scan_history WHERE company_id = $1`,
    [ctx.companyId]
  );
  return Number(rows[0].count);
}
const batchInput = (bale: { id: number; referenceNumber: string }) =>
  ({ baleId: bale.id, referenceNumber: bale.referenceNumber });

beforeAll(async () => {
  await ensurePriorityScanSchema(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${PREFIX}_testuser`, password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-C`, "Phase 5 Print Customer"]
  );
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, 'Phase 5 Print Proforma', TRUE) RETURNING id`,
    [ctx.companyId, customer.rows[0].id]
  );
  await pool.query(
    `INSERT INTO customer_proforma_lines
       (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, 'PRINT-PANT', 'Adult Jogger Pant', 1, '25.00')`,
    [proforma.rows[0].id]
  );
  const loading = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders
       (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, CURRENT_DATE, 'LOADING', $3) RETURNING id`,
    [ctx.companyId, customer.rows[0].id, proforma.rows[0].id]
  );
  orderId = loading.rows[0].id;
  const configured = await agent.put(
    `/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`
  ).send({ color: "#dc2626", priority: 1, enabled: true });
  expect(configured.status).toBe(200);
  const product = await pool.query<{ id: number }>(
    `INSERT INTO factory_bale_products
       (company_id, code, name, article_code, production_price, selling_price)
     VALUES ($1, 'PRINTPANT', 'Adult Jogger Pant', 'PRINT-PANT', '2', '25')
     RETURNING id`,
    [ctx.companyId]
  );
  productId = product.rows[0].id;

  // Create TWO physical bales while automatic mode is OFF. Later print will
  // allocate exactly one bale to the one remaining loading slot.
  const stock = await agent.post("/api/factory/stock-entry").send({
    erpLocationId: ctx.locationId,
    items: [{ productId, quantity: 2, weightPerBale: "40" }],
  });
  expect(stock.status).toBe(200);
  [firstBale, secondBale] = stock.body.bales;
}, 120000);

afterAll(async () => {
  if (ctx?.companyId) {
    await pool.query("DELETE FROM factory_priority_auto_allocations WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_priority_scan_history WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_priority_scan_configs WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_bales WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM customer_order_lines WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM canonical_stock_movement_audit WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM canonical_stock_movement_requests WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM canonical_stock_movements WHERE company_id = $1", [ctx.companyId]);
    await pool.query(
      `DELETE FROM factory_bale_production_attributions WHERE bale_id IN
       (SELECT id FROM factory_bales WHERE company_id = $1)`, [ctx.companyId]
    );
    await pool.query("DELETE FROM factory_bales WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_bale_sequences WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_bale_products WHERE company_id = $1", [ctx.companyId]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 90000);

describe("Phase 5: atomic existing-bale print and reprint", () => {
  it("rejects an invalid reference without partially allocating earlier items", async () => {
    expect((await agent.put(MODE).send({ enabled: true })).status).toBe(200);
    const res = await agent.post(BATCH).send({
      items: [batchInput(firstBale), { referenceNumber: "NO-SUCH-REF" }],
    });
    expect(res.status).toBe(400);
    expect(await allocations()).toBe(0);
    expect(await history()).toBe(0);
  }, 60000);

  it("allocates only the first eligible bale in a mixed matching/no-capacity batch", async () => {
    const res = await agent.post(BATCH).send({
      items: [batchInput(firstBale), batchInput(secondBale)],
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].priorityAllocation).toMatchObject({
      orderId, baleId: firstBale.id, color: "#dc2626",
      priority: 1, source: "reprint", existing: false,
    });
    expect(res.body.results[1].priorityAllocation).toBeNull();
    expect(await allocations()).toBe(1);
    expect(await history()).toBe(1);
  }, 60000);

  it("repeated print / reprint returns the same original loading without duplicate scans", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await agent.post(BATCH).send({
        items: [batchInput(firstBale), batchInput(firstBale)],
      });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].priorityAllocation).toMatchObject({
        orderId, color: "#dc2626", priority: 1, existing: true,
      });
    }
    expect(await allocations()).toBe(1);
    expect(await history()).toBe(1);
  }, 60000);

  it("retains color when mode is OFF; never automatically loads the other bale", async () => {
    expect((await agent.put(MODE).send({ enabled: false })).status).toBe(200);
    const res = await agent.post(BATCH).send({
      items: [batchInput(firstBale), batchInput(secondBale)],
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0].priorityAllocation).toMatchObject({
      orderId, color: "#dc2626", priority: 1, existing: true,
    });
    expect(res.body.results[1].priorityAllocation).toBeNull();
    expect(await allocations()).toBe(1);
    expect(await history()).toBe(1);
  }, 60000);

  it("validates both bale ID and reference before rendering and isolates other companies", async () => {
    const mismatch = await agent.post(BATCH).send({
      items: [{ baleId: firstBale.id, referenceNumber: secondBale.referenceNumber }],
    });
    expect(mismatch.status).toBe(400);
    const missing = await agent.post(BATCH).send({
      items: [{ baleId: 2147483647 }],
    });
    expect(missing.status).toBe(400);
    expect(await allocations()).toBe(1);
  }, 60000);
});
