/**
 * Phase 17 backend coverage — Factory production flows.
 *
 * Real PostgreSQL-backed production coverage. The acceptance invariant crosses
 * Factory and ERP: produced stock must have canonical stock evidence in the
 * same transaction, and replay must not create duplicate inventory evidence.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p17prod";
const PRODUCTION_DATE = "2026-09-14";

type MovementFingerprint = {
  movementCount: string;
  quantityDelta: string;
  requestCount: string;
};

let ctx: TestContext;
let agent: request.SuperAgentTest;
let productId: number;
let workerId: number;
let primaryPositionId: number;
let mixBatchId: number;

async function movementFingerprint(sourceType: string, sourceIds: string[]): Promise<MovementFingerprint> {
  const result = await pool.query<MovementFingerprint>(
    `SELECT
       (SELECT COUNT(*)::text
          FROM canonical_stock_movements
         WHERE company_id = $1 AND source_type = $2 AND source_id = ANY($3::text[])) AS "movementCount",
       (SELECT COALESCE(SUM(quantity_delta::numeric), 0)::text
          FROM canonical_stock_movements
         WHERE company_id = $1 AND source_type = $2 AND source_id = ANY($3::text[])) AS "quantityDelta",
       (SELECT COUNT(*)::text
          FROM canonical_stock_movement_requests
         WHERE company_id = $1 AND source_type = $2 AND source_id = ANY($3::text[])) AS "requestCount"`,
    [ctx.companyId, sourceType, sourceIds]
  );
  return result.rows[0];
}

async function stockItemForProduct(): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM stock_items WHERE company_id = $1 AND code = 'P17-ARTICLE' LIMIT 1`,
    [ctx.companyId]
  );
  if (!result.rows[0]) throw new Error("Phase 17 ERP stock item was not created");
  return result.rows[0].id;
}

async function inventoryQuantity(stockItemId: number, locationId: number): Promise<number> {
  const result = await pool.query<{ quantity: string }>(
    `SELECT COALESCE(SUM(quantity::numeric), 0)::text AS quantity
       FROM inventory
      WHERE company_id = $1 AND stock_item_id = $2 AND location_id = $3`,
    [ctx.companyId, stockItemId, locationId]
  );
  return Number(result.rows[0]?.quantity ?? 0);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app) as request.SuperAgentTest;

  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  await pool.query(
    `UPDATE user_company_roles
        SET role = 'Admin', can_delete_records = true, can_sell_negative_stock = true
      WHERE user_id = $1 AND company_id = $2`,
    [ctx.userId, ctx.companyId]
  );

  const login = await agent.post("/api/auth/login").send({
    username: `${PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);

  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`Company selection failed: ${selected.status} ${selected.text}`);

  const category = await pool.query<{ id: number }>(
    `INSERT INTO factory_categories (company_id, name, is_active)
     VALUES ($1, 'Phase 17 Production', true)
     RETURNING id`,
    [ctx.companyId]
  );
  const product = await pool.query<{ id: number }>(
    `INSERT INTO factory_bale_products
       (company_id, code, article_code, name, weight_per_bale_kg, category_id, production_price, active)
     VALUES ($1, 'P17-PROD', 'P17-ARTICLE', 'Phase 17 Bale', '25', $2, '2.00', true)
     RETURNING id`,
    [ctx.companyId, category.rows[0].id]
  );
  productId = product.rows[0].id;

  const worker = await pool.query<{ id: number }>(
    `INSERT INTO factory_workers
       (company_id, employee_code, full_name, date_joined, position, department, active)
     VALUES ($1, 'P17-W1', 'Phase 17 Worker', '2026-09-01', 'Pressing', 'Production', true)
     RETURNING id`,
    [ctx.companyId]
  );
  workerId = worker.rows[0].id;

  const position = await pool.query<{ id: number }>(
    `INSERT INTO factory_production_positions (company_id, name, active)
     VALUES ($1, 'Phase 17 Pressing', true)
     RETURNING id`,
    [ctx.companyId]
  );
  primaryPositionId = position.rows[0].id;
  await pool.query(
    `INSERT INTO factory_production_position_memberships
       (company_id, position_id, worker_id, effective_from)
     VALUES ($1, $2, $3, '2026-09-01')`,
    [ctx.companyId, primaryPositionId, workerId]
  );

  const mixBatch = await pool.query<{ id: number }>(
    `INSERT INTO factory_mix_batches
       (company_id, batch_code, name, total_weight_kg, used_kg, cost_per_kg, total_cost, status, batch_date)
     VALUES ($1, 'P17-MIX-1', 'Phase 17 Mix', '200', '0', '2.0000000', '400.0000000', 'ACTIVE', $2)
     RETURNING id`,
    [ctx.companyId, PRODUCTION_DATE]
  );
  mixBatchId = mixBatch.rows[0].id;
}, 120000);

afterAll(async () => {
  if (ctx?.companyId) {
    await pool
      .query(`DELETE FROM factory_staff_tracking_period_closures WHERE company_id = $1`, [ctx.companyId])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM factory_staff_tracking_entries WHERE company_id = $1`, [ctx.companyId])
      .catch(() => undefined);
    await pool.query(`DELETE FROM factory_worker_categories WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
    await pool
      .query(`DELETE FROM factory_production_position_rules WHERE company_id = $1`, [ctx.companyId])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM factory_production_position_memberships WHERE company_id = $1`, [ctx.companyId])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM factory_production_positions WHERE company_id = $1`, [ctx.companyId])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM factory_bale_production_attributions WHERE company_id = $1`, [ctx.companyId])
      .catch(() => undefined);
    await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120000);

describe.sequential("Phase 17 Factory production flows", () => {
  it("covers pressing/finalization and creates canonical stock evidence exactly once", async () => {
    const pressed = await agent.post("/api/factory/pressing/create-and-print").send({
      productId,
      quantity: 2,
      weightPerBale: 25,
      txDate: PRODUCTION_DATE,
    });
    expect(pressed.status, pressed.text).toBe(200);
    const baleIds = (pressed.body.bales as Array<{ id: number }>).map((bale) => bale.id);
    expect(baleIds).toHaveLength(2);

    const finalized = await agent.post("/api/factory/finalize").send({
      pressingBatchId: pressed.body.pressingBatchId,
      scannedBaleIds: baleIds,
      erpLocationId: ctx.locationId,
      mixBatchId,
      txDate: PRODUCTION_DATE,
    });
    expect(finalized.status, finalized.text).toBe(200);
    expect(finalized.body).toMatchObject({ updated: 2, isFullyFinalized: true });

    const stockItemId = await stockItemForProduct();
    expect(await inventoryQuantity(stockItemId, ctx.locationId)).toBe(2);
    const firstEvidence = await movementFingerprint("factory-bale-finalize", baleIds.map(String));
    expect(firstEvidence).toEqual({ movementCount: "2", quantityDelta: "2.000000", requestCount: "2" });

    const replay = await agent.post("/api/factory/finalize").send({
      pressingBatchId: pressed.body.pressingBatchId,
      scannedBaleIds: baleIds,
      erpLocationId: ctx.locationId,
      mixBatchId,
      txDate: PRODUCTION_DATE,
    });
    expect(replay.status).toBe(400);
    expect(String(replay.body.message)).toMatch(/already fully finalized/i);
    expect(await inventoryQuantity(stockItemId, ctx.locationId)).toBe(2);
    expect(await movementFingerprint("factory-bale-finalize", baleIds.map(String))).toEqual(firstEvidence);
  }, 120000);

  it("covers Stock Entry worker attribution and one aggregated receipt per stock item", async () => {
    const created = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.location2Id,
      entryDate: PRODUCTION_DATE,
      mixBatchId,
      items: [{ productId, quantity: 3, weightPerBale: 10, finalizedBy: workerId }],
    });
    expect(created.status, created.text).toBe(200);

    const bales = await pool.query<{ id: number }>(
      `SELECT id
         FROM factory_bales
        WHERE company_id = $1 AND product_id = $2 AND stock_entry_date = $3 AND finalized_by = $4
        ORDER BY id`,
      [ctx.companyId, productId, PRODUCTION_DATE, workerId]
    );
    expect(bales.rows).toHaveLength(3);

    const attributions = await pool.query<{
      worker_id: number;
      production_position_id: number;
      production_position_name_snapshot: string;
    }>(
      `SELECT worker_id, production_position_id, production_position_name_snapshot
         FROM factory_bale_production_attributions
        WHERE company_id = $1 AND bale_id = ANY($2::int[])
        ORDER BY bale_id`,
      [ctx.companyId, bales.rows.map((row) => row.id)]
    );
    expect(attributions.rows).toHaveLength(3);
    expect(attributions.rows.every((row) => row.worker_id === workerId)).toBe(true);
    expect(attributions.rows.every((row) => row.production_position_id === primaryPositionId)).toBe(true);
    expect(attributions.rows.every((row) => row.production_position_name_snapshot === "Phase 17 Pressing")).toBe(true);

    const stockItemId = await stockItemForProduct();
    expect(await inventoryQuantity(stockItemId, ctx.location2Id)).toBe(3);
    const evidence = await pool.query<{ movement_count: string; quantity_delta: string; request_count: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM canonical_stock_movements
           WHERE company_id = $1 AND source_type = 'factory-stock-entry' AND stock_item_id = $2 AND location_id = $3) movement_count,
         (SELECT COALESCE(SUM(quantity_delta::numeric), 0)::text FROM canonical_stock_movements
           WHERE company_id = $1 AND source_type = 'factory-stock-entry' AND stock_item_id = $2 AND location_id = $3) quantity_delta,
         (SELECT COUNT(*)::text FROM canonical_stock_movement_requests
           WHERE company_id = $1 AND source_type = 'factory-stock-entry') request_count`,
      [ctx.companyId, stockItemId, ctx.location2Id]
    );
    expect(evidence.rows[0]).toEqual({ movement_count: "1", quantity_delta: "3.000000", request_count: "1" });
  }, 120000);

  it("covers invalid/missing production configuration without posting stock evidence", async () => {
    const invalidQuantity = await agent
      .post("/api/factory/pressing/create-and-print")
      .send({ productId, quantity: 0, weightPerBale: 25 });
    expect(invalidQuantity.status).toBe(400);
    expect(String(invalidQuantity.body.message)).toMatch(/quantity/i);

    const missingLocation = await agent.post("/api/factory/stock-entry").send({
      entryDate: PRODUCTION_DATE,
      items: [{ productId, quantity: 1, weightPerBale: 10, finalizedBy: workerId }],
    });
    expect(missingLocation.status).toBe(400);
    expect(String(missingLocation.body.message)).toMatch(/location is required/i);

    const positionWithoutWorker = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.location2Id,
      entryDate: PRODUCTION_DATE,
      items: [{ productId, quantity: 1, weightPerBale: 10, productionPositionId: primaryPositionId }],
    });
    expect(positionWithoutWorker.status).toBe(400);
    expect(String(positionWithoutWorker.body.message)).toMatch(/without a worker/i);

    const secondPosition = await pool.query<{ id: number }>(
      `INSERT INTO factory_production_positions (company_id, name, active)
       VALUES ($1, 'Phase 17 Sorting', true)
       RETURNING id`,
      [ctx.companyId]
    );
    await pool.query(
      `INSERT INTO factory_production_position_memberships
         (company_id, position_id, worker_id, effective_from)
       VALUES ($1, $2, $3, '2026-09-01')`,
      [ctx.companyId, secondPosition.rows[0].id, workerId]
    );

    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM canonical_stock_movements WHERE company_id = $1`,
      [ctx.companyId]
    );
    const ambiguousWorker = await agent.post("/api/factory/stock-entry").send({
      erpLocationId: ctx.location2Id,
      entryDate: PRODUCTION_DATE,
      items: [{ productId, quantity: 1, weightPerBale: 10, finalizedBy: workerId }],
    });
    expect(ambiguousWorker.status).toBe(400);
    expect(String(ambiguousWorker.body.message)).toMatch(/multiple production positions/i);
    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM canonical_stock_movements WHERE company_id = $1`,
      [ctx.companyId]
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);

    const pending = await agent.post("/api/factory/pressing/create-and-print").send({
      productId,
      quantity: 1,
      weightPerBale: 25,
      txDate: PRODUCTION_DATE,
    });
    expect(pending.status, pending.text).toBe(200);
    const pendingBaleId = Number(pending.body.bales[0].id);
    const missingMix = await agent.post("/api/factory/finalize").send({
      pressingBatchId: pending.body.pressingBatchId,
      scannedBaleIds: [pendingBaleId],
      erpLocationId: ctx.locationId,
      mixBatchId: 2147483000,
      txDate: PRODUCTION_DATE,
    });
    expect(missingMix.status).toBe(400);
    expect(String(missingMix.body.message)).toMatch(/mix batch not found/i);
    expect(await movementFingerprint("factory-bale-finalize", [String(pendingBaleId)])).toEqual({
      movementCount: "0",
      quantityDelta: "0",
      requestCount: "0",
    });
  }, 120000);

  it("covers Production Targets, worker groups, snapshots and finalized locking", async () => {
    const ungrouped = await agent.post("/api/factory/staff-tracking/bulk").send({
      page: "production",
      periodType: "daily",
      periodStart: PRODUCTION_DATE,
      periodEnd: PRODUCTION_DATE,
      records: [{ personType: "worker", personId: workerId, targetBales: 5, status: "Present" }],
    });
    expect(ungrouped.status).toBe(400);
    expect(String(ungrouped.body.message)).toMatch(/production planner group/i);

    await pool.query(
      `INSERT INTO factory_worker_categories (company_id, name, worker_ids)
       VALUES ($1, 'Phase 17 Pressing Team', $2::jsonb)`,
      [ctx.companyId, JSON.stringify([workerId])]
    );

    const live = await agent.get("/api/factory/staff-tracking").query({
      page: "production",
      periodType: "daily",
      periodStart: PRODUCTION_DATE,
      periodEnd: PRODUCTION_DATE,
    });
    expect(live.status, live.text).toBe(200);
    const liveWorker = (live.body.rows as Array<{ personId: number; producedBales: number }>).find(
      (row) => row.personId === workerId
    );
    expect(liveWorker?.producedBales).toBe(3);

    const finalized = await agent.post("/api/factory/staff-tracking/bulk").send({
      page: "production",
      periodType: "daily",
      periodStart: PRODUCTION_DATE,
      periodEnd: PRODUCTION_DATE,
      finalize: true,
      records: [
        {
          personType: "worker",
          personId: workerId,
          targetBales: 5,
          producedBales: 999,
          status: "Present",
          notes: "Phase 17 finalized target",
        },
      ],
    });
    expect(finalized.status, finalized.text).toBe(200);
    expect(finalized.body.finalized).toBe(true);

    const snapshot = await agent.get("/api/factory/staff-tracking").query({
      page: "production",
      periodType: "daily",
      periodStart: PRODUCTION_DATE,
      periodEnd: PRODUCTION_DATE,
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.finalized).toBe(true);
    const savedWorker = (snapshot.body.rows as Array<{
      personId: number;
      producedBales: number;
      targetBales: number;
      groupName: string;
    }>).find((row) => row.personId === workerId);
    expect(savedWorker).toMatchObject({
      producedBales: 3,
      targetBales: 5,
      groupName: "Phase 17 Pressing Team",
    });

    const locked = await agent.post("/api/factory/staff-tracking/bulk").send({
      page: "production",
      periodType: "daily",
      periodStart: PRODUCTION_DATE,
      periodEnd: PRODUCTION_DATE,
      records: [{ personType: "worker", personId: workerId, targetBales: 6, status: "Present" }],
    });
    expect(locked.status).toBe(409);
    expect(locked.body.finalized).toBe(true);

    const invalidFinalizePeriod = await agent.post("/api/factory/staff-tracking/bulk").send({
      page: "production",
      periodType: "weekly",
      periodStart: "2026-09-14",
      periodEnd: "2026-09-20",
      finalize: true,
      records: [{ personType: "worker", personId: workerId, targetBales: 5, status: "Present" }],
    });
    expect(invalidFinalizePeriod.status).toBe(400);
    expect(String(invalidFinalizePeriod.body.message)).toMatch(/single daily production date/i);
  }, 120000);
});
