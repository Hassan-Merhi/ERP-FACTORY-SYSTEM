/**
 * Supplier Partner Phase 2 container copy (gc-containers): refusals, the
 * container/Goods-OTW voucher/line/charge copy, the idempotent rerun that
 * reuses every row, the warnings for what cannot be copied, and the failure
 * path that marks the run failed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { registerSpMigrationPhase2Routes } from "../server/routes/sp/spMigrationPhase2Routes";
import { findExistingContainerLink } from "../server/routes/sp/spMigrationPhase2Common";
import {
  captureRouteHandlers,
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertAccount,
  insertRun,
  insertStockItem,
  insertSupplier,
  insertVoucher,
  linkRows,
  pairBody,
  scalar,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_p2ctr";
const BARE_PREFIX = "spmigcov_p2ctrbare";
let pair: SpMigrationPair;
let bare: SpMigrationPair;
const ids: Record<string, number> = {};
const { call } = captureRouteHandlers((app) => registerSpMigrationPhase2Routes(app));
const importContainers = (p: SpMigrationPair, extra: Record<string, unknown> = {}) =>
  call("POST /api/sp/migration/gc-containers", { body: pairBody(p, { confirmation: "MIGRATE", ...extra }) });

async function sourceContainer(
  p: SpMigrationPair,
  number: string,
  fields: { status: string; itemName?: string | null; itemsTotal?: string; chargesTotal?: string; dutyFee?: string }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, item_name, total_kg,
                             items_total, rate_per_kg, charges_total, duty_fee)
     VALUES ($1, $2, '2026-09-05', $3, $4, $5, 4, $6, 10, $7, $8) RETURNING id`,
    [
      p.sourceId,
      `${p.code}-${number}`,
      ids.supplier,
      fields.status,
      fields.itemName ?? null,
      fields.itemsTotal ?? "40",
      fields.chargesTotal ?? "0",
      fields.dutyFee ?? null,
    ]
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  bare = await createSpMigrationPair(BARE_PREFIX);
  ids.supplier = await insertSupplier(pair.sourceId, `${pair.code}-SUP`, `${PREFIX} Supplier`);
  await insertAccount(pair.targetId, "T-OTW", "Asset", "sp_goods_otw");
  await insertAccount(pair.targetId, "T-OTWC", "Liability", "sp_otw_clearing");
  await insertAccount(pair.targetId, "T-SHARED", "Expense", "sp_shared_charges");
  ids.tDuty = await insertAccount(pair.targetId, "T-DUTY", "Expense", "sp_duty");
  ids.sDuty = await insertAccount(pair.sourceId, "S-DUTY", "Expense", "sp_duty");
  ids.s1 = await insertStockItem(pair.sourceId, `${pair.code}-S1`);
  ids.s2 = await insertStockItem(pair.sourceId, `${pair.code}-S2`);
  ids.t1 = await insertStockItem(pair.targetId, `${pair.code}-S1`);
  const master = await insertRun(pair.sourceId, pair.targetId, "gc_stock_master");
  await linkRows(master, "stock_items", ids.s1, "stock_items", ids.t1);
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
  await cleanupSpMigrationPair(BARE_PREFIX);
}, 120000);

describe("gc-containers refusals", () => {
  it("requires confirmation and a completed stock-opening step", async () => {
    expect((await importContainers(pair, { confirmation: "NO" })).status).toBe(400);
    const dependency = await importContainers(pair);
    expect(dependency).toMatchObject({
      status: 409,
      body: { message: "Run Step 5 — Stock Opening by Location successfully first." },
    });
    expect(await scalar(`SELECT COUNT(*)::int FROM sp_containers WHERE company_id = $1`, [pair.targetId])).toBe(0);
  });
});

describe("gc-containers copy", () => {
  it("copies containers, Goods-OTW vouchers, lines and charges, then reuses them", async () => {
    await insertRun(pair.sourceId, pair.targetId, "gc_stock_opening");
    // K1: open container with a PO (charges) and a custom charge on a mapped account.
    const k1 = await sourceContainer(pair, "K1", { status: "OTW", itemName: `${pair.code}-S1`, chargesTotal: "20" });
    await pool.query(
      `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, items_total, freight, surcharge, discount)
       VALUES ($1, $2, $3, $4, 60, 4, 3, 1)`,
      [pair.sourceId, k1, `${pair.code}-PO1`, ids.supplier]
    );
    await pool.query(
      `INSERT INTO container_charges (container_id, charge_type, amount, ledger_account_id) VALUES ($1, 'Duty', 7, $2)`,
      [k1, ids.sDuty]
    );
    // K2: offloaded with no line data and a tracking-level duty fee.
    await sourceContainer(pair, "K2", { status: "Offloaded", dutyFee: "2" });
    // K3: open with a zero invoice.
    await sourceContainer(pair, "K3", { status: "open", itemsTotal: "0", itemName: `${pair.code}-S2` });
    // K4: already copied by an older run, found by its number.
    await sourceContainer(pair, "K4", { status: "Offloaded" });
    const legacy = await pool.query<{ id: number }>(
      `INSERT INTO sp_containers (company_id, supplier_name, container_number, invoice_number, invoice_date, status, notes)
       VALUES ($1, 'Old', $2, 'X', '2026-09-05', 'offloaded', 'Migrated from Old ERP container #K4') RETURNING id`,
      [pair.targetId, `${pair.code}-K4`]
    );
    // K5: open; its deterministic OTW voucher already exists unlinked.
    const k5 = await sourceContainer(pair, "K5", { status: "OTW" });
    const k5Voucher = await insertVoucher({
      companyId: pair.targetId,
      number: `GC-OTW-${pair.targetId}-${k5}`,
      type: "Journal",
      sourceModule: "SP_MIGRATION",
    });

    const first = await importContainers(pair);
    expect(first.status).toBe(200);
    expect(first.body.reconciliation).toEqual({
      containersCreated: 4,
      containersUpgraded: 1,
      supplierMatched: 5,
      supplierUnmatched: 0,
      linesCreated: 2,
      linesUnresolved: 3,
      otwVouchersCreated: 1,
      otwVouchersReused: 1,
      chargeMapped: 1,
      chargeReview: 4,
      chargeUnmapped: 0,
    });
    expect(first.body.warnings).toEqual(
      expect.arrayContaining([
        `Container ${pair.code}-K3: invoice total is zero; no OTW voucher was created.`,
        `Container ${pair.code}-K3: stock item ${ids.s2} has no target mapping.`,
        `Container ${pair.code}-K2: no PO, offload-item, or usable container-summary line data was found.`,
        "Review defaulted and unmapped container charges before production cutover.",
      ])
    );
    const k1Target = await findExistingContainerLink(pair.sourceId, pair.targetId, k1);
    const header = await pool.query(
      `SELECT c.invoice_number, c.invoice_total_usd, c.freight_estimate_usd, c.status, v.voucher_number,
              (SELECT SUM(debit_amount) FROM voucher_entries WHERE voucher_id = v.id) AS debit
         FROM sp_containers c JOIN vouchers v ON v.id = c.goods_otw_voucher_id WHERE c.id = $1`,
      [k1Target]
    );
    expect(header.rows[0]).toEqual({
      invoice_number: `${pair.code}-PO1`,
      invoice_total_usd: "60.0000",
      freight_estimate_usd: "4.0000",
      status: "open",
      voucher_number: `GC-OTW-${pair.targetId}-${k1}`,
      debit: "60.00",
    });
    expect(await findExistingContainerLink(pair.sourceId, pair.targetId, 2147480001)).toBeNull();
    expect(await scalar(`SELECT notes FROM sp_containers WHERE id = $1`, [legacy.rows[0].id])).toMatch(
      /supplier match: source_id/
    );
    expect(await scalar(`SELECT COUNT(*)::int FROM voucher_entries WHERE voucher_id = $1`, [k5Voucher.voucherId])).toBe(
      2
    );

    const second = await importContainers(pair);
    expect(second.status).toBe(200);
    expect(second.body.reconciliation).toMatchObject({
      containersCreated: 0,
      containersUpgraded: 5,
      linesCreated: 0,
      otwVouchersCreated: 0,
      otwVouchersReused: 2,
    });
    expect(second.body.rowsCreated).toBe(0);
    const review = await call("GET /api/sp/migration/gc-container-charge-review", { query: pairBody(pair) });
    expect(review.body).toMatchObject({ count: 5, mapped: 1, review: 4, unmapped: 0 });
  });

  it("warns instead of posting when the target has no Goods-OTW accounts", async () => {
    await insertRun(bare.sourceId, bare.targetId, "gc_stock_opening");
    await pool.query(
      `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, items_total)
       VALUES ($1, $2, '2026-09-05', $3, 'OTW', 10)`,
      [bare.sourceId, `${bare.code}-B1`, ids.supplier]
    );
    const result = await importContainers(bare);
    expect(result.status).toBe(200);
    expect(result.body.warnings).toContain(
      `Container ${bare.code}-B1: Goods-OTW accounts are missing; no OTW voucher was created.`
    );
    expect(await scalar(`SELECT COUNT(*)::int FROM vouchers WHERE company_id = $1`, [bare.targetId])).toBe(0);
  });

  it("marks the run failed when a Goods-OTW voucher cannot be written", async () => {
    const k6 = await sourceContainer(bare, "B2", { status: "OTW" });
    await insertAccount(bare.targetId, "B-OTW", "Asset", "sp_goods_otw");
    await insertAccount(bare.targetId, "B-OTWC", "Liability", "sp_otw_clearing");
    // The deterministic voucher number is held by another company, so the insert fails.
    const blocker = await insertVoucher({
      companyId: bare.sourceId,
      number: `GC-OTW-${bare.targetId}-${k6}`,
      type: "Journal",
    });
    const result = await importContainers(bare);
    expect(result.status).toBe(500);
    expect(result.body.message).toMatch(/^Container migration failed:/);
    expect(await scalar(`SELECT status FROM sp_migration_rehearsal_runs WHERE id = $1`, [result.body.runId])).toBe(
      "failed"
    );
    await pool.query(`DELETE FROM vouchers WHERE id = $1`, [blocker.voucherId]);
  });
});
