/**
 * Supplier Partner cutover readiness build: every blocker and delta it reports
 * for a pair that is not ready, and a clean pass for a pair that is.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { buildCutoverReadiness } from "../server/routes/sp/spMigrationCutoverReadiness";
import {
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertAccount,
  insertInventory,
  insertLocation,
  insertRole,
  insertRun,
  insertStockItem,
  insertSupplier,
  insertUser,
  insertVoucher,
  linkRows,
  makePairReady,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_rbuild";
const READY_PREFIX = "spmigcov_rbuildok";
let pair: SpMigrationPair;
let ready: SpMigrationPair;

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  ready = await createSpMigrationPair(READY_PREFIX);
  await makePairReady(ready);

  const master = await insertRun(pair.sourceId, pair.targetId, "gc_stock_master");
  const tSales = await insertAccount(pair.targetId, "T-SALES", "Income", "sp_sales");
  const suspense = await insertAccount(pair.targetId, "GC-SUSP", "Equity", "gc_mig_suspense");

  // Inventory: one mapped row that differs, one unmapped item, one unmapped location.
  const sourceShop = await insertLocation(pair.sourceId, `${pair.code}-SL`, `${PREFIX} Shop`);
  const orphan = await insertLocation(pair.sourceId, `${pair.code}-OL`, `${PREFIX} Orphan`);
  const targetShop = await insertLocation(pair.targetId, `${pair.code}-TL`, `${PREFIX} Shop`);
  const s1 = await insertStockItem(pair.sourceId, `${pair.code}-S1`);
  const s2 = await insertStockItem(pair.sourceId, `${pair.code}-S2`);
  const t1 = await insertStockItem(pair.targetId, `${pair.code}-S1`);
  await linkRows(master, "stock_items", s1, "stock_items", t1);
  await insertInventory(pair.sourceId, sourceShop, s1, "5", "2", "10");
  await insertInventory(pair.sourceId, sourceShop, s2, "1", "1", "1");
  await insertInventory(pair.sourceId, orphan, s1, "1", "2", "2");
  await insertInventory(pair.targetId, targetShop, t1, "1", "2", "2");

  // An unmigrated sale and container.
  const cash = await insertAccount(pair.sourceId, "S-CASH", "Cash", null);
  const income = await insertAccount(pair.sourceId, "S-INC", "Income", null);
  await insertVoucher({
    companyId: pair.sourceId,
    number: `${pair.code}-SALE`,
    entries: [
      { accountId: cash, debit: "3", credit: "0" },
      { accountId: income, debit: "0", credit: "3" },
    ],
  });
  const supplier = await insertSupplier(pair.sourceId, `${pair.code}-SUP`, `${PREFIX} Supplier`);
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id) VALUES ($1, $2, '2026-09-06', $3) RETURNING id`,
    [pair.sourceId, `${pair.code}-CTR`, supplier]
  );

  // A migrated entry still in Migration Suspense, an unbalanced migrated voucher,
  // charges awaiting review, and a genuine target voucher.
  await insertVoucher({
    companyId: pair.targetId,
    number: `${pair.code}-SUSP`,
    sourceModule: "SP_MIGRATION_READONLY",
    entries: [
      { accountId: suspense, debit: "4", credit: "0" },
      { accountId: tSales, debit: "0", credit: "4" },
    ],
  });
  await insertVoucher({
    companyId: pair.targetId,
    number: `${pair.code}-UNBAL`,
    type: "Journal",
    sourceModule: "SP_MIGRATION",
    entries: [{ accountId: tSales, debit: "9", credit: "0" }],
    unbalanced: true,
  });
  const spContainer = await pool.query<{ id: number }>(
    `INSERT INTO sp_containers (company_id, supplier_name, invoice_number, invoice_date, notes)
     VALUES ($1, 'Supplier', 'INV', '2026-09-06', 'Migrated from fixture ERP container #x') RETURNING id`,
    [pair.targetId]
  );
  for (const status of ["review", "unmapped"]) {
    await pool.query(
      `INSERT INTO sp_migration_container_charges
         (run_id, source_company_id, target_company_id, source_container_id, sp_container_id, source_key, source_kind,
          charge_type, amount_usd, mapping_method, review_status)
       VALUES ($1, $2, $3, $4, $6, $5, 'container', 'Duty', 5, 'default_shared_charges', $5)`,
      [master, pair.sourceId, pair.targetId, container.rows[0].id, status, spContainer.rows[0].id]
    );
  }
  await insertVoucher({ companyId: pair.targetId, number: `${pair.code}-LIVE`, type: "Journal", sourceModule: "ERP" });

  // A POS user with no assignment the target can map.
  await insertRole(await insertUser(`${PREFIX}_pos`), pair.sourceId, "POS");
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
  await cleanupSpMigrationPair(READY_PREFIX);
}, 120000);

describe("buildCutoverReadiness", () => {
  it("reports every blocker and delta for a pair that is not ready", async () => {
    const readiness = await buildCutoverReadiness(pair.sourceId, pair.targetId);
    expect(readiness.blockers.map((issue) => issue.code)).toEqual([
      "MISSING_GC_STOCK_OPENING",
      "MISSING_GC_SALES_READONLY",
      "MISSING_GC_CONTAINERS",
      "MISSING_TARGET_ACCOUNTS",
      "UNMAPPED_INVENTORY",
      "SUSPENSE_REVIEW_REQUIRED",
      "CONTAINER_CHARGE_REVIEW_REQUIRED",
      "UNBALANCED_MIGRATION_VOUCHERS",
      "PROFIT_OPENING_MISSING",
      "TARGET_ALREADY_LIVE",
      "POS_ASSIGNMENT_MAPPING_MISSING",
    ]);
    expect(readiness.deltas.map((issue) => issue.code)).toEqual(["STOCK_DELTA", "SALES_DELTA", "CONTAINER_DELTA"]);
    expect(readiness.counts).toMatchObject({
      sourceInventoryRows: 3,
      stockDiffs: 1,
      unmappedInventory: 2,
      salesDelta: 1,
      containerDelta: 1,
      suspenseEntries: 1,
      chargeReview: 1,
      chargeUnmapped: 1,
      unbalancedVouchers: 1,
      unmappablePosUsers: 1,
    });
    expect(readiness.unmappedInventory.map((row) => row.missing).sort()).toEqual(["location", "stock_item"]);
    expect(readiness.stockDiffs[0]).toMatchObject({ sourceQty: 5, targetQty: 1 });
    expect(readiness.blockers[3].count).toBe(15);
    expect(readiness).toMatchObject({ canPrepare: false, canFinalize: false });
  });

  it("passes a pair whose prerequisites are all in place", async () => {
    const readiness = await buildCutoverReadiness(ready.sourceId, ready.targetId);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.deltas).toEqual([]);
    expect(readiness).toMatchObject({ canPrepare: true, canFinalize: true });
  });
});
