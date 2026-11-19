/**
 * Supplier Partner cutover finalization end to end against a real database:
 * the historical-sales and container delta imports, their Phase 4 repairs, the
 * exact stock synchronization and the recovery that runs when finalization
 * fails. Finalization currently always ends in that recovery path, because the
 * readiness build it verifies with fails (see the defect note in
 * sp-migration-phase4-routes-coverage); these tests prove the recovery puts
 * target stock back and leaves the cutover prepared and claimable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { registerSpMigrationPhase4Routes } from "../server/routes/sp/spMigrationPhase4Routes";
import {
  captureRouteHandlers,
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertAccount,
  insertCutover,
  insertInventory,
  insertLocation,
  insertRequiredTargetAccounts,
  insertRun,
  insertSaleItem,
  insertStockItem,
  insertSupplier,
  insertVoucher,
  linkRows,
  pairBody,
  scalar,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_p4final";
let pair: SpMigrationPair;
let openingRunId: string;
let targetInventoryId: number;
let sourceLocationId: number;
let sourceItemId: number;
const { call } = captureRouteHandlers((app) => registerSpMigrationPhase4Routes(app));

const finalize = () =>
  call("POST /api/sp/migration/cutover/finalize", { body: pairBody(pair, { confirmation: "FINALIZE CUTOVER" }) });

async function cutover(id: number) {
  return (await pool.query(`SELECT * FROM sp_migration_cutovers WHERE id = $1`, [id])).rows[0];
}

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  await insertRequiredTargetAccounts(pair.targetId);
  const cash = await insertAccount(pair.sourceId, `${pair.code}-CASH`, "Cash", null);
  const sales = await insertAccount(pair.sourceId, `${pair.code}-SALES`, "Income", "sp_sales");

  sourceLocationId = await insertLocation(pair.sourceId, `${pair.code}-SL1`, `${PREFIX} Main`);
  const targetLocationId = await insertLocation(pair.targetId, `${pair.code}-TL1`, `${PREFIX} Main`);
  sourceItemId = await insertStockItem(pair.sourceId, `${pair.code}-ITEM`);
  const targetItemId = await insertStockItem(pair.targetId, `${pair.code}-ITEM`);
  const masterRun = await insertRun(pair.sourceId, pair.targetId, "gc_stock_master");
  await linkRows(masterRun, "stock_items", sourceItemId, "stock_items", targetItemId);
  openingRunId = await insertRun(pair.sourceId, pair.targetId, "gc_stock_opening");

  await insertInventory(pair.sourceId, sourceLocationId, sourceItemId, "7", "3", "21");
  targetInventoryId = await insertInventory(pair.targetId, targetLocationId, targetItemId, "2", "3", "6");

  const sale = await insertVoucher({
    companyId: pair.sourceId,
    number: `${pair.code}-SV1`,
    total: "30",
    entries: [
      { accountId: cash, debit: "30", credit: "0" },
      { accountId: sales, debit: "0", credit: "30" },
    ],
  });
  await insertSaleItem(sale.voucherId, sourceItemId);

  const supplierId = await insertSupplier(pair.sourceId, `${pair.code}-SUP`, `${PREFIX} Supplier`);
  await pool.query(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, item_name, total_kg, items_total, rate_per_kg)
     VALUES ($1, $2, '2026-09-02', $3, 'OTW', $4, 5, 50, 10)`,
    [pair.sourceId, `${pair.code}-CTR`, supplierId, `${pair.code}-ITEM`]
  );
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
}, 120000);

describe("cutover finalization", () => {
  it("fails before importing anything when the stock-opening step has not completed", async () => {
    await pool.query(`UPDATE sp_migration_rehearsal_runs SET status = 'failed' WHERE id = $1`, [openingRunId]);
    const id = await insertCutover(pair, "prepared");
    try {
      const result = await finalize();
      expect(result.status).toBe(500);
      expect(result.body.message).toBe(
        "Cutover finalization failed: Run Step 5 — Stock Opening by Location successfully first."
      );
      expect(result.body.recovery.stock).toEqual({ restored: 0, deleted: 0 });
      expect(result.body.recovery.users.usersRestored).toBe(0);
      const row = await cutover(id);
      expect(row.status).toBe("prepared");
      expect(row.finalize_started_at).toBeNull();
      expect(row.failure_message).toMatch(/Stock Opening/);
      expect(
        await scalar(`SELECT COUNT(*)::int FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'MIG-GC-%'`, [
          pair.targetId,
        ])
      ).toBe(0);
    } finally {
      await pool.query(`UPDATE sp_migration_rehearsal_runs SET status = 'completed' WHERE id = $1`, [openingRunId]);
      await pool.query(`DELETE FROM sp_migration_cutovers WHERE id = $1`, [id]);
    }
  });

  it("reports a user-restore failure in the recovery summary instead of hiding it", async () => {
    // A recorded role change cannot be restored (the session-switch defect in
    // spMigrationPhase4Users.ts), so the recovery records the error and continues.
    await pool.query(`UPDATE sp_migration_rehearsal_runs SET status = 'failed' WHERE id = $1`, [openingRunId]);
    const id = await insertCutover(pair, "prepared");
    await pool.query(
      `INSERT INTO sp_migration_cutover_role_changes (cutover_id, user_id, source_role_id, created_target_role, source_role_snapshot)
       VALUES ($1, 'spmigcov-ghost-user', 1, false, '{"role":"Manager"}'::jsonb)`,
      [id]
    );
    try {
      const result = await finalize();
      expect(result.status).toBe(500);
      expect(result.body.recovery.userRestoreError).toMatch(/Failed query/);
      expect(result.body.recovery.stock).toEqual({ restored: 0, deleted: 0 });
      expect((await cutover(id)).recovery_summary.userRestoreError).toMatch(/Failed query/);
    } finally {
      await pool.query(`UPDATE sp_migration_rehearsal_runs SET status = 'completed' WHERE id = $1`, [openingRunId]);
      await pool.query(`DELETE FROM sp_migration_cutovers WHERE id = $1`, [id]);
    }
  });

  it("imports and repairs the deltas, then restores target stock when verification fails", async () => {
    const id = await insertCutover(pair, "prepared");

    const first = await finalize();
    expect(first.status).toBe(500);
    expect(first.body.cutoverId).toBe(id);
    expect(first.body.message).toMatch(/^Cutover finalization failed: Failed query/);
    // Stock was synchronized to the source (2 -> 7) and the recovery put it back.
    expect(first.body.recovery.stock).toEqual({ restored: 1, deleted: 0 });
    expect(Number(await scalar(`SELECT quantity FROM inventory WHERE id = $1`, [targetInventoryId]))).toBe(2);

    const row = await cutover(id);
    expect(row.status).toBe("prepared");
    expect(row.finalize_started_at).toBeNull();
    expect(row.delta_summary.salesDelta.reconciliation.vouchersCreated).toBe(1);
    expect(row.delta_summary.salesRepair.blockers).toEqual([]);
    expect(row.delta_summary.containerDelta.reconciliation).toMatchObject({
      containersCreated: 1,
      otwVouchersCreated: 1,
      linesCreated: 1,
    });
    expect(row.delta_summary.containerRepair).toMatchObject({ headersUpdated: 1, linesRebuilt: 1, blockers: [] });
    expect(row.delta_summary.stockDelta).toMatchObject({ updated: 1, inserted: 0 });

    const migratedSale = await pool.query(
      `SELECT v.source_module, (SELECT COUNT(*)::int FROM voucher_entries e WHERE e.voucher_id = v.id) AS entries,
              (SELECT COUNT(*)::int FROM sales_items s WHERE s.voucher_id = v.id) AS items
         FROM vouchers v WHERE v.company_id = $1 AND v.voucher_number = $2`,
      [pair.targetId, `MIG-GC-${pair.code}-SV1`]
    );
    expect(migratedSale.rows[0]).toEqual({ source_module: "SP_MIGRATION_READONLY", entries: 2, items: 1 });
    const container = await pool.query(
      `SELECT c.status, c.notes, v.deleted_at FROM sp_containers c JOIN vouchers v ON v.id = c.goods_otw_voucher_id
        WHERE c.company_id = $1`,
      [pair.targetId]
    );
    expect(container.rows[0].status).toBe("open");
    expect(container.rows[0].notes).toMatch(/Migrated from .* ERP container/);
    expect(container.rows[0].deleted_at).toBeNull();

    // A second source location with no target counterpart blocks the exact stock
    // plan; the rerun reuses every migrated row before the stock step refuses.
    const orphanLocation = await insertLocation(pair.sourceId, `${pair.code}-SL2`, `${PREFIX} Orphan`);
    const orphanItem = await insertStockItem(pair.sourceId, `${pair.code}-ITEM-ORPHAN`);
    await insertInventory(pair.sourceId, orphanLocation, orphanItem, "1", "1", "1");

    const second = await finalize();
    expect(second.status).toBe(500);
    expect(second.body.message).toMatch(/has no safe target mapping/);
    const rerun = await cutover(id);
    expect(rerun.delta_summary.salesDelta.reconciliation).toMatchObject({ vouchersCreated: 0, vouchersReused: 1 });
    expect(rerun.delta_summary.salesRepair).toMatchObject({ itemsUpdated: 1, entriesUpdated: 2 });
    expect(rerun.delta_summary.containerDelta.reconciliation).toMatchObject({
      containersCreated: 0,
      containersUpgraded: 1,
      otwVouchersReused: 1,
    });
    expect(rerun.delta_summary.stockDelta).toBeUndefined();
    expect(Number(await scalar(`SELECT quantity FROM inventory WHERE id = $1`, [targetInventoryId]))).toBe(2);
  });
});
