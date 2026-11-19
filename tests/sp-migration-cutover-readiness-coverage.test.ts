/**
 * Supplier Partner cutover readiness: the location and ledger-account mapping
 * rules the cutover relies on, and the historical-sales
 * and container verification that decides whether a cutover may finalize.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { resolveTargetLedgerAccount, resolveTargetLocation } from "../server/routes/sp/spMigrationCutoverReadiness";
import {
  verifyContainers,
  verifyHistoricalSales,
} from "../server/routes/sp/spMigrationPhase4VerificationVerifyContainers";
import {
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertAccount,
  insertLocation,
  insertRun,
  insertSaleItem,
  insertStockItem,
  insertSupplier,
  insertVoucher,
  linkRows,
  trackFixtureRow,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_ready";
const CLEAN_PREFIX = "spmigcov_readyok";
let pair: SpMigrationPair;
let clean: SpMigrationPair;
let runId: string;
const ids: Record<string, number> = {};

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  clean = await createSpMigrationPair(CLEAN_PREFIX);
  runId = await insertRun(pair.sourceId, pair.targetId, "gc_containers");
  ids.supplier = await insertSupplier(pair.sourceId, `${pair.code}-SUP`, `${PREFIX} Supplier`);
}, 120000);

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
  await cleanupSpMigrationPair(CLEAN_PREFIX);
}, 120000);

describe("resolveTargetLocation", () => {
  it("maps by unique name and refuses unknown or ambiguous locations", async () => {
    const shop = await insertLocation(pair.sourceId, `${pair.code}-L1`, `${PREFIX} Shop`);
    const targetShop = await insertLocation(pair.targetId, `${pair.code}-L1T`, `${PREFIX} SHOP`);
    expect(await resolveTargetLocation(pair.sourceId, pair.targetId, shop)).toMatchObject({
      targetLocationId: targetShop,
      method: "name",
      sourceCode: `${pair.code}-L1`,
    });

    const twin = await insertLocation(pair.sourceId, `${pair.code}-L2`, `${PREFIX} Twin`);
    await insertLocation(pair.targetId, `${pair.code}-L2A`, `${PREFIX} Twin`);
    await insertLocation(pair.targetId, `${pair.code}-L2B`, `${PREFIX} twin`);
    expect(await resolveTargetLocation(pair.sourceId, pair.targetId, twin)).toBeNull();
    // A location of another company is never mapped.
    expect(await resolveTargetLocation(pair.sourceId, pair.targetId, targetShop)).toBeNull();
  });

  it("maps a missing source location to the target's UNASSIGNED location only when it exists", async () => {
    expect(await resolveTargetLocation(pair.sourceId, pair.targetId, null)).toBeNull();
    const unassigned = await insertLocation(pair.targetId, "UNASSIGNED", `${PREFIX} Unassigned`);
    try {
      expect(await resolveTargetLocation(pair.sourceId, pair.targetId, null)).toMatchObject({
        targetLocationId: unassigned,
        method: "unassigned",
      });
    } finally {
      await pool.query(`DELETE FROM locations WHERE id = $1`, [unassigned]);
    }
  });
});

describe("resolveTargetLedgerAccount", () => {
  it("maps by sub-type, then code, then unique name and type", async () => {
    const tBySub = await insertAccount(pair.targetId, "T-TILL", "Cash", "pos_cash_till");
    const tByCode = await insertAccount(pair.targetId, "BANK-1", "Bank", null);
    const tByName = await insertAccount(pair.targetId, "T-NAME", "Cash", null, `${PREFIX} petty cash`);
    const sBySub = await insertAccount(pair.sourceId, "S-TILL", "Cash", "pos_cash_till");
    const sByCode = await insertAccount(pair.sourceId, "bank-1", "Bank", "unmatched_sub");
    const sByName = await insertAccount(pair.sourceId, "S-NAME", "Cash", null, `${PREFIX} PETTY CASH`);
    const sNone = await insertAccount(pair.sourceId, "S-NONE", "Cash", null, `${PREFIX} nowhere`);

    expect(await resolveTargetLedgerAccount(sBySub, pair.targetId)).toBe(tBySub);
    expect(await resolveTargetLedgerAccount(sByCode, pair.targetId)).toBe(tByCode);
    expect(await resolveTargetLedgerAccount(sByName, pair.targetId)).toBe(tByName);
    expect(await resolveTargetLedgerAccount(sNone, pair.targetId)).toBeNull();
    expect(await resolveTargetLedgerAccount(null, pair.targetId)).toBeNull();
    expect(await resolveTargetLedgerAccount(2147480001, pair.targetId)).toBeNull();
  });
});

describe("verifyHistoricalSales", () => {
  it("passes a pair with no historical sales", async () => {
    const result = await verifyHistoricalSales(clean.sourceId, clean.targetId);
    expect(result.blockers).toEqual([]);
    expect(result.deltas).toEqual([]);
    expect(result.area.status).toBe("PASS");
  });

  it("reports missing copies as deltas and unprovenanced target sales as blockers", async () => {
    const account = await insertAccount(pair.sourceId, "S-SALE", "Income", null);
    const cash = await insertAccount(pair.sourceId, "S-CASH", "Cash", null);
    const item = await insertStockItem(pair.sourceId, `${pair.code}-SI`);
    const sale = await insertVoucher({
      companyId: pair.sourceId,
      number: `${pair.code}-SALE`,
      entries: [
        { accountId: cash, debit: "4", credit: "0" },
        { accountId: account, debit: "0", credit: "4" },
      ],
    });
    await insertSaleItem(sale.voucherId, item);
    await insertVoucher({
      companyId: pair.targetId,
      number: `${pair.code}-ORPHAN`,
      sourceModule: "SP_MIGRATION_READONLY",
    });

    const result = await verifyHistoricalSales(pair.sourceId, pair.targetId);
    expect(result.deltas.map((issue) => issue.code)).toEqual([
      "READONLY_SALES_VOUCHER_DELTA",
      "READONLY_SALES_ITEM_DELTA",
      "READONLY_SALES_ENTRY_DELTA",
    ]);
    expect(result.blockers).toEqual([expect.objectContaining({ code: "UNPROVENANCED_TARGET_SALES", count: 1 })]);
    expect(result.area.status).toBe("FAIL");
    expect(result.area.mismatches).toEqual([`Missing voucher: ${pair.code}-SALE`]);
  });
});

describe("verifyContainers", () => {
  async function sourceContainer(number: string, status: string, itemName: string | null = null): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, item_name, total_kg, items_total, rate_per_kg)
       VALUES ($1, $2, '2026-09-04', $3, $4, $5, 4, 40, 10) RETURNING id`,
      [pair.sourceId, `${pair.code}-${number}`, ids.supplier, status, itemName]
    );
    return result.rows[0].id;
  }

  async function targetContainer(
    sourceId: number,
    number: string,
    fields: { status: string; supplierId: number | null; voucherId?: number | null }
  ): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO sp_containers (company_id, supplier_id, supplier_name, container_number, invoice_number, invoice_date,
                                  invoice_total_usd, freight_estimate_usd, status, goods_otw_voucher_id)
       VALUES ($1, $2, 'Supplier', $3, $3, '2026-09-04', 40, 0, $4, $5) RETURNING id`,
      [pair.targetId, fields.supplierId, `${pair.code}-${number}`, fields.status, fields.voucherId ?? null]
    );
    await linkRows(runId, "containers", sourceId, "sp_containers", result.rows[0].id);
    return result.rows[0].id;
  }

  async function otw(number: string, deleted: boolean): Promise<number> {
    const { voucherId } = await insertVoucher({
      companyId: pair.targetId,
      number: `${pair.code}-OTW-${number}`,
      type: "Journal",
      sourceModule: "SP_MIGRATION",
      supplierId: ids.supplier,
    });
    if (deleted) await pool.query(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [voucherId]);
    return voucherId;
  }

  it("passes a pair with no containers", async () => {
    const result = await verifyContainers(clean.sourceId, clean.targetId);
    expect(result).toMatchObject({ blockers: [], deltas: [], area: { status: "PASS" } });
  });

  it("reports copy, header, line, supplier and Goods-OTW drift", async () => {
    await sourceContainer("K1", "OTW");
    const k2 = await sourceContainer("K2", "Offloaded");
    await linkRows(runId, "containers", k2, "sp_containers", 2147480002);
    const k3 = await sourceContainer("K3", "Offloaded");
    const k3Target = await targetContainer(k3, "K3", { status: "offloaded", supplierId: null });
    await pool.query(
      `INSERT INTO sp_container_lines (container_id, company_id, article_code, qty, unit_rate_usd) VALUES ($1, $2, 'MANUAL', 1, 1)`,
      [k3Target, pair.targetId]
    );
    const item = await insertStockItem(pair.sourceId, `${pair.code}-K4ITEM`);
    const k4 = await sourceContainer("K4", "OTW", `${pair.code}-K4ITEM`);
    const k4Target = await targetContainer(k4, "K4", { status: "open", supplierId: ids.supplier });
    const tracked = await pool.query<{ id: number }>(
      `INSERT INTO sp_container_lines (container_id, company_id, article_code, qty, unit_rate_usd) VALUES ($1, $2, 'K4', 4, 10) RETURNING id`,
      [k4Target, pair.targetId]
    );
    await trackFixtureRow(runId, "sp_container_lines", tracked.rows[0].id);
    const k5 = await sourceContainer("K5", "Offloaded");
    const k5Voucher = await otw("K5", false);
    await targetContainer(k5, "K5", { status: "open", supplierId: ids.supplier, voucherId: k5Voucher });
    await pool.query(`UPDATE vouchers SET supplier_id = NULL WHERE id = $1`, [k5Voucher]);
    const k6 = await sourceContainer("K6", "OTW");
    await targetContainer(k6, "K6", { status: "open", supplierId: ids.supplier, voucherId: await otw("K6", true) });

    const result = await verifyContainers(pair.sourceId, pair.targetId);
    expect(result.counts).toMatchObject({
      sourceContainers: 6,
      linkedContainers: 5,
      headerDrift: 2,
      lineDrift: 1,
      unresolvedSupplier: 1,
      untrackedTargetLines: 1,
      otwStateDrift: 3,
      supplierVoucherGaps: 1,
    });
    expect(result.blockers.map((issue) => issue.code)).toEqual([
      "UNRESOLVED_CONTAINER_SUPPLIER",
      "UNTRACKED_CONTAINER_LINES",
      "SUPPLIER_VOUCHER_LINK_GAP",
    ]);
    expect(result.deltas.map((issue) => issue.code)).toEqual([
      "CONTAINER_COPY_DELTA",
      "CONTAINER_HEADER_DELTA",
      "CONTAINER_LINE_DELTA",
      "CONTAINER_OTW_STATE_DELTA",
    ]);
    expect(result.area.status).toBe("FAIL");
    expect(result.area.mismatches).toContain(`Container ${pair.code}-K2: provenance points to a missing target row.`);
    expect(item).toBeGreaterThan(0);
  });
});
