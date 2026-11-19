/**
 * Supplier Partner Phase 4 repairs of the read-only migration copy: historical
 * sale vouchers (items and accounting lines) and migration-owned containers.
 * Each repair either fixes a row it can prove belongs to the migration or
 * reports a blocker and leaves the row alone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import {
  reconcileHistoricalSalesCopy,
  reconcileMigrationOwnedContainers,
} from "../server/routes/sp/spMigrationPhase4Reconcile";
import {
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertAccount,
  insertRun,
  insertSaleItem,
  insertStockItem,
  insertSupplier,
  insertVoucher,
  linkRows,
  scalar,
  trackFixtureRow,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_p4rec";
const NO_SUSPENSE_PREFIX = "spmigcov_p4recns";
let pair: SpMigrationPair;
let noSuspense: SpMigrationPair;
let runId: string;
const ids: Record<string, number> = {};

async function entryAccounts(voucherId: number): Promise<number[]> {
  const result = await pool.query(`SELECT ledger_account_id FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [
    voucherId,
  ]);
  return result.rows.map((row) => row.ledger_account_id);
}

async function container(
  number: string,
  status: string,
  extra: { itemName?: string | null; poNumber?: string } = {}
): Promise<{ sourceId: number; spId: number }> {
  const source = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, item_name, total_kg, items_total, rate_per_kg)
     VALUES ($1, $2, '2026-09-03', $3, $4, $5, 4, 40, 10) RETURNING id`,
    [pair.sourceId, `${pair.code}-${number}`, ids.supplier, status, extra.itemName ?? null]
  );
  const sourceId = source.rows[0].id;
  if (extra.poNumber) {
    await pool.query(
      `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, items_total, freight)
       VALUES ($1, $2, $3, $4, 55, 5)`,
      [pair.sourceId, sourceId, extra.poNumber, ids.supplier]
    );
  }
  const sp = await pool.query<{ id: number }>(
    `INSERT INTO sp_containers (company_id, supplier_name, container_number, invoice_number, invoice_date, status, notes)
     VALUES ($1, 'old', $2, 'old', '2026-01-01', 'open', 'Migrated from X ERP container #old') RETURNING id`,
    [pair.targetId, `${pair.code}-${number}`]
  );
  await linkRows(runId, "containers", sourceId, "sp_containers", sp.rows[0].id);
  return { sourceId, spId: sp.rows[0].id };
}

async function otwVoucher(sourceContainerId: number, sourceModule: string, deleted: boolean, number?: string) {
  const { voucherId } = await insertVoucher({
    companyId: pair.targetId,
    number: number ?? `GC-OTW-${pair.targetId}-${sourceContainerId}`,
    type: "Journal",
    sourceModule,
  });
  if (deleted) await pool.query(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [voucherId]);
  return voucherId;
}

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  noSuspense = await createSpMigrationPair(NO_SUSPENSE_PREFIX);
  runId = await insertRun(pair.sourceId, pair.targetId, "gc_sales_readonly");

  ids.suspense = await insertAccount(pair.targetId, "GC-SUSP", "Equity", "gc_mig_suspense");
  ids.tSales = await insertAccount(pair.targetId, "T-SALES", "Income", "sp_sales");
  ids.tShared = await insertAccount(pair.targetId, "T-SHARED", "Expense", "sp_shared_charges");
  ids.tByCode = await insertAccount(pair.targetId, "SHARED-CODE", "Asset", null);
  ids.sSales = await insertAccount(pair.sourceId, "S-SALES", "Income", "sp_sales");
  ids.sByCode = await insertAccount(pair.sourceId, "shared-code", "Asset", null);
  ids.sExpense = await insertAccount(pair.sourceId, "S-EXP", "Expense", null);
  ids.sOther = await insertAccount(pair.sourceId, "S-OTHER", "Asset", null);

  ids.s1 = await insertStockItem(pair.sourceId, `${pair.code}-S1`);
  ids.s2 = await insertStockItem(pair.sourceId, `${pair.code}-S2`);
  ids.t1 = await insertStockItem(pair.targetId, `${pair.code}-T1`);
  await linkRows(runId, "stock_items", ids.s1, "stock_items", ids.t1);
  ids.supplier = await insertSupplier(pair.sourceId, `${pair.code}-SUP`, `${PREFIX} Supplier`);
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
  await cleanupSpMigrationPair(NO_SUSPENSE_PREFIX);
}, 120000);

describe("reconcileHistoricalSalesCopy", () => {
  it("refuses to run without the target's Migration Suspense account", async () => {
    await expect(
      reconcileHistoricalSalesCopy({ runId, sourceId: noSuspense.sourceId, targetId: noSuspense.targetId })
    ).rejects.toThrow("Migration Suspense account is missing.");
  });

  it("repairs provable rows and reports every ambiguous one", async () => {
    const two = (debitAccount: number, creditAccount: number, amount = "10") => [
      { accountId: debitAccount, debit: amount, credit: "0" },
      { accountId: creditAccount, debit: "0", credit: amount },
    ];
    // V1: target copy lost its lines and item -> both are rebuilt; an unmapped item is a blocker.
    const v1 = await insertVoucher({
      companyId: pair.sourceId,
      number: `${pair.code}-V1`,
      entries: two(ids.sSales, ids.sByCode),
    });
    await insertSaleItem(v1.voucherId, ids.s1);
    await insertSaleItem(v1.voucherId, ids.s2);
    const t1 = await insertVoucher({
      companyId: pair.targetId,
      number: `MIG-GC-${pair.code}-V1`,
      sourceModule: "SP_MIGRATION_READONLY",
    });

    // V2: equal line counts are paired in order; two identical target items are ambiguous.
    const v2 = await insertVoucher({
      companyId: pair.sourceId,
      number: `${pair.code}-V2`,
      entries: two(ids.sExpense, ids.sOther, "5"),
    });
    await insertSaleItem(v2.voucherId, ids.s1, "1");
    const t2 = await insertVoucher({
      companyId: pair.targetId,
      number: `MIG-GC-${pair.code}-V2`,
      entries: two(ids.tShared, ids.suspense, "5"),
    });
    await insertSaleItem(t2.voucherId, ids.t1, "1");
    await insertSaleItem(t2.voucherId, ids.t1, "1");

    // V3: no target copy at all.
    await insertVoucher({ companyId: pair.sourceId, number: `${pair.code}-V3`, entries: two(ids.sSales, ids.sOther) });

    // V4: already linked header, lines and one item; a second item matches exactly one target item.
    const v4 = await insertVoucher({
      companyId: pair.sourceId,
      number: `${pair.code}-V4`,
      entries: two(ids.sSales, ids.sOther, "7"),
    });
    const v4Linked = await insertSaleItem(v4.voucherId, ids.s1, "2");
    await insertSaleItem(v4.voucherId, ids.s1, "3");
    const t4 = await insertVoucher({
      companyId: pair.targetId,
      number: `${pair.code}-T4`,
      entries: two(ids.tSales, ids.suspense, "1"),
    });
    const t4Linked = await insertSaleItem(t4.voucherId, ids.t1, "9");
    const t4Match = await insertSaleItem(t4.voucherId, ids.t1, "3");
    await linkRows(runId, "vouchers", v4.voucherId, "vouchers", t4.voucherId);
    await linkRows(runId, "sales_items", v4Linked, "sales_items", t4Linked);
    await linkRows(runId, "voucher_entries", v4.entryIds[0], "voucher_entries", t4.entryIds[0]);
    await linkRows(runId, "voucher_entries", v4.entryIds[1], "voucher_entries", t4.entryIds[1]);

    // V5: three source lines, two target lines -> the shortfall does not match; V6: target has more lines.
    await insertVoucher({
      companyId: pair.sourceId,
      number: `${pair.code}-V5`,
      entries: [
        { accountId: ids.sSales, debit: "10", credit: "0" },
        { accountId: ids.sOther, debit: "0", credit: "5" },
        { accountId: ids.sOther, debit: "0", credit: "5" },
      ],
    });
    await insertVoucher({
      companyId: pair.targetId,
      number: `MIG-GC-${pair.code}-V5`,
      entries: two(ids.tSales, ids.suspense),
    });
    await insertVoucher({ companyId: pair.sourceId, number: `${pair.code}-V6`, entries: two(ids.sSales, ids.sOther) });
    await insertVoucher({
      companyId: pair.targetId,
      number: `MIG-GC-${pair.code}-V6`,
      entries: [
        { accountId: ids.tSales, debit: "10", credit: "0" },
        { accountId: ids.suspense, debit: "0", credit: "5" },
        { accountId: ids.suspense, debit: "0", credit: "5" },
      ],
    });

    const result = await reconcileHistoricalSalesCopy({ runId, sourceId: pair.sourceId, targetId: pair.targetId });
    expect(result).toMatchObject({
      vouchersUpdated: 5,
      itemsInserted: 1,
      itemsUpdated: 1,
      itemLinksAdded: 1,
      entriesInserted: 2,
      entriesUpdated: 2,
      entryLinksAdded: 2,
    });
    expect(result.blockers).toEqual([
      `Sale item ${(await pool.query(`SELECT id FROM sales_items WHERE voucher_id = $1 AND stock_item_id = $2`, [v1.voucherId, ids.s2])).rows[0].id} has no target stock-item mapping.`,
      expect.stringMatching(/^Sale item \d+ has 2 ambiguous target matches\.$/),
      `Sale voucher ${pair.code}-V3 has no migrated target voucher.`,
      `Voucher ${pair.code}-V5 has an ambiguous entry-count mismatch.`,
      `Voucher ${pair.code}-V6 has unlinked entries that cannot be paired safely.`,
    ]);
    // Rebuilt V1 lines map by sub-type and by code.
    expect(await entryAccounts(t1.voucherId)).toEqual([ids.tSales, ids.tByCode]);
    expect(Number(await scalar(`SELECT quantity FROM sales_items WHERE id = $1`, [t4Linked]))).toBe(2);
    expect(
      await scalar(
        `SELECT COUNT(*)::int FROM sp_migration_source_links WHERE run_id = $1 AND source_table = 'sales_items' AND target_id = $2`,
        [runId, t4Match]
      )
    ).toBe(1);
    expect(Number(await scalar(`SELECT debit_amount FROM voucher_entries WHERE id = $1`, [t4.entryIds[0]]))).toBe(7);
    expect(await scalar(`SELECT notes FROM sp_migration_rehearsal_runs WHERE id = $1`, [runId])).toMatch(
      /Phase 4 repaired 3 readonly child row\(s\)/
    );
  });
});

describe("reconcileMigrationOwnedContainers", () => {
  it("rebuilds migration-owned containers and refuses what it cannot prove", async () => {
    const retired = await container("C1", "Offloaded", { itemName: `${pair.code}-S1` });
    const retiredVoucher = await otwVoucher(retired.sourceId, "SP_MIGRATION", false);
    await pool.query(`UPDATE sp_containers SET goods_otw_voucher_id = $1 WHERE id = $2`, [
      retiredVoucher,
      retired.spId,
    ]);
    const oldLine = await pool.query<{ id: number }>(
      `INSERT INTO sp_container_lines (container_id, company_id, article_code, qty, unit_rate_usd) VALUES ($1, $2, 'OLD', 1, 1) RETURNING id`,
      [retired.spId, pair.targetId]
    );
    await trackFixtureRow(runId, "sp_container_lines", oldLine.rows[0].id);

    const noLines = await container("C2", "Offloaded");
    const reopened = await container("C3", "OTW", { itemName: `${pair.code}-S1` });
    const reopenedVoucher = await otwVoucher(reopened.sourceId, "SP_MIGRATION", true);
    await pool.query(
      `INSERT INTO sp_container_lines (container_id, company_id, article_code, qty, unit_rate_usd) VALUES ($1, $2, 'MANUAL', 1, 1)`,
      [reopened.spId, pair.targetId]
    );
    const foreign = await container("C4", "Offloaded", { itemName: `${pair.code}-S2`, poNumber: `${pair.code}-PO4` });
    const foreignVoucher = await otwVoucher(foreign.sourceId, "ERP", false, `${pair.code}-MANUAL-OTW`);
    await pool.query(`UPDATE sp_containers SET goods_otw_voucher_id = $1 WHERE id = $2`, [
      foreignVoucher,
      foreign.spId,
    ]);
    await container("C5", "open", { itemName: `${pair.code}-S1` });

    const result = await reconcileMigrationOwnedContainers({
      runId,
      sourceId: pair.sourceId,
      targetId: pair.targetId,
      sourceCompanyName: pair.sourceName,
    });
    expect(result).toMatchObject({
      headersUpdated: 5,
      linesRebuilt: 2,
      otwVouchersRetired: 1,
      otwVouchersReactivated: 1,
    });
    expect(result.blockers).toEqual([
      `Container ${pair.code}-C2: no recoverable source line data exists.`,
      `Container ${pair.code}-C3: 1 untracked target line(s) prevent automatic line rebuilding.`,
      `Container ${pair.code}-C4: line item ${ids.s2} has no target mapping.`,
      `Container ${pair.code}-C4: linked OTW voucher is not safely migration-owned.`,
    ]);

    const c1 = await pool.query(`SELECT status, goods_otw_voucher_id, supplier_id FROM sp_containers WHERE id = $1`, [
      retired.spId,
    ]);
    expect(c1.rows[0]).toEqual({ status: "offloaded", goods_otw_voucher_id: null, supplier_id: ids.supplier });
    expect(await scalar(`SELECT deleted_at IS NOT NULL FROM vouchers WHERE id = $1`, [retiredVoucher])).toBe(true);
    expect(await scalar(`SELECT article_code FROM sp_container_lines WHERE container_id = $1`, [retired.spId])).toBe(
      `${pair.code}-S1`
    );
    expect(await scalar(`SELECT goods_otw_voucher_id FROM sp_containers WHERE id = $1`, [reopened.spId])).toBe(
      reopenedVoucher
    );
    expect(await scalar(`SELECT deleted_at FROM vouchers WHERE id = $1`, [reopenedVoucher])).toBeNull();
    const c4 = await pool.query(
      `SELECT invoice_number, invoice_total_usd, goods_otw_voucher_id FROM sp_containers WHERE id = $1`,
      [foreign.spId]
    );
    expect(c4.rows[0]).toEqual({
      invoice_number: `${pair.code}-PO4`,
      invoice_total_usd: "55.0000",
      goods_otw_voucher_id: foreignVoucher,
    });
    expect(await scalar(`SELECT deleted_at FROM vouchers WHERE id = $1`, [foreignVoucher])).toBeNull();
    expect(noLines.spId).toBeGreaterThan(0);
  });
});
