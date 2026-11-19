/**
 * Supplier Partner Phase 2 historical-sales copy (gc-sales-readonly): its
 * confirmation and dependency refusals, the account-mapping policy and the
 * Migration Suspense fallback, the idempotent rerun, and the failure path that
 * marks the run failed. Also the shared pair/supplier/suspense helpers it uses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { registerSpMigrationPhase2Routes } from "../server/routes/sp/spMigrationPhase2Routes";
import {
  getSuspenseReview,
  mapTargetAccount,
  requireCompletedAction,
  resolveSupplier,
} from "../server/routes/sp/spMigrationPhase2Common";
import {
  captureRouteHandlers,
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertAccount,
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

const PREFIX = "spmigcov_p2sales";
let pair: SpMigrationPair;
const ids: Record<string, number> = {};
const { call } = captureRouteHandlers((app) => registerSpMigrationPhase2Routes(app));
const importSales = (body: Record<string, unknown>) => call("POST /api/sp/migration/gc-sales-readonly", { body });

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  ids.tSales = await insertAccount(pair.targetId, "T-SALES", "Income", "sp_sales");
  ids.tShared = await insertAccount(pair.targetId, "T-SHARED", "Expense", "sp_shared_charges");
  ids.tCode = await insertAccount(pair.targetId, "BANK-CODE", "Bank", null);
  ids.sSales = await insertAccount(pair.sourceId, "S-SALES", "Income", "sp_sales");
  ids.sCode = await insertAccount(pair.sourceId, "bank-code", "Bank", null);
  ids.sExpense = await insertAccount(pair.sourceId, "S-EXP", "Expense", null);
  ids.sOther = await insertAccount(pair.sourceId, "S-OTHER", "Asset", null);
  ids.s1 = await insertStockItem(pair.sourceId, `${pair.code}-S1`);
  ids.s2 = await insertStockItem(pair.sourceId, `${pair.code}-S2`);
  ids.t1 = await insertStockItem(pair.targetId, `${pair.code}-S1`);
  const master = await insertRun(pair.sourceId, pair.targetId, "gc_stock_master");
  await linkRows(master, "stock_items", ids.s1, "stock_items", ids.t1);
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
}, 120000);

describe("gc-sales-readonly refusals", () => {
  it("requires the MIGRATE confirmation and the exact source name", async () => {
    expect(await importSales(pairBody(pair))).toMatchObject({
      status: 400,
      body: { message: 'Requires confirmation = "MIGRATE"' },
    });
    const wrongName = await importSales(pairBody(pair, { confirmation: "MIGRATE", companyNameConfirm: "Other" }));
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.message).toContain(pair.sourceName);
    expect((await importSales(pairBody(pair, { confirmation: "MIGRATE", companyNameConfirm: "" }))).status).toBe(400);
  });

  it("requires a completed stock-opening step and records no run", async () => {
    const result = await importSales(pairBody(pair, { confirmation: "MIGRATE" }));
    expect(result).toMatchObject({
      status: 409,
      body: { message: "Run Step 5 — Stock Opening by Location successfully first." },
    });
    expect(
      await scalar(
        `SELECT COUNT(*)::int FROM sp_migration_rehearsal_runs WHERE target_company_id = $1 AND action = 'gc_sales_readonly'`,
        [pair.targetId]
      )
    ).toBe(0);
  });
});

describe("gc-sales-readonly copy", () => {
  it("copies sales with mapped accounts, then reuses and links them on a rerun", async () => {
    const opening = await insertRun(pair.sourceId, pair.targetId, "gc_stock_opening");
    const first = await insertVoucher({
      companyId: pair.sourceId,
      number: `${pair.code}-A`,
      total: "20",
      entries: [
        { accountId: ids.sCode, debit: "20", credit: "0" },
        { accountId: ids.sSales, debit: "0", credit: "12" },
        { accountId: ids.sExpense, debit: "0", credit: "5" },
        { accountId: ids.sOther, debit: "0", credit: "3" },
      ],
    });
    await insertSaleItem(first.voucherId, ids.s1);
    await insertSaleItem(first.voucherId, ids.s2);

    const run1 = await importSales(pairBody(pair, { confirmation: "MIGRATE" }));
    expect(run1.status).toBe(200);
    expect(run1.body.reconciliation).toEqual({
      vouchersCreated: 1,
      vouchersReused: 0,
      entriesCreated: 4,
      saleItemsCreated: 1,
      saleItemsSkipped: 1,
      entryLinksBackfilled: 0,
    });
    expect(run1.body.suspenseReview.count).toBe(1);
    expect(run1.body.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`stock item ${ids.s2} has no target mapping`),
        expect.stringContaining("Migration Suspense contains 1 entry row(s)"),
      ])
    );
    const suspenseId = await scalar<number>(
      `SELECT id FROM ledger_accounts WHERE company_id = $1 AND sub_type = 'gc_mig_suspense'`,
      [pair.targetId]
    );
    const copied = await pool.query(
      `SELECT e.ledger_account_id FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
        WHERE v.company_id = $1 AND v.voucher_number = $2 ORDER BY e.id`,
      [pair.targetId, `MIG-GC-${pair.code}-A`]
    );
    expect(copied.rows.map((row) => row.ledger_account_id)).toEqual([ids.tCode, ids.tSales, ids.tShared, suspenseId]);
    expect(await scalar(`SELECT status FROM sp_migration_rehearsal_runs WHERE id = $1`, [run1.body.runId])).toBe(
      "completed"
    );

    // An older copy with a different number of lines is reused but not guessed.
    const legacy = await insertVoucher({
      companyId: pair.sourceId,
      number: `${pair.code}-B`,
      entries: [
        { accountId: ids.sCode, debit: "4", credit: "0" },
        { accountId: ids.sSales, debit: "0", credit: "4" },
      ],
    });
    expect(legacy.entryIds).toHaveLength(2);
    await insertVoucher({
      companyId: pair.targetId,
      number: `MIG-GC-${pair.code}-B`,
      sourceModule: "SP_MIGRATION_READONLY",
    });

    const run2 = await importSales(pairBody(pair, { confirmation: "MIGRATE" }));
    expect(run2.status).toBe(200);
    expect(run2.body.reconciliation).toMatchObject({ vouchersCreated: 0, vouchersReused: 2, entryLinksBackfilled: 4 });
    expect(run2.body.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("existing migrated entry count (0) differs from source (2)")])
    );
    expect(opening).toBeTruthy();
  });

  it("marks the run failed when the copy cannot be written", async () => {
    // The target voucher number is globally unique; another company already holds it.
    const other = await insertVoucher({ companyId: pair.sourceId, number: `MIG-GC-${pair.code}-C`, type: "Journal" });
    await insertVoucher({
      companyId: pair.sourceId,
      number: `${pair.code}-C`,
      entries: [
        { accountId: ids.sCode, debit: "1", credit: "0" },
        { accountId: ids.sSales, debit: "0", credit: "1" },
      ],
    });
    const result = await importSales(pairBody(pair, { confirmation: "MIGRATE" }));
    expect(result.status).toBe(500);
    expect(result.body.message).toMatch(/^Historical sales migration failed:/);
    expect(await scalar(`SELECT status FROM sp_migration_rehearsal_runs WHERE id = $1`, [result.body.runId])).toBe(
      "failed"
    );
    await pool.query(`DELETE FROM vouchers WHERE id = $1`, [other.voucherId]);
    await pool.query(`UPDATE vouchers SET deleted_at = now() WHERE company_id = $1 AND voucher_number = $2`, [
      pair.sourceId,
      `${pair.code}-C`,
    ]);
  });

  it("serves the suspense review for the pair", async () => {
    const review = await call("GET /api/sp/migration/gc-suspense-review", { query: pairBody(pair) });
    expect(review.status).toBe(200);
    expect(review.body.count).toBe(1);
    expect(review.body.items[0]).toMatchObject({
      review_reason: "linked_source_entry",
      source_account_code: "S-OTHER",
    });
  });
});

describe("shared Phase 2 helpers", () => {
  it("maps target accounts by sub-type, code, unique type, shared-charges default, or not at all", () => {
    const row = (id: number, code: string, type: string, subType: string | null) => ({
      id,
      code,
      account_type: type,
      sub_type: subType,
    });
    const shared = row(4, "SH", "Expense", "sp_shared_charges");
    const target = {
      rows: [],
      bySubType: new Map<string, Record<string, unknown>>([
        ["sp_sales", row(1, "S", "Income", "sp_sales")],
        ["sp_shared_charges", shared],
      ]),
      byCode: new Map<string, Record<string, unknown>>([["fx", row(2, "FX", "Bank", null)]]),
      byType: new Map<string, Record<string, unknown>[]>([
        ["Cash", [row(3, "C", "Cash", null)]],
        ["Bank", [row(2, "FX", "Bank", null), row(5, "FX2", "Bank", null)]],
      ]),
    };
    expect(mapTargetAccount({ sub_type: "sp_sales" }, target)).toEqual({
      targetAccountId: 1,
      method: "exact_sub_type",
      reviewStatus: "mapped",
    });
    expect(mapTargetAccount({ code: " FX " }, target).method).toBe("exact_code");
    expect(mapTargetAccount({ account_type: "Cash" }, target)).toMatchObject({
      targetAccountId: 3,
      reviewStatus: "review",
    });
    expect(mapTargetAccount({ account_type: "Bank" }, target)).toMatchObject({
      targetAccountId: 4,
      method: "default_shared_charges",
    });
    target.bySubType.delete("sp_shared_charges");
    expect(mapTargetAccount(null, target)).toEqual({
      targetAccountId: null,
      method: "unmapped",
      reviewStatus: "unmapped",
    });
  });

  it("resolves suppliers by id, by normalized name, and refuses ambiguous or unknown names", async () => {
    const supplier = await insertSupplier(pair.sourceId, `${pair.code}-SA`, `${PREFIX} Alpha Trading`);
    await insertSupplier(pair.sourceId, `${pair.code}-SB1`, `${PREFIX} Beta Co`);
    await insertSupplier(pair.sourceId, `${pair.code}-SB2`, `${PREFIX} BETA-CO`);
    expect(await resolveSupplier(supplier, null)).toMatchObject({ supplierId: supplier, method: "source_id" });
    expect(await resolveSupplier(2147480001, `${PREFIX} alpha  trading`)).toMatchObject({
      supplierId: supplier,
      method: "normalized_name",
    });
    expect(await resolveSupplier(null, `${PREFIX} beta co`)).toMatchObject({
      supplierId: null,
      method: "ambiguous_name",
    });
    expect(await resolveSupplier(null, null)).toEqual({
      supplierId: null,
      supplierName: "Unknown Supplier (GC migration)",
      method: "unmatched",
      warning: 'Supplier "unknown" could not be matched automatically.',
    });
  });

  it("has no suspense rows without a suspense account and no prerequisites for unlisted actions", async () => {
    expect(await getSuspenseReview(pair.targetId, pair.sourceId)).toEqual({
      count: 0,
      totalDebit: 0,
      totalCredit: 0,
      items: [],
    });
    expect(await requireCompletedAction(pair.sourceId, pair.targetId, "gc_stock_master")).toBeNull();
  });
});
