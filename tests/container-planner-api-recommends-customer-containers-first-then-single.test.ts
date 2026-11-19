import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ctplan7";
const ARTICLE_A = "CTP7-A";
const ARTICLE_B = "CTP7-B";

type Suggestion = {
  capacity: number;
  containerCount: number;
  totalBales: number;
  plannedFromDemand: number;
  plannedFromFreeStock: number;
  customerContainers: number;
  singleProductContainers: number;
  mixedContainers: number;
  averageFillPercent: number;
  unservedDemand: Array<{ customerId: number; shortfallQty: number }>;
  containers: Array<{
    label: string;
    kind: string;
    customerId: number | null;
    totalBales: number;
    lines: Array<{ articleCode: string; qty: number }>;
  }>;
};

let ctx: TestContext;
let agent: request.SuperAgentTest;
let planId: number | null = null;
let customerId: number | null = null;
let proformaId: number | null = null;
let orderId: number | null = null;
let baleSequence = 0;

async function addBales(articleCode: string, quantity: number): Promise<void> {
  for (let index = 0; index < quantity; index += 1) {
    baleSequence += 1;
    const baleCode = `${TEST_PREFIX}-${articleCode}-${String(baleSequence).padStart(3, "0")}`;
    await pool.query(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, article_code, product_name,
          erp_location_id, weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, $2, $3, $4, $5, '25.000', '1.0000000', '25.0000000', 'IN_STOCK')`,
      [ctx.companyId, baleCode, articleCode, `${articleCode} Product`, ctx.locationId]
    );
  }
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  expect(
    (
      await agent.post("/api/auth/login").send({
        username: `${TEST_PREFIX}_testuser`,
        password: "testpassword123",
      })
    ).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  await addBales(ARTICLE_A, 10);
  await addBales(ARTICLE_B, 6);

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C`, `${TEST_PREFIX} Customer`]
  );
  customerId = Number(customer.rows[0].id);

  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [ctx.companyId, customerId, `${TEST_PREFIX} proforma`]
  );
  proformaId = Number(proforma.rows[0].id);
  await pool.query(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, $2, $3, 8, '10.00')`,
    [proformaId, ARTICLE_A, `${ARTICLE_A} Product`]
  );
  const order = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, '2026-09-22', 'DRAFT', $3) RETURNING id`,
    [ctx.companyId, customerId, proformaId]
  );
  orderId = Number(order.rows[0].id);

  const created = await agent.post("/api/factory/v5/container-plans").send({
    name: "Phase 7 Optimization Plan",
    capacityBales: 4,
    includeGarbageWipers: false,
    clientRequestId: "ctplan7-initial",
  });
  expect(created.status).toBe(201);
  planId = Number(created.body.plan.id);
}, 120_000);

afterAll(async () => {
  if (planId) {
    await pool.query("DELETE FROM factory_container_plans WHERE id = $1 AND company_id = $2", [planId, ctx.companyId]);
  }
  if (orderId) {
    await pool.query("DELETE FROM customer_order_expected_lines WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM customer_order_lines WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM customer_orders WHERE id = $1", [orderId]);
  }
  if (proformaId) {
    await pool.query("DELETE FROM customer_proforma_lines WHERE proforma_id = $1", [proformaId]);
    await pool.query("DELETE FROM customer_proformas WHERE id = $1", [proformaId]);
  }
  await pool.query("DELETE FROM factory_bales WHERE company_id = $1 AND article_code = ANY($2::text[])", [
    ctx.companyId,
    [ARTICLE_A, ARTICLE_B],
  ]);
  if (customerId) await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Factory container planner phase 7 API", () => {
  it("recommends customer containers first, then single-product, then a mixed tail", async () => {
    const response = await agent
      .post("/api/factory/v5/container-plans/optimize")
      .send({ capacityBales: 4, includeGarbageWipers: false });
    expect(response.status).toBe(200);

    const suggestion = response.body.suggestion as Suggestion;
    expect(suggestion.capacity).toBe(4);
    expect(suggestion.totalBales).toBe(16);
    expect(suggestion.plannedFromDemand).toBe(8);
    expect(suggestion.plannedFromFreeStock).toBe(8);
    expect(suggestion.containerCount).toBe(4);
    expect(suggestion.customerContainers).toBe(2);
    expect(suggestion.unservedDemand).toHaveLength(0);

    const customerContainers = suggestion.containers.filter((container) => container.kind === "CUSTOMER");
    expect(customerContainers.every((container) => container.customerId === customerId)).toBe(true);
    expect(customerContainers.every((container) => container.lines[0].articleCode === ARTICLE_A)).toBe(true);
  });

  it("plans only free stock when committed demand is excluded", async () => {
    const response = await agent
      .post("/api/factory/v5/container-plans/optimize")
      .send({ capacityBales: 4, includeCommittedDemand: false });
    expect(response.status).toBe(200);

    const suggestion = response.body.suggestion as Suggestion;
    expect(suggestion.plannedFromDemand).toBe(0);
    expect(suggestion.totalBales).toBe(8);
    expect(suggestion.customerContainers).toBe(0);
  });

  it("rejects an invalid capacity", async () => {
    const response = await agent.post("/api/factory/v5/container-plans/optimize").send({ capacityBales: 0 });
    expect(response.status).toBe(400);
  });

  it("applies the layout to a clean draft plan", async () => {
    const applied = await agent.post(`/api/factory/v5/container-plans/${planId}/optimize/apply`).send({});
    expect(applied.status).toBe(200);
    expect(applied.body.suggestion.containerCount).toBe(4);

    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    expect(detail.status).toBe(200);
    const containers = detail.body.plan.containers as Array<{
      name: string;
      totalBales: number;
      lines: Array<{ articleCode: string }>;
    }>;
    expect(containers).toHaveLength(4);
    expect(detail.body.plan.totalPlanned).toBe(16);
    expect(containers[0].name).toContain(`${TEST_PREFIX} Customer`);
    // A dedicated customer container holds one product, unlike the even spread
    // the planner starts from.
    expect(containers[0].lines).toHaveLength(1);
  }, 60_000);

  it("refuses to rebuild a plan whose containers are already committed", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const container = detail.body.plan.containers[0];

    expect(
      (
        await agent
          .post(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/bales`)
          .send({ auto: true })
      ).status
    ).toBe(200);

    const blocked = await agent.post(`/api/factory/v5/container-plans/${planId}/optimize/apply`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("CONTAINER_PLAN_NOT_OPTIMIZABLE");
    expect(blocked.body.blockers.assigned).toBeGreaterThan(0);

    // Releasing the assignments makes the plan optimizable again.
    expect(
      (
        await agent
          .delete(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/bales`)
          .send({ all: true })
      ).status
    ).toBe(200);
    expect((await agent.post(`/api/factory/v5/container-plans/${planId}/optimize/apply`).send({})).status).toBe(200);
  }, 60_000);
});
