import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ctplan5";
const ARTICLE_A = "CTP5-A";

type AllocationSummary = {
  plannedTotal: number;
  allocatedTotal: number;
  unallocatedTotal: number;
  demandTotal: number;
  outstandingDemandTotal: number;
  containers: Array<{
    containerId: number;
    plannedQty: number;
    allocatedQty: number;
    unallocatedQty: number;
    isFullyAllocated: boolean;
    customers: Array<{ customerId: number; allocatedQty: number }>;
  }>;
  customers: Array<{
    customerId: number;
    demandQty: number;
    allocatedQty: number;
    outstandingQty: number;
    containerCount: number;
  }>;
};

let ctx: TestContext;
let agent: request.SuperAgentTest;
let planId: number | null = null;
let customerId: number | null = null;
let secondCustomerId: number | null = null;
let proformaId: number | null = null;
let orderId: number | null = null;
let baleSequence = 0;

async function addBales(quantity: number): Promise<void> {
  for (let index = 0; index < quantity; index += 1) {
    baleSequence += 1;
    const baleCode = `${TEST_PREFIX}-${String(baleSequence).padStart(3, "0")}`;
    await pool.query(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, article_code, product_name,
          erp_location_id, weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, $2, $3, $4, $5, '25.000', '1.0000000', '25.0000000', 'IN_STOCK')`,
      [ctx.companyId, baleCode, ARTICLE_A, `${ARTICLE_A} Product`, ctx.locationId]
    );
  }
}

async function createCustomer(suffix: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-${suffix}`, `${TEST_PREFIX} Customer ${suffix}`]
  );
  return Number(result.rows[0].id);
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

  // 8 bales of one product become two planned containers of 4.
  await addBales(8);

  customerId = await createCustomer("A");
  secondCustomerId = await createCustomer("B");

  const created = await agent.post("/api/factory/v5/container-plans").send({
    name: "Phase 5 Customer Allocation Plan",
    capacityBales: 4,
    includeGarbageWipers: false,
    clientRequestId: "ctplan5-initial",
  });
  expect(created.status).toBe(201);
  planId = Number(created.body.plan.id);

  // A committed order for 6 bales, created after the plan so the plan's own
  // quantities stay at 8.
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, true)
     RETURNING id`,
    [ctx.companyId, customerId, `${TEST_PREFIX} proforma`]
  );
  proformaId = Number(proforma.rows[0].id);
  await pool.query(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, $2, $3, 6, '10.00')`,
    [proformaId, ARTICLE_A, `${ARTICLE_A} Product`]
  );
  const order = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, '2026-09-22', 'DRAFT', $3)
     RETURNING id`,
    [ctx.companyId, customerId, proformaId]
  );
  orderId = Number(order.rows[0].id);
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
  await pool.query("DELETE FROM factory_bales WHERE company_id = $1 AND article_code = $2", [ctx.companyId, ARTICLE_A]);
  for (const id of [customerId, secondCustomerId]) {
    if (id) await pool.query("DELETE FROM customers WHERE id = $1", [id]);
  }
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Factory container planner phase 5 API", () => {
  it("starts with nothing allocated and surfaces the outstanding order demand", async () => {
    const response = await agent.get(`/api/factory/v5/container-plans/${planId}/allocations`);
    expect(response.status).toBe(200);

    const summary = response.body.summary as AllocationSummary;
    expect(summary.plannedTotal).toBe(8);
    expect(summary.allocatedTotal).toBe(0);
    expect(summary.unallocatedTotal).toBe(8);
    expect(summary.demandTotal).toBe(6);
    expect(summary.outstandingDemandTotal).toBe(6);
  });

  it("splits one customer order across two containers", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const [first, second] = detail.body.plan.containers;

    const firstLeg = await agent
      .put(`/api/factory/v5/container-plans/${planId}/containers/${first.id}/allocations`)
      .send({ customerId, orderId, lines: [{ articleCode: ARTICLE_A, qty: 4 }] });
    expect(firstLeg.status).toBe(200);
    expect(firstLeg.body.rejected).toHaveLength(0);

    const secondLeg = await agent
      .put(`/api/factory/v5/container-plans/${planId}/containers/${second.id}/allocations`)
      .send({ customerId, orderId, lines: [{ articleCode: ARTICLE_A, qty: 2 }] });
    expect(secondLeg.status).toBe(200);

    const summary = secondLeg.body.summary as AllocationSummary;
    expect(summary.allocatedTotal).toBe(6);
    expect(summary.unallocatedTotal).toBe(2);
    expect(summary.outstandingDemandTotal).toBe(0);

    const customer = summary.customers.find((entry) => entry.customerId === customerId);
    expect(customer?.allocatedQty).toBe(6);
    expect(customer?.containerCount).toBe(2);
  });

  it("refuses an allocation beyond what the order still needs", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const second = detail.body.plan.containers[1];

    const response = await agent
      .put(`/api/factory/v5/container-plans/${planId}/containers/${second.id}/allocations`)
      .send({ customerId, orderId, lines: [{ articleCode: ARTICLE_A, qty: 4 }] });

    expect(response.status).toBe(409);
    expect(response.body.rejected[0].reason).toBe("ORDER_DEMAND_EXCEEDED");
  });

  it("lets a second customer take the container's remaining free quantity but no more", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const second = detail.body.plan.containers[1];

    const tooMuch = await agent
      .put(`/api/factory/v5/container-plans/${planId}/containers/${second.id}/allocations`)
      .send({ customerId: secondCustomerId, lines: [{ articleCode: ARTICLE_A, qty: 3 }] });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.rejected[0].reason).toBe("CONTAINER_QUANTITY_EXCEEDED");

    const fits = await agent
      .put(`/api/factory/v5/container-plans/${planId}/containers/${second.id}/allocations`)
      .send({ customerId: secondCustomerId, lines: [{ articleCode: ARTICLE_A, qty: 2 }] });
    expect(fits.status).toBe(200);

    const summary = fits.body.summary as AllocationSummary;
    expect(summary.unallocatedTotal).toBe(0);
    const container = summary.containers.find((entry) => entry.containerId === second.id);
    expect(container?.isFullyAllocated).toBe(true);
    expect(container?.customers).toHaveLength(2);
  });

  it("builds a packing list with each customer's own bales once they are assigned", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    for (const container of detail.body.plan.containers) {
      expect(
        (
          await agent
            .post(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/bales`)
            .send({ auto: true })
        ).status
      ).toBe(200);
    }

    const first = await agent.get(`/api/factory/v5/container-plans/${planId}/customers/${customerId}/packing-list`);
    expect(first.status).toBe(200);
    expect(first.body.totalQty).toBe(6);
    expect(first.body.containers).toHaveLength(2);
    expect(first.body.totalWeightKg).toBe(150);

    const second = await agent
      .get(`/api/factory/v5/container-plans/${planId}/customers/${secondCustomerId}/packing-list`);
    expect(second.status).toBe(200);
    expect(second.body.totalQty).toBe(2);

    const firstCodes = first.body.containers.flatMap((container: { lines: Array<{ baleCodes: string[] }> }) =>
      container.lines.flatMap((line) => line.baleCodes)
    );
    const secondCodes = second.body.containers.flatMap((container: { lines: Array<{ baleCodes: string[] }> }) =>
      container.lines.flatMap((line) => line.baleCodes)
    );
    expect(firstCodes).toHaveLength(6);
    expect(secondCodes).toHaveLength(2);
    expect(new Set([...firstCodes, ...secondCodes]).size).toBe(8);
  }, 60_000);

  it("records every allocation change in the plan's history", async () => {
    const response = await agent.get(`/api/factory/v5/container-plans/${planId}/allocation-history`);
    expect(response.status).toBe(200);
    expect(response.body.history.length).toBeGreaterThanOrEqual(3);
    expect(response.body.history[0].changes).toHaveProperty("allocation");
  });

  it("releases a customer's reservation on one container", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const second = detail.body.plan.containers[1];

    const response = await agent.delete(
      `/api/factory/v5/container-plans/${planId}/containers/${second.id}/allocations/${secondCustomerId}`
    );
    expect(response.status).toBe(200);
    expect(response.body.released).toBe(1);

    const summary = response.body.summary as AllocationSummary;
    expect(summary.allocatedTotal).toBe(6);
    expect(summary.customers.some((entry) => entry.customerId === secondCustomerId)).toBe(false);

    const repeat = await agent.delete(
      `/api/factory/v5/container-plans/${planId}/containers/${second.id}/allocations/${secondCustomerId}`
    );
    expect(repeat.status).toBe(404);
  });

  it("trims allocations that a reconcile can no longer honour", async () => {
    const before = (await agent.get(`/api/factory/v5/container-plans/${planId}/allocations`)).body
      .summary as AllocationSummary;
    expect(before.allocatedTotal).toBe(6);

    // The order now commits 3 more bales, so the plannable pool drops from 8 to
    // 5 and Phase 3 re-spreads it as 3 + 2. The 4-bale allocation on the first
    // container no longer fits and must be trimmed rather than silently kept.
    await pool.query(
      `UPDATE customer_proforma_lines SET quantity = 3 WHERE proforma_id = $1 AND article_code = $2`,
      [proformaId, ARTICLE_A]
    );

    const reconciled = await agent.post(`/api/factory/v5/container-plans/${planId}/reconcile`).send({});
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.adjustedAllocations).toBeGreaterThan(0);

    const after = (await agent.get(`/api/factory/v5/container-plans/${planId}/allocations`)).body
      .summary as AllocationSummary;
    expect(after.allocatedTotal).toBe(5);
    expect(after.allocatedTotal).toBeLessThan(before.allocatedTotal);
    for (const container of after.containers) {
      expect(container.allocatedQty).toBeLessThanOrEqual(container.plannedQty);
    }
  }, 60_000);
});
