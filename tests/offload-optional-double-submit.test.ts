/**
 * Double-submit / concurrency coverage for POST /api/offloads/:id/toggle-optional.
 *
 * Suspending an offload removes the stock the offload added and flips its charge
 * vouchers to optional; restoring does the inverse. Both directions are money and
 * stock effects, so a retry (proxy timeout, double-click, offline replay) or two
 * simultaneous requests must produce exactly one effect — never two.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "offopt";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let containerId: number;
let offloadId: number;
let offloadItemId: number;

const OFFLOADED_QTY = "10.000";
const OFFLOADED_RATE = "5.00";
const OFFLOADED_VALUE = "50.00";

async function inventoryQuantity(): Promise<string> {
  const result = await pool.query<{ quantity: string }>(
    `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
  );
  return result.rows[0]?.quantity ?? "0";
}

async function movementCount(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM canonical_stock_movements
     WHERE company_id = $1 AND stock_item_id = $2 AND source_id = $3`,
    [ctx.companyId, ctx.stockItemIds[0], String(offloadId)]
  );
  return result.rows[0].count;
}

async function resetOffloadState(optional: boolean): Promise<void> {
  await pool.query(`UPDATE container_offloads SET optional = $1 WHERE id = $2`, [optional, offloadId]);
  await pool.query(`UPDATE containers SET status = 'OFFLOADED', offload_date = '2026-08-01' WHERE id = $1`, [
    containerId,
  ]);
  await pool.query(
    `UPDATE inventory SET quantity = '100.000', average_rate = '10.00', total_value = '1000.00'
     WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
  );
  await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1 AND source_id = $2`, [
    ctx.companyId,
    String(offloadId),
  ]);
  await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [ctx.companyId]);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);

  const company = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (company.status !== 200) throw new Error(`Set company failed: ${company.status} ${company.text}`);

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SUP`, `${TEST_PREFIX} Supplier`, `${TEST_PREFIX}@example.com`]
  );
  supplierId = supplier.rows[0].id;

  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, offload_date)
     VALUES ($1, $2, $3, 'OFFLOADED', '2026-07-01', '2026-08-01')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CNT-1`, supplierId]
  );
  containerId = container.rows[0].id;

  const offload = await pool.query<{ id: number }>(
    `INSERT INTO container_offloads (container_id, location_id, total_bales, additional_cost_per_bale, optional)
     VALUES ($1, $2, '10.000', '0.00', false)
     RETURNING id`,
    [containerId, ctx.locationId]
  );
  offloadId = offload.rows[0].id;

  const item = await pool.query<{ id: number }>(
    `INSERT INTO container_offload_items (offload_id, stock_item_id, quantity, rate, total_value)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [offloadId, ctx.stockItemIds[0], OFFLOADED_QTY, OFFLOADED_RATE, OFFLOADED_VALUE]
  );
  offloadItemId = item.rows[0].id;
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("container offload optional toggle double-submit", () => {
  it("suspends the offload exactly once when two requests race", async () => {
    await resetOffloadState(false);

    const responses = await Promise.all([
      agent.post(`/api/offloads/${offloadId}/toggle-optional`).send({ optional: true }),
      agent.post(`/api/offloads/${offloadId}/toggle-optional`).send({ optional: true }),
    ]);

    for (const response of responses) {
      // The winner applies the suspend; the loser is either rejected as
      // in-progress or told the state it asked for is already committed.
      expect([200, 409]).toContain(response.status);
      if (response.status === 200) expect(response.body.optional).toBe(true);
    }
    expect(responses.filter((response) => response.status === 200 && response.body.replayed === false)).toHaveLength(1);

    // One suspend removes the 10 offloaded units exactly once.
    expect(await inventoryQuantity()).toBe("90.000");
    expect(await movementCount()).toBe(1);

    const offload = await pool.query<{ optional: boolean }>(`SELECT optional FROM container_offloads WHERE id = $1`, [
      offloadId,
    ]);
    expect(offload.rows[0].optional).toBe(true);
  });

  it("restores the offload exactly once when two requests race", async () => {
    await resetOffloadState(true);
    await pool.query(`UPDATE containers SET status = 'OTW', offload_date = NULL WHERE id = $1`, [containerId]);
    await pool.query(
      `UPDATE inventory SET quantity = '90.000', total_value = '950.00'
       WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
      [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
    );

    const responses = await Promise.all([
      agent.post(`/api/offloads/${offloadId}/toggle-optional`).send({ optional: false }),
      agent.post(`/api/offloads/${offloadId}/toggle-optional`).send({ optional: false }),
    ]);

    for (const response of responses) {
      expect([200, 409]).toContain(response.status);
      if (response.status === 200) expect(response.body.optional).toBe(false);
    }
    expect(responses.filter((response) => response.status === 200 && response.body.replayed === false)).toHaveLength(1);

    // One restore adds the 10 units back exactly once.
    expect(await inventoryQuantity()).toBe("100.000");
    expect(await movementCount()).toBe(1);

    const offload = await pool.query<{ optional: boolean }>(`SELECT optional FROM container_offloads WHERE id = $1`, [
      offloadId,
    ]);
    expect(offload.rows[0].optional).toBe(false);
  });

  it("replays a committed request without a second stock effect", async () => {
    await resetOffloadState(false);

    // A retry that arrives after the first one committed carries the same intent,
    // so it must report the state instead of toggling back.
    const first = await agent.post(`/api/offloads/${offloadId}/toggle-optional`).send({ optional: true });
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    expect(await inventoryQuantity()).toBe("90.000");

    const retry = await agent.post(`/api/offloads/${offloadId}/toggle-optional`).send({ optional: true });
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);

    expect(await inventoryQuantity()).toBe("90.000");
    expect(await movementCount()).toBe(1);
  });

  it("replays a submitted request identity without a second stock effect", async () => {
    await resetOffloadState(false);

    const first = await agent
      .post(`/api/offloads/${offloadId}/toggle-optional`)
      .set("X-Idempotency-Key", `${TEST_PREFIX}-suspend-1`)
      .send({ optional: true });
    expect(first.status).toBe(200);
    expect(await inventoryQuantity()).toBe("90.000");

    const retry = await agent
      .post(`/api/offloads/${offloadId}/toggle-optional`)
      .set("X-Idempotency-Key", `${TEST_PREFIX}-suspend-1`)
      .send({ optional: true });
    expect(retry.status).toBe(200);
    expect(retry.body?.replayed).toBe(true);

    expect(await inventoryQuantity()).toBe("90.000");
    expect(await movementCount()).toBe(1);
  });

  it("keeps the offload item fixture referenced", () => {
    expect(offloadItemId).toBeGreaterThan(0);
  });
});
