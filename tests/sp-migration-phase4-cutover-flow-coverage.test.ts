/**
 * The complete Supplier Partner cutover against a real database: prepare locks
 * a ready pair, finalize synchronizes sales, containers and stock, moves the
 * ERP users and their sessions to the Supplier Partner company and activates
 * the cutover, rollback puts users and stock back, and the post-rollback hold
 * on the target is released.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { registerSpMigrationPhase4Routes } from "../server/routes/sp/spMigrationPhase4Routes";
import {
  captureRouteHandlers,
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertAccount,
  insertInventory,
  insertLocation,
  insertRole,
  insertSaleItem,
  insertSession,
  insertStockItem,
  insertSupplier,
  insertUser,
  insertVoucher,
  linkRows,
  makePairReady,
  pairBody,
  scalar,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_p4flow";
let pair: SpMigrationPair;
let targetInventoryId: number;
let sourceLocationId: number;
let targetLocationId: number;
let managerId: string;
const { call } = captureRouteHandlers((app) => registerSpMigrationPhase4Routes(app));

async function cutover(id: number) {
  return (await pool.query(`SELECT * FROM sp_migration_cutovers WHERE id = $1`, [id])).rows[0];
}

async function managerCompanies(): Promise<number[]> {
  const result = await pool.query(`SELECT company_id FROM user_company_roles WHERE user_id = $1 ORDER BY company_id`, [
    managerId,
  ]);
  return result.rows.map((row) => row.company_id);
}

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  await makePairReady(pair);
  const cash = await insertAccount(pair.sourceId, "S-CASH", "Cash", "sp_payable");
  const sales = await insertAccount(pair.sourceId, "S-SALES", "Income", "sp_sales");

  sourceLocationId = await insertLocation(pair.sourceId, `${pair.code}-SL`, `${PREFIX} Main`);
  targetLocationId = await insertLocation(pair.targetId, `${pair.code}-TL`, `${PREFIX} Main`);
  const sourceItem = await insertStockItem(pair.sourceId, `${pair.code}-ITEM`);
  const targetItem = await insertStockItem(pair.targetId, `${pair.code}-ITEM`);
  const master = await pool.query<{ id: string }>(
    `SELECT id FROM sp_migration_rehearsal_runs WHERE source_company_id = $1 AND action = 'gc_stock_master'`,
    [pair.sourceId]
  );
  await linkRows(master.rows[0].id, "stock_items", sourceItem, "stock_items", targetItem);
  await insertInventory(pair.sourceId, sourceLocationId, sourceItem, "7", "3", "21");
  targetInventoryId = await insertInventory(pair.targetId, targetLocationId, targetItem, "2", "3", "6");

  const sale = await insertVoucher({
    companyId: pair.sourceId,
    number: `${pair.code}-SV1`,
    total: "30",
    entries: [
      { accountId: cash, debit: "30", credit: "0" },
      { accountId: sales, debit: "0", credit: "30" },
    ],
  });
  await insertSaleItem(sale.voucherId, sourceItem);
  const supplierId = await insertSupplier(pair.sourceId, `${pair.code}-SUP`, `${PREFIX} Supplier`);
  await pool.query(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, item_name, total_kg, items_total, rate_per_kg)
     VALUES ($1, $2, '2026-09-02', $3, 'OTW', $4, 5, 50, 10)`,
    [pair.sourceId, `${pair.code}-CTR`, supplierId, `${pair.code}-ITEM`]
  );

  managerId = await insertUser(`${PREFIX}_manager`);
  await insertRole(managerId, pair.sourceId, "Manager", { assignedLocationId: sourceLocationId });
  await insertSession(PREFIX, `${PREFIX}-sid`, managerId, pair.sourceId);
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
}, 120000);

describe("Supplier Partner cutover lifecycle", () => {
  it("prepares, finalizes, rolls back and releases the target hold", async () => {
    const prepared = await call("POST /api/sp/migration/cutover", {
      body: pairBody(pair, { action: "prepare", confirmation: "PREPARE CUTOVER", rollbackWindowHours: 24 }),
    });
    expect(prepared.status).toBe(200);
    expect(prepared.body.verification.blockers).toEqual([]);
    expect(prepared.body.verification.overall).toBe("WARN");
    const id = Number(prepared.body.cutover.id);
    expect(prepared.body.cutover).toMatchObject({ status: "prepared", rollback_window_hours: 24 });

    const finalized = await call("POST /api/sp/migration/cutover/finalize", {
      body: pairBody(pair, { confirmation: "FINALIZE CUTOVER" }),
    });
    expect(finalized.status).toBe(200);
    expect(finalized.body.verification).toMatchObject({ overall: "PASS", blockers: [], deltas: [] });
    expect(finalized.body.roleSummary).toMatchObject({ usersMoved: 1, sessionsSwitched: 1, targetRolesCreated: 1 });
    expect(finalized.body.deltaSummary.stockDelta).toMatchObject({ updated: 1 });
    const active = await cutover(id);
    expect(active.status).toBe("active");
    expect(active.target_write_hold).toBe(false);
    const windowHours =
      (new Date(active.rollback_deadline).getTime() - new Date(active.activated_at).getTime()) / 3.6e6;
    expect(Math.round(windowHours)).toBe(24);
    expect(await managerCompanies()).toEqual([pair.targetId]);
    expect(Number(await scalar(`SELECT quantity FROM inventory WHERE id = $1`, [targetInventoryId]))).toBe(7);
    expect(
      Number(await scalar(`SELECT sess->>'currentCompanyId' FROM session WHERE sid = $1`, [`${PREFIX}-sid`]))
    ).toBe(pair.targetId);

    const status = await call("GET /api/sp/migration/cutover", { query: pairBody(pair) });
    expect(status.body.liveCutover.status).toBe("active");

    const rolledBack = await call("POST /api/sp/migration/cutover", {
      body: {
        action: "rollback",
        cutoverId: id,
        confirmation: "ROLLBACK CUTOVER",
        companyNameConfirm: pair.sourceName,
      },
    });
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.body.users).toMatchObject({ usersRestored: 1, targetRolesRemoved: 1 });
    expect(rolledBack.body.stock).toEqual({ restored: 1, deleted: 0 });
    expect(await managerCompanies()).toEqual([pair.sourceId]);
    expect(Number(await scalar(`SELECT quantity FROM inventory WHERE id = $1`, [targetInventoryId]))).toBe(2);
    expect(await scalar(`SELECT assigned_location_id FROM user_company_roles WHERE user_id = $1`, [managerId])).toBe(
      sourceLocationId
    );
    expect((await cutover(id)).target_write_hold).toBe(true);

    const released = await call("POST /api/sp/migration/cutover", {
      body: {
        action: "release-target-hold",
        cutoverId: id,
        confirmation: "RELEASE TARGET HOLD",
        companyNameConfirm: pair.sourceName,
      },
    });
    expect(released.status).toBe(200);
    expect((await cutover(id)).target_write_hold).toBe(false);
  });
});
