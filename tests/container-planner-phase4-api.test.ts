import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ctplan4";
const ARTICLE_A = "CTP4-A";
const ARTICLE_B = "CTP4-B";

type AssignmentSummaryContainer = {
  containerId: number;
  plannedQty: number;
  assignedQty: number;
  remainingQty: number;
  isFullyAssigned: boolean;
  products: Array<{ articleCode: string; plannedQty: number; assignedQty: number; remainingQty: number }>;
};

type AssignmentSummary = {
  plannedTotal: number;
  assignedTotal: number;
  remainingTotal: number;
  isPlanFullyAssigned: boolean;
  containers: AssignmentSummaryContainer[];
};

let ctx: TestContext;
let agent: request.SuperAgentTest;
let planId: number | null = null;
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

async function baleIdsFor(articleCode: string, limit: number): Promise<number[]> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM factory_bales
     WHERE company_id = $1 AND article_code = $2
     ORDER BY id
     LIMIT $3`,
    [ctx.companyId, articleCode, limit]
  );
  return result.rows.map((row) => Number(row.id));
}

async function baleCodeFor(articleCode: string): Promise<string> {
  const result = await pool.query<{ bale_code: string }>(
    `SELECT bale_code FROM factory_bales
     WHERE company_id = $1 AND article_code = $2
     ORDER BY id DESC
     LIMIT 1`,
    [ctx.companyId, articleCode]
  );
  return String(result.rows[0].bale_code);
}

function containerSummary(summary: AssignmentSummary, containerId: number): AssignmentSummaryContainer {
  const container = summary.containers.find((entry) => entry.containerId === containerId);
  expect(container).toBeTruthy();
  return container!;
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

  await addBales(ARTICLE_A, 6);
  await addBales(ARTICLE_B, 2);

  const created = await agent.post("/api/factory/v5/container-plans").send({
    name: "Phase 4 Bale Assignment Plan",
    capacityBales: 4,
    includeGarbageWipers: false,
    clientRequestId: "ctplan4-initial",
  });
  expect(created.status).toBe(201);
  planId = Number(created.body.plan.id);
}, 120_000);

afterAll(async () => {
  if (planId) {
    await pool.query("DELETE FROM factory_container_plans WHERE id = $1 AND company_id = $2", [planId, ctx.companyId]);
  }
  await pool.query("DELETE FROM factory_bales WHERE company_id = $1 AND article_code = ANY($2::text[])", [
    ctx.companyId,
    [ARTICLE_A, ARTICLE_B],
  ]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Factory container planner phase 4 API", () => {
  it("starts with nothing physically assigned and reports all stock as unassigned", async () => {
    const response = await agent.get(`/api/factory/v5/container-plans/${planId}/bales`);
    expect(response.status).toBe(200);

    const summary = response.body.summary as AssignmentSummary;
    expect(summary.plannedTotal).toBe(8);
    expect(summary.assignedTotal).toBe(0);
    expect(summary.remainingTotal).toBe(8);
    expect(summary.isPlanFullyAssigned).toBe(false);
    expect(summary.containers).toHaveLength(2);

    const unassigned = response.body.unassignedStock as Array<{ articleCode: string; qty: number }>;
    expect(unassigned.find((row) => row.articleCode === ARTICLE_A)?.qty).toBe(6);
    expect(unassigned.find((row) => row.articleCode === ARTICLE_B)?.qty).toBe(2);
  });

  it("offers only unreserved in-stock bales as candidates", async () => {
    const response = await agent
      .get(`/api/factory/v5/container-plans/${planId}/bale-candidates`)
      .query({ articleCode: ARTICLE_A, limit: 50 });
    expect(response.status).toBe(200);
    expect(response.body.candidates).toHaveLength(6);
    expect(response.body.candidates.every((row: { status: string }) => row.status === "IN_STOCK")).toBe(true);
  });

  it("assigns selected bales and rejects anything over the planned quantity", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const container = detail.body.plan.containers[0];
    const plannedA = container.lines.find((line: { articleCode: string }) => line.articleCode === ARTICLE_A).plannedQty;

    const ids = await baleIdsFor(ARTICLE_A, plannedA + 1);
    const response = await agent
      .post(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/bales`)
      .send({ baleIds: ids });

    expect(response.status).toBe(200);
    expect(response.body.assigned).toHaveLength(plannedA);
    expect(response.body.rejected).toHaveLength(1);
    expect(response.body.rejected[0].reason).toBe("PRODUCT_QUOTA_EXCEEDED");

    const summary = response.body.summary as AssignmentSummary;
    const progress = containerSummary(summary, container.id);
    expect(progress.products.find((product) => product.articleCode === ARTICLE_A)?.assignedQty).toBe(plannedA);
  });

  it("reserves an assigned bale so no other container can take it", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const [first, second] = detail.body.plan.containers;

    const taken = await pool.query<{ bale_id: number }>(
      `SELECT bale_id FROM factory_container_plan_bales
       WHERE company_id = $1 AND plan_container_id = $2
       ORDER BY id
       LIMIT 1`,
      [ctx.companyId, first.id]
    );
    const baleId = Number(taken.rows[0].bale_id);

    const response = await agent
      .post(`/api/factory/v5/container-plans/${planId}/containers/${second.id}/bales`)
      .send({ baleIds: [baleId] });

    expect(response.status).toBe(200);
    expect(response.body.assigned).toHaveLength(0);
    expect(response.body.rejected[0].reason).toBe("ASSIGNED_TO_OTHER_CONTAINER");

    const candidates = await agent
      .get(`/api/factory/v5/container-plans/${planId}/bale-candidates`)
      .query({ articleCode: ARTICLE_A, limit: 50 });
    expect(candidates.body.candidates.some((row: { id: number }) => row.id === baleId)).toBe(false);
  });

  it("resolves a scanned barcode and assigns it by code", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const container = detail.body.plan.containers.find((entry: { lines: Array<{ articleCode: string }> }) =>
      entry.lines.some((line) => line.articleCode === ARTICLE_B)
    );
    const code = await baleCodeFor(ARTICLE_B);

    const scan = await agent.get(`/api/factory/v5/container-plans/${planId}/bale-scan`).query({ code });
    expect(scan.status).toBe(200);
    expect(scan.body.found).toBe(true);
    expect(scan.body.bale.articleCode).toBe(ARTICLE_B);
    expect(scan.body.bale.assignedContainerId).toBeNull();

    const assigned = await agent
      .post(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/bales`)
      .send({ baleCodes: [code.toLowerCase()] });
    expect(assigned.status).toBe(200);
    expect(assigned.body.assignedVia).toBe("SCAN");
    expect(assigned.body.assigned).toHaveLength(1);

    const rescan = await agent.get(`/api/factory/v5/container-plans/${planId}/bale-scan`).query({ code });
    expect(rescan.body.bale.assignedContainerId).toBe(container.id);
  });

  it("auto-fills every container to its planned quantity", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    let summary: AssignmentSummary | null = null;

    for (const container of detail.body.plan.containers) {
      const response = await agent
        .post(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/bales`)
        .send({ auto: true });
      expect(response.status).toBe(200);
      expect(response.body.assignedVia).toBe("AUTO");
      summary = response.body.summary as AssignmentSummary;
    }

    expect(summary).toBeTruthy();
    expect(summary!.remainingTotal).toBe(0);
    expect(summary!.assignedTotal).toBe(8);
    expect(summary!.isPlanFullyAssigned).toBe(true);
    expect(summary!.containers.every((container) => container.isFullyAssigned)).toBe(true);

    const bales = await agent.get(`/api/factory/v5/container-plans/${planId}/bales`);
    expect(bales.body.unassignedStock).toHaveLength(0);
  }, 60_000);

  it("leaves physical bale status untouched so the V5 stock picture does not move", async () => {
    const statuses = await pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM factory_bales
       WHERE company_id = $1 AND article_code = ANY($2::text[])
       GROUP BY status`,
      [ctx.companyId, [ARTICLE_A, ARTICLE_B]]
    );
    expect(statuses.rows).toEqual([{ status: "IN_STOCK", count: "8" }]);

    const reconciliation = await agent.get(`/api/factory/v5/container-plans/${planId}/reconciliation`);
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body.reconciliation.status).toBe("IN_SYNC");
  });

  it("refuses assignment and release while the container is locked", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const container = detail.body.plan.containers[0];

    expect(
      (
        await agent
          .patch(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/lock`)
          .send({ isLocked: true })
      ).status
    ).toBe(200);

    const assign = await agent
      .post(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/bales`)
      .send({ auto: true });
    expect(assign.status).toBe(409);

    const release = await agent
      .delete(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/bales`)
      .send({ all: true });
    expect(release.status).toBe(409);

    expect(
      (
        await agent
          .patch(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/lock`)
          .send({ isLocked: false })
      ).status
    ).toBe(200);
  });

  it("releases bales back into unassigned stock", async () => {
    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    const container = detail.body.plan.containers[0];

    const response = await agent
      .delete(`/api/factory/v5/container-plans/${planId}/containers/${container.id}/bales`)
      .send({ all: true });
    expect(response.status).toBe(200);
    expect(response.body.released).toBe(container.totalBales);

    const summary = response.body.summary as AssignmentSummary;
    expect(containerSummary(summary, container.id).assignedQty).toBe(0);
    expect(summary.isPlanFullyAssigned).toBe(false);

    const bales = await agent.get(`/api/factory/v5/container-plans/${planId}/bales`);
    const unassignedTotal = (bales.body.unassignedStock as Array<{ qty: number }>).reduce(
      (sum, row) => sum + row.qty,
      0
    );
    expect(unassignedTotal).toBe(container.totalBales);
  });

  it("never lets a reconcile leave a container holding more bales than it now plans", async () => {
    // Refill the container emptied by the previous test so the whole plan is
    // physically assigned again.
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

    const before = (await agent.get(`/api/factory/v5/container-plans/${planId}/bales`)).body
      .summary as AssignmentSummary;
    expect(before.isPlanFullyAssigned).toBe(true);

    // New production forces Phase 3 to add a container and re-spread the
    // quantities, which changes every container's per-product quota.
    await addBales(ARTICLE_A, 4);
    const reconciled = await agent.post(`/api/factory/v5/container-plans/${planId}/reconcile`).send({});
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.reconciliation.status).toBe("IN_SYNC");
    expect(reconciled.body.releasedBales).toBeGreaterThanOrEqual(0);

    const after = (await agent.get(`/api/factory/v5/container-plans/${planId}/bales`)).body
      .summary as AssignmentSummary;
    expect(after.assignedTotal).toBe(before.assignedTotal - reconciled.body.releasedBales);
    for (const container of after.containers) {
      expect(container.assignedQty).toBeLessThanOrEqual(container.plannedQty);
      for (const product of container.products) {
        expect(product.assignedQty).toBeLessThanOrEqual(product.plannedQty);
      }
    }

    // Every released bale is immediately available again, and none was lost.
    const bales = await agent.get(`/api/factory/v5/container-plans/${planId}/bales`);
    const assignedRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM factory_container_plan_bales WHERE company_id = $1 AND plan_id = $2`,
      [ctx.companyId, planId]
    );
    expect(Number(assignedRows.rows[0].count)).toBe(after.assignedTotal);
    const unassignedTotal = (bales.body.unassignedStock as Array<{ qty: number }>).reduce(
      (sum, row) => sum + row.qty,
      0
    );
    expect(unassignedTotal).toBe(12 - after.assignedTotal);
  }, 60_000);
});
