/**
 * Supplier Partner cutover exact stock synchronization: the per-location plan,
 * every blocker that refuses it, the snapshot-backed synchronization and its
 * exact restore, and the perpetual-inventory refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import {
  backfillLegacyCutoverStockDeltaKeys,
  buildExactInventoryPlan,
  restoreExactCutoverStock,
  synchronizeExactCutoverStock,
} from "../server/routes/sp/spMigrationPhase4Inventory";
import {
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertCutover,
  insertInventory,
  insertLocation,
  insertRun,
  insertStockItem,
  linkRows,
  scalar,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_p4inv";
const BLOCKED_PREFIX = "spmigcov_p4invblk";
let pair: SpMigrationPair;
let blocked: SpMigrationPair;
let legacyCutoverId: number;
const target: Record<string, number> = {};

async function quantity(id: number): Promise<number | null> {
  const value = await scalar<string | undefined>(`SELECT quantity FROM inventory WHERE id = $1`, [id]);
  return value === undefined ? null : Number(value);
}

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  blocked = await createSpMigrationPair(BLOCKED_PREFIX);

  // A stock-delta row written before delta_key existed, for the one-time backfill.
  legacyCutoverId = await insertCutover(blocked, "rolled_back");
  await pool.query(
    `INSERT INTO sp_migration_cutover_stock_deltas (cutover_id, source_inventory_id, target_stock_item_id, target_location_id)
     VALUES ($1, 991, 1, 1)`,
    [legacyCutoverId]
  );

  const srcA = await insertLocation(pair.sourceId, `${pair.code}-SA`, `${PREFIX} A`);
  const srcB = await insertLocation(pair.sourceId, `${pair.code}-SB`, `${PREFIX} B`);
  const tgtA = await insertLocation(pair.targetId, `${pair.code}-TA`, `${PREFIX} A`);
  const tgtB = await insertLocation(pair.targetId, `${pair.code}-TB`, `${PREFIX} B`);
  const run = await insertRun(pair.sourceId, pair.targetId, "gc_stock_master");
  const items: number[][] = [];
  for (const suffix of ["1", "2", "3"]) {
    const source = await insertStockItem(pair.sourceId, `${pair.code}-I${suffix}`);
    const tgt = await insertStockItem(pair.targetId, `${pair.code}-I${suffix}`);
    await linkRows(run, "stock_items", source, "stock_items", tgt);
    items.push([source, tgt]);
  }
  const [[s1, t1], [s2, t2], [, t3]] = items;
  await insertInventory(pair.sourceId, srcA, s1, "5", "2", "10");
  await insertInventory(pair.sourceId, srcA, s2, "4", "3", "12");
  await insertInventory(pair.sourceId, srcB, s1, "6", "2", "12");
  target.unchanged = await insertInventory(pair.targetId, tgtA, t1, "5", "2", "10");
  target.updated = await insertInventory(pair.targetId, tgtB, t1, "1", "2", "2");
  target.zeroed = await insertInventory(pair.targetId, tgtB, t2, "3", "3", "9");
  target.emptyTargetOnly = await insertInventory(pair.targetId, tgtA, t3, "0", "0", "0");
  target.tgtA = tgtA;
  target.t2 = t2;

  // Blocked pair: two source locations share one target name, one source item is
  // unmapped, two source items map to one target item, and one location is unmapped.
  const bA1 = await insertLocation(blocked.sourceId, `${blocked.code}-A1`, `${BLOCKED_PREFIX} Same`);
  const bA2 = await insertLocation(blocked.sourceId, `${blocked.code}-A2`, `${BLOCKED_PREFIX} same`);
  const bOrphan = await insertLocation(blocked.sourceId, `${blocked.code}-OR`, `${BLOCKED_PREFIX} Orphan`);
  await insertLocation(blocked.targetId, `${blocked.code}-TS`, `${BLOCKED_PREFIX} Same`);
  const blockedRun = await insertRun(blocked.sourceId, blocked.targetId, "gc_stock_master");
  const bTarget = await insertStockItem(blocked.targetId, `${blocked.code}-T`);
  const bS1 = await insertStockItem(blocked.sourceId, `${blocked.code}-S1`);
  const bS2 = await insertStockItem(blocked.sourceId, `${blocked.code}-S2`);
  const bUnmapped = await insertStockItem(blocked.sourceId, `${blocked.code}-S3`);
  await linkRows(blockedRun, "stock_items", bS1, "stock_items", bTarget);
  await linkRows(blockedRun, "stock_items", bS2, "stock_items", bTarget);
  await insertInventory(blocked.sourceId, bA1, bS1, "1", "1", "1");
  await insertInventory(blocked.sourceId, bA1, bS2, "1", "1", "1");
  await insertInventory(blocked.sourceId, bA2, bS1, "1", "1", "1");
  await insertInventory(blocked.sourceId, bA1, bUnmapped, "1", "1", "1");
  await insertInventory(blocked.sourceId, bOrphan, bS1, "1", "1", "1");
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
  await cleanupSpMigrationPair(BLOCKED_PREFIX);
}, 120000);

describe("exact inventory plan", () => {
  it("backfills legacy stock-delta keys once", async () => {
    await backfillLegacyCutoverStockDeltaKeys();
    expect(
      await scalar(`SELECT delta_key FROM sp_migration_cutover_stock_deltas WHERE cutover_id = $1`, [legacyCutoverId])
    ).toBe("source:991");
  });

  it("reports every blocker that would merge, drop or guess stock", async () => {
    const plan = await buildExactInventoryPlan(blocked.sourceId, blocked.targetId);
    expect(plan.blockers.map((issue) => issue.code).sort()).toEqual([
      "INVENTORY_LOCATION_COLLISION",
      "INVENTORY_TARGET_KEY_COLLISION",
      "INVENTORY_TARGET_KEY_COLLISION",
      "UNMAPPED_INVENTORY_ITEM",
      "UNMAPPED_INVENTORY_LOCATION",
    ]);
    const cutoverId = await insertCutover(blocked, "prepared");
    await expect(synchronizeExactCutoverStock(cutoverId, blocked.sourceId, blocked.targetId)).rejects.toThrow(
      /Multiple source locations map to target location/
    );
    expect(await scalar(`SELECT COUNT(*)::int FROM inventory WHERE company_id = $1`, [blocked.targetId])).toBe(0);
  });

  it("plans unchanged, new, updated and target-only rows", async () => {
    const plan = await buildExactInventoryPlan(pair.sourceId, pair.targetId);
    expect(plan.blockers).toEqual([]);
    expect(plan).toMatchObject({ sourceRows: 3, targetRowsInScope: 4, changedRows: 3, targetOnlyRows: 1 });
    const created = plan.entries.find((entry) => entry.createdTargetInventory);
    expect(created).toMatchObject({ targetLocationId: target.tgtA, targetStockItemId: target.t2, afterTotalValue: 12 });
  });
});

describe("exact stock synchronization", () => {
  it("synchronizes target stock to the source and restores it exactly", async () => {
    const cutoverId = await insertCutover(pair, "prepared");
    const result = await synchronizeExactCutoverStock(cutoverId, pair.sourceId, pair.targetId);
    expect(result).toMatchObject({ updated: 1, inserted: 1, zeroed: 1, unchanged: 2 });
    expect(await quantity(target.updated)).toBe(6);
    expect(Number(await scalar(`SELECT total_value FROM inventory WHERE id = $1`, [target.updated]))).toBe(12);
    expect(await quantity(target.zeroed)).toBe(0);
    expect(await quantity(target.unchanged)).toBe(5);
    expect(
      await scalar(`SELECT COUNT(*)::int FROM sp_migration_cutover_stock_deltas WHERE cutover_id = $1`, [cutoverId])
    ).toBe(3);

    const restored = await restoreExactCutoverStock(cutoverId, pair.targetId);
    expect(restored).toEqual({ restored: 2, deleted: 1 });
    expect(await quantity(target.updated)).toBe(1);
    expect(await quantity(target.zeroed)).toBe(3);
    expect(
      await scalar(
        `SELECT COUNT(*)::int FROM inventory WHERE company_id = $1 AND stock_item_id = $2 AND location_id = $3`,
        [pair.targetId, target.t2, target.tgtA]
      )
    ).toBe(0);
  });

  it("refuses to rewrite or restore stock once the target has a perpetual-inventory cut-over", async () => {
    const cutoverId = await insertCutover(pair, "cancelled");
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, '2026-10-01', '{}'::jsonb, 'test')`,
      [pair.targetId]
    );
    try {
      await expect(synchronizeExactCutoverStock(cutoverId, pair.sourceId, pair.targetId)).rejects.toMatchObject({
        code: "PERPETUAL_INVENTORY_ACTIVE",
      });
      await expect(restoreExactCutoverStock(cutoverId, pair.targetId)).rejects.toMatchObject({
        code: "PERPETUAL_INVENTORY_ACTIVE",
      });
      expect(await quantity(target.updated)).toBe(1);
    } finally {
      await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [pair.targetId]);
    }
  });
});
