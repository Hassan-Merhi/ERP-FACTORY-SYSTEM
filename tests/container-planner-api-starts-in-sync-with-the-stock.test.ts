import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ctplan3";
const ARTICLE_A = "CTP3-A";
const ARTICLE_B = "CTP3-B";

type PlanLine = {
  articleCode: string;
  plannedQty: number;
};

type PlanContainer = {
  id: number;
  isLocked: boolean;
  totalBales: number;
  capacityBales: number;
  lines: PlanLine[];
};

type PlanDetail = {
  id: number;
  revision: number;
  containers: PlanContainer[];
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

function productTotal(plan: PlanDetail, articleCode: string): number {
  return plan.containers
    .flatMap((container) => container.lines)
    .filter((line) => line.articleCode === articleCode)
    .reduce((sum, line) => sum + Number(line.plannedQty || 0), 0);
}

async function createCustomerCommitment(quantity: number): Promise<void> {
  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C`, `${TEST_PREFIX} Customer`]
  );
  customerId = Number(customer.rows[0].id);

  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, true)
     RETURNING id`,
    [ctx.companyId, customerId, `${TEST_PREFIX} commitment`]
  );
  proformaId = Number(proforma.rows[0].id);

  await pool.query(
    `INSERT INTO customer_proforma_lines
       (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, $2, $3, $4, '10.00')`,
    [proformaId, ARTICLE_A, `${ARTICLE_A} Product`, quantity]
  );

  const order = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders
       (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, '2026-09-21', 'DRAFT', $3)
     RETURNING id`,
    [ctx.companyId, customerId, proformaId]
  );
  orderId = Number(order.rows[0].id);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  await addBales(ARTICLE_A, 8);
  await addBales(ARTICLE_B, 4);

  const created = await agent.post("/api/factory/v5/container-plans").send({
    name: "Phase 3 Reconciliation Plan",
    capacityBales: 5,
    includeGarbageWipers: false,
    clientRequestId: "ctplan3-initial",
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
  if (customerId) {
    await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
  }
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Factory container planner phase 3 API", () => {
  it("starts in sync with the stock snapshot used to save the plan", async () => {
    expect(planId).not.toBeNull();

    const response = await agent.get(`/api/factory/v5/container-plans/${planId}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body.reconciliation.status).toBe("IN_SYNC");
    expect(response.body.reconciliation.currentPlannableTotal).toBe(12);
    expect(response.body.reconciliation.plannedTotal).toBe(12);
    expect(response.body.reconciliation.unplannedTotal).toBe(0);
    expect(response.body.reconciliation.overplannedTotal).toBe(0);
  });

  it("detects newly produced stock and adds only the unlocked capacity needed", async () => {
    expect(planId).not.toBeNull();
    await addBales(ARTICLE_A, 5);

    const drift = await agent.get(`/api/factory/v5/container-plans/${planId}/reconciliation`);
    expect(drift.status).toBe(200);
    expect(drift.body.reconciliation.status).toBe("DRIFT");
    expect(drift.body.reconciliation.unplannedTotal).toBe(5);
    expect(drift.body.reconciliation.overplannedTotal).toBe(0);

    const reconciled = await agent.post(`/api/factory/v5/container-plans/${planId}/reconcile`).send({});
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.reconciliation.status).toBe("IN_SYNC");
    expect(reconciled.body.addedContainers).toBe(1);
    expect(reconciled.body.removedContainers).toBe(0);

    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    expect(detail.status).toBe(200);
    const plan = detail.body.plan as PlanDetail;
    expect(plan.containers).toHaveLength(4);
    expect(plan.containers.every((container) => container.totalBales <= container.capacityBales)).toBe(true);
    expect(productTotal(plan, ARTICLE_A)).toBe(13);
    expect(productTotal(plan, ARTICLE_B)).toBe(4);
  }, 60_000);

  it("blocks reconciliation when a locked container now exceeds current free stock", async () => {
    expect(planId).not.toBeNull();

    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    expect(detail.status).toBe(200);
    const plan = detail.body.plan as PlanDetail;
    const lockTarget = plan.containers.find((container) =>
      container.lines.some((line) => line.articleCode === ARTICLE_A && line.plannedQty > 0)
    );
    expect(lockTarget).toBeTruthy();

    const locked = await agent
      .patch(`/api/factory/v5/container-plans/${planId}/containers/${lockTarget!.id}/lock`)
      .send({ isLocked: true });
    expect(locked.status).toBe(200);

    await createCustomerCommitment(12);

    const drift = await agent.get(`/api/factory/v5/container-plans/${planId}/reconciliation`);
    expect(drift.status).toBe(200);
    expect(drift.body.reconciliation.status).toBe("LOCKED_CONFLICT");
    expect(drift.body.reconciliation.lockedConflictTotal).toBeGreaterThan(0);
    expect(drift.body.reconciliation.overplannedTotal).toBeGreaterThan(0);

    const revisionBefore = Number((await agent.get(`/api/factory/v5/container-plans/${planId}`)).body.plan.revision);
    const rejected = await agent.post(`/api/factory/v5/container-plans/${planId}/reconcile`).send({});
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe("CONTAINER_PLAN_LOCKED_STOCK_CONFLICT");

    const afterRejected = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    expect(Number(afterRejected.body.plan.revision)).toBe(revisionBefore);
  }, 60_000);

  it("reconciles after unlock, removes excess unlocked containers, and leaves operational stock untouched", async () => {
    expect(planId).not.toBeNull();

    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const plan = detail.body.plan as PlanDetail;
    const lockedContainer = plan.containers.find((container) => container.isLocked);
    expect(lockedContainer).toBeTruthy();

    const unlocked = await agent
      .patch(`/api/factory/v5/container-plans/${planId}/containers/${lockedContainer!.id}/lock`)
      .send({ isLocked: false });
    expect(unlocked.status).toBe(200);

    const reconciled = await agent.post(`/api/factory/v5/container-plans/${planId}/reconcile`).send({});
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.reconciliation.status).toBe("IN_SYNC");
    expect(reconciled.body.removedContainers).toBe(3);

    const after = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    expect(after.status).toBe(200);
    const finalPlan = after.body.plan as PlanDetail;
    expect(finalPlan.containers).toHaveLength(1);
    expect(finalPlan.containers[0].totalBales).toBe(5);
    expect(productTotal(finalPlan, ARTICLE_A)).toBe(1);
    expect(productTotal(finalPlan, ARTICLE_B)).toBe(4);

    const [expectedLines, order, baleStatuses] = await Promise.all([
      pool.query("SELECT id FROM customer_order_expected_lines WHERE order_id = $1", [orderId]),
      pool.query<{ status: string }>("SELECT status FROM customer_orders WHERE id = $1", [orderId]),
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count
         FROM factory_bales
         WHERE company_id = $1 AND article_code = ANY($2::text[])
         GROUP BY status`,
        [ctx.companyId, [ARTICLE_A, ARTICLE_B]]
      ),
    ]);

    expect(expectedLines.rowCount).toBe(0);
    expect(order.rows[0]?.status).toBe("DRAFT");
    expect(baleStatuses.rows).toEqual([{ status: "IN_STOCK", count: "17" }]);
  }, 60_000);
});
