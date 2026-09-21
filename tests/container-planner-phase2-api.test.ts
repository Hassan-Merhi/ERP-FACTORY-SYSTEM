import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ctplan2";
const ARTICLE_A = "CTP2-A";
const ARTICLE_B = "CTP2-B";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let planId: number | null = null;

async function addBales(articleCode: string, quantity: number): Promise<void> {
  for (let index = 1; index <= quantity; index += 1) {
    const baleCode = `${articleCode}-${String(index).padStart(2, "0")}`;
    await pool.query(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, article_code, product_name,
          erp_location_id, weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, $2, $3, $4, $5, '25.000', '1.0000000', '25.0000000', 'IN_STOCK')`,
      [ctx.companyId, baleCode, articleCode, `${articleCode} Product`, ctx.locationId]
    );
  }
}

function productTotal(plan: any, articleCode: string): number {
  return plan.containers
    .flatMap((container: any) => container.lines)
    .filter((line: any) => line.articleCode === articleCode)
    .reduce((sum: number, line: any) => sum + Number(line.plannedQty || 0), 0);
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

  await addBales(ARTICLE_A, 10);
  await addBales(ARTICLE_B, 10);
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

describe("Factory container planner phase 2 API", () => {
  it("saves the authoritative preview once even when the create request is retried", async () => {
    const payload = {
      name: "Phase 2 Integration Plan",
      capacityBales: 6,
      includeGarbageWipers: false,
      clientRequestId: "ctplan2-idempotency-key",
    };

    const created = await agent.post("/api/factory/v5/container-plans").send(payload);
    expect(created.status).toBe(201);
    expect(created.body.plan.name).toBe(payload.name);
    expect(created.body.plan.totalPlanned).toBe(20);
    expect(created.body.plan.containers).toHaveLength(4);
    expect(created.body.plan.containers.every((container: any) => container.totalBales <= 6)).toBe(true);
    expect(productTotal(created.body.plan, ARTICLE_A)).toBe(10);
    expect(productTotal(created.body.plan, ARTICLE_B)).toBe(10);

    planId = Number(created.body.plan.id);

    const retried = await agent.post("/api/factory/v5/container-plans").send(payload);
    expect(retried.status).toBe(200);
    expect(retried.body.duplicate).toBe(true);
    expect(Number(retried.body.plan.id)).toBe(planId);

    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM factory_container_plans WHERE company_id = $1 AND client_request_id = $2",
      [ctx.companyId, payload.clientRequestId]
    );
    expect(Number(count.rows[0]?.count ?? 0)).toBe(1);
  }, 60_000);

  it("moves quantities between unlocked containers without changing product totals", async () => {
    expect(planId).not.toBeNull();

    const before = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    expect(before.status).toBe(200);

    const source = before.body.plan.containers.find(
      (container: any) => container.lines.some((line: any) => line.articleCode === ARTICLE_A && line.plannedQty > 0)
    );
    const destination = before.body.plan.containers.find(
      (container: any) => container.id !== source.id && container.totalBales < container.capacityBales
    );
    expect(source).toBeTruthy();
    expect(destination).toBeTruthy();

    const moved = await agent.post(`/api/factory/v5/container-plans/${planId}/move`).send({
      fromContainerId: source.id,
      toContainerId: destination.id,
      articleCode: ARTICLE_A,
      quantity: 1,
    });
    expect(moved.status).toBe(200);
    expect(productTotal(moved.body.plan, ARTICLE_A)).toBe(10);
    expect(productTotal(moved.body.plan, ARTICLE_B)).toBe(10);

    const sourceAfter = moved.body.plan.containers.find((container: any) => container.id === source.id);
    const destinationAfter = moved.body.plan.containers.find((container: any) => container.id === destination.id);
    expect(sourceAfter.totalBales).toBe(source.totalBales - 1);
    expect(destinationAfter.totalBales).toBe(destination.totalBales + 1);
    expect(destinationAfter.totalBales).toBeLessThanOrEqual(destinationAfter.capacityBales);
  }, 60_000);

  it("locks a container and rebalances only the remaining unlocked containers", async () => {
    expect(planId).not.toBeNull();

    const current = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    expect(current.status).toBe(200);
    const lockedBefore = current.body.plan.containers[0];
    const lockedLinesBefore = lockedBefore.lines
      .map((line: any) => [line.articleCode, line.plannedQty])
      .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0])));

    const locked = await agent
      .patch(`/api/factory/v5/container-plans/${planId}/containers/${lockedBefore.id}/lock`)
      .send({ isLocked: true });
    expect(locked.status).toBe(200);
    expect(locked.body.plan.containers.find((container: any) => container.id === lockedBefore.id).isLocked).toBe(true);

    const rebalanced = await agent.post(`/api/factory/v5/container-plans/${planId}/rebalance`).send({});
    expect(rebalanced.status).toBe(200);

    const lockedAfter = rebalanced.body.plan.containers.find((container: any) => container.id === lockedBefore.id);
    const lockedLinesAfter = lockedAfter.lines
      .map((line: any) => [line.articleCode, line.plannedQty])
      .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0])));

    expect(lockedLinesAfter).toEqual(lockedLinesBefore);
    expect(productTotal(rebalanced.body.plan, ARTICLE_A)).toBe(10);
    expect(productTotal(rebalanced.body.plan, ARTICLE_B)).toBe(10);

    const unlockedTotals = rebalanced.body.plan.containers
      .filter((container: any) => !container.isLocked)
      .map((container: any) => Number(container.totalBales));
    expect(Math.max(...unlockedTotals) - Math.min(...unlockedTotals)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("deletes the draft and cascades its child rows while retaining audit evidence", async () => {
    expect(planId).not.toBeNull();
    const deletingId = planId!;

    const deleted = await agent.delete(`/api/factory/v5/container-plans/${deletingId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);

    const [plans, containers, lines, audit] = await Promise.all([
      pool.query("SELECT id FROM factory_container_plans WHERE id = $1", [deletingId]),
      pool.query("SELECT id FROM factory_container_plan_containers WHERE plan_id = $1", [deletingId]),
      pool.query("SELECT id FROM factory_container_plan_lines WHERE plan_id = $1", [deletingId]),
      pool.query(
        `SELECT id FROM audit_log
         WHERE company_id = $1 AND table_name = 'factory_container_plans' AND record_id = $2 AND action = 'delete'`,
        [ctx.companyId, deletingId]
      ),
    ]);

    expect(plans.rowCount).toBe(0);
    expect(containers.rowCount).toBe(0);
    expect(lines.rowCount).toBe(0);
    expect(audit.rowCount).toBeGreaterThan(0);
    planId = null;
  }, 60_000);
});
