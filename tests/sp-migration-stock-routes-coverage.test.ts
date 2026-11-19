/**
 * Supplier Partner migration stock steps (gc-stock-master, gc-stock-opening):
 * the pair/confirmation refusals, the dependency and perpetual-inventory
 * refusals, the master-data copy, the per-location opening stock with its
 * idempotent rerun, the block on target stock that already exists, and the
 * failure path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { registerSpMigrationStockRoutes } from "../server/routes/sp-migration/spMigrationStockRoutes";
import {
  captureRouteHandlers,
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertInventory,
  insertLocation,
  insertStockItem,
  pairBody,
  scalar,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_stock";
let pair: SpMigrationPair;
const ids: Record<string, number> = {};
const { call } = captureRouteHandlers((app) => registerSpMigrationStockRoutes(app));

const MASTER = "POST /api/sp/migration/gc-stock-master";
const OPENING = "POST /api/sp/migration/gc-stock-opening";
const run = (route: string, extra: Record<string, unknown> = {}) =>
  call(route, { body: pairBody(pair, { confirmation: "MIGRATE", ...extra }) });

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  const group = await pool.query<{ id: number }>(
    `INSERT INTO stock_groups (company_id, code, name, active) VALUES ($1, 'SPMG', $2, true) RETURNING id`,
    [pair.sourceId, `${PREFIX} group`]
  );
  ids.group = group.rows[0].id;
  ids.l1 = await insertLocation(pair.sourceId, `${pair.code}-L1`, `${PREFIX} Store`);
  ids.l2 = await insertLocation(pair.sourceId, `${pair.code}-L2`, `${PREFIX} Closed`);
  ids.tl1 = await insertLocation(pair.targetId, `${pair.code}-TL1`, `${PREFIX} Store`);
  ids.i1 = await insertStockItem(pair.sourceId, `${pair.code}-I1`);
  ids.i2 = await insertStockItem(pair.sourceId, `${pair.code}-I2`);
  ids.i3 = await insertStockItem(pair.sourceId, `${pair.code}-I3`);
  await pool.query(`UPDATE stock_items SET stock_group_id = $1 WHERE id = $2`, [ids.group, ids.i1]);
  await insertInventory(pair.sourceId, ids.l1, ids.i1, "5", "2", "10");
  await insertInventory(pair.sourceId, ids.l1, ids.i2, "3", "4", "12");
  await insertInventory(pair.sourceId, ids.l2, ids.i3, "1", "6", "6");
  await pool.query(`UPDATE locations SET deleted_at = now() WHERE id = $1`, [ids.l2]);
  // The target already holds I2 (matched by code) with stock at the mapped location.
  ids.t2 = await insertStockItem(pair.targetId, `${pair.code}-I2`);
  await insertInventory(pair.targetId, ids.tl1, ids.t2, "2", "4", "8");
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
}, 120000);

describe.each([MASTER, OPENING])("%s refusals", (route) => {
  it("refuses a missing confirmation, missing ids, unknown or mistyped companies and a wrong name", async () => {
    expect(await call(route, { body: pairBody(pair) })).toMatchObject({
      status: 400,
      body: { message: 'Requires confirmation = "MIGRATE"' },
    });
    expect((await call(route, { body: { confirmation: "MIGRATE" } })).status).toBe(400);
    expect(await run(route, { sourceCompanyId: 2147480001 })).toMatchObject({
      status: 404,
      body: { message: "Source company not found" },
    });
    expect(await run(route, { targetCompanyId: 2147480001 })).toMatchObject({
      status: 404,
      body: { message: "Target company not found" },
    });
    expect(await run(route, { sourceCompanyId: pair.targetId, targetCompanyId: pair.targetId })).toMatchObject({
      status: 400,
      body: { message: "Source company must be type 'erp'" },
    });
    expect(await run(route, { targetCompanyId: pair.sourceId })).toMatchObject({
      status: 400,
      body: { message: "Target company must be type 'supplier_partner'" },
    });
    const wrongName = await run(route, { companyNameConfirm: "nope" });
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.message).toContain(pair.sourceName);
    expect(await scalar(`SELECT COUNT(*)::int FROM stock_items WHERE company_id = $1`, [pair.targetId])).toBe(1);
  });
});

describe("stock master and opening stock", () => {
  it("refuses opening stock before the master step", async () => {
    const result = await run(OPENING);
    expect(result.status).toBe(409);
    expect(result.body.message).toMatch(/Stock Master/);
  });

  it("copies master data, then reuses it on a rerun", async () => {
    const first = await run(MASTER);
    expect(first.status).toBe(200);
    expect(first.body.summary).toEqual(
      expect.arrayContaining(["Stock groups: 1 created", "Stock items: 2 created, 1 reused (already existed/linked)"])
    );
    expect(await scalar(`SELECT status FROM sp_migration_rehearsal_runs WHERE id = $1`, [first.body.runId])).toBe(
      "completed"
    );
    const second = await run(MASTER);
    expect(second.body.summary).toContain("Stock items: 0 created, 3 reused (already existed/linked)");
    expect(second.body.rowsCreated).toBe(0);
  });

  it("refuses opening stock once the target has a perpetual-inventory cut-over", async () => {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, '2026-10-01', '{}'::jsonb, 'test')`,
      [pair.targetId]
    );
    try {
      const result = await run(OPENING);
      expect(result).toMatchObject({ status: 409, body: { code: "PERPETUAL_INVENTORY_ACTIVE" } });
    } finally {
      await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [pair.targetId]);
    }
  });

  it("posts opening stock per location, blocks stacked stock and skips on a rerun", async () => {
    const first = await run(OPENING);
    expect(first.status).toBe(200);
    expect(first.body.summary).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Blocked .*-I2 @ target location — target already has stock \(qty 2\)/),
        "Opening stock movements created: 2, skipped (already existed): 0",
        "1 row(s) had no target stock item mapping — skipped",
      ])
    );
    expect(first.body.perLocationRecon).toEqual([{ location: `${PREFIX} Store`, sourceQty: 8, targetQty: 7 }]);
    const unassigned = await scalar<number>(
      `SELECT COUNT(*)::int FROM locations WHERE company_id = $1 AND code = 'UNASSIGNED'`,
      [pair.targetId]
    );
    expect(unassigned).toBe(1);
    expect(await scalar(`SELECT COUNT(*)::int FROM sp_stock_movements WHERE company_id = $1`, [pair.targetId])).toBe(2);

    const second = await run(OPENING);
    expect(second.body.summary).toContain("Opening stock movements created: 0, skipped (already existed): 2");
  });

  it("creates a missing target location under a code no other company holds", async () => {
    const l3 = await insertLocation(pair.sourceId, `${pair.code}-L3`, `${PREFIX} New branch`);
    await insertInventory(pair.sourceId, l3, ids.i1, "1", "2", "2");
    // The first derived code is already taken elsewhere, so the next free one is used.
    await insertLocation(pair.targetId, `${pair.code}-L3-SP${pair.targetId}`, `${PREFIX} Code squatter`);
    const result = await run(OPENING);
    expect(result.status).toBe(200);
    const created = await pool.query(`SELECT id, code FROM locations WHERE company_id = $1 AND name = $2`, [
      pair.targetId,
      `${PREFIX} New branch`,
    ]);
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0].code).toBe(`${pair.code}-L3-SP${pair.targetId}-2`);
    expect(
      await scalar(`SELECT COUNT(*)::int FROM sp_stock_movements WHERE company_id = $1 AND location_id = $2`, [
        pair.targetId,
        created.rows[0].id,
      ])
    ).toBe(1);
    expect(
      await scalar(`SELECT COUNT(*)::int FROM sp_migration_run_rows WHERE run_id = $1 AND table_name = 'locations'`, [
        result.body.runId,
      ])
    ).toBe(1);
  });
});
