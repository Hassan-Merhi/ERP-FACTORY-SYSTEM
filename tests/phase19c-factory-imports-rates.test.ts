/**
 * Phase 19 (C) — factory writers, imports, rates and intercompany transfer legs.
 *
 *   F2  POST /api/factory/raw-stock/update-cost is retired (410).
 *   F3  bale status / bulk-status / delete: Admin/Owner, value-neutral changes
 *       only (409 otherwise, nothing written), audited in the transaction.
 *   F7  bale Excel import, opening raw-stock import, company-data import:
 *       Admin/Owner, one transaction holding the cut-over lock, audited,
 *       refused after the cut-over; the reimport keeps only this company's
 *       costed mix ids; Excel-imported bales belong to an import batch.
 *   I2  location cost-price import: Admin/Owner, Decimal at 6dp, audited,
 *       refused after the cut-over.
 *   M2  containers and charges post at the recorded dated factory rate or are
 *       refused (409 FACTORY_FX_RATE_REQUIRED).
 *   M3  one shared daybook writer stores a missing rate as unresolved (0);
 *       deduct-received refuses with no recorded rate and is dated by the
 *       company's business date.
 *   MC-2 an intercompany transfer leg is refused (409) by every generic editor.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { companyBusinessDate } from "../server/services/accounting/companyBusinessDate";
import { perpetualReadinessReport } from "../server/services/accounting/perpetualInventory/readiness";
import { ensureFactoryCostBasisSchema } from "../server/services/factory/factoryCostBasisSchema";
import { writeDaybookEntry as sharedDaybookWriter } from "../server/services/factory/factoryDaybookWriter";
import { writeDaybookEntry as payrollDaybookWriter } from "../server/routes/payroll/core/_helpers";
import { writeDaybookEntry as factoryDaybookWriter } from "../server/routes/factory/_helpers";
import { assertStockImportAllowedTx } from "../server/services/factory/stockImportPolicy";
import { isValueNeutralBaleStatusChange } from "../server/services/factory/baleStatusPolicy";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p19c";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let companyB: number;
const ids: Record<string, number> = {};

const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("phase19c-test", work);

async function insertId(text: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(text, params);
  return rows[0].id;
}

async function setCutover(companyId: number, effectiveFrom: string | null) {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [companyId]);
  if (effectiveFrom) {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [companyId, effectiveFrom]
    );
  }
}

async function asRole<T>(role: string, work: (roleAgent: request.SuperAgentTest) => Promise<T>): Promise<T> {
  await pool.query(`UPDATE user_company_roles SET role = $3 WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
    role,
  ]);
  try {
    const roleAgent = request.agent(ctx.app);
    await roleAgent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
    await roleAgent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    return await work(roleAgent);
  } finally {
    await pool.query(`UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2`, [
      ctx.userId,
      ctx.companyId,
    ]);
  }
}

async function bale(status: string, ref: string): Promise<number> {
  return insertId(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, 'P19C', $2, 50, 2, 100, $3) RETURNING id`,
    [ctx.companyId, ref, status]
  );
}

async function baleStatus(id: number): Promise<{ status: string; deleted: boolean }> {
  const { rows } = await pool.query(`SELECT status, deleted_at FROM factory_bales WHERE id = $1`, [id]);
  return { status: rows[0].status, deleted: rows[0].deleted_at !== null };
}

async function auditCount(tableName: string, recordId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM audit_log WHERE company_id = $1 AND table_name = $2 AND record_id = $3`,
    [ctx.companyId, tableName, recordId]
  );
  return rows[0].n;
}

async function excel(rows: unknown[][]): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureFactoryCostBasisSchema(pool);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  companyB = await insertId(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
    [`${PREFIX.toUpperCase()}B${ctx.companyId}`.slice(0, 20), `${PREFIX} company B`]
  );
  ids.SUPPLIER = await insertId(
    `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
    [ctx.companyId, `${PREFIX} supplier`]
  );
  ids.CHARGE_ACCOUNT = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Expense', 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-CHG-${ctx.companyId}`, `${PREFIX} charge`]
  );
}, 120_000);

afterAll(async () => {
  for (const id of [ctx.companyId, companyB]) {
    await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM inter_company_transfers WHERE from_company_id = $1 OR to_company_id = $1`, [id]);
    for (const table of [
      "factory_daybook_entries",
      "factory_bales",
      "factory_bale_import_batches",
      "factory_bale_sequences",
      "factory_raw_material_adjustments",
      "factory_raw_stock",
      "factory_container_other_charges",
      "factory_mix_batches",
      "factory_fx_rates",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [id]);
    }
    await withFixtureTransaction(async (client) => {
      await client.query(
        `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
        [id]
      );
      await client.query(`DELETE FROM vouchers WHERE company_id = $1`, [id]);
    });
    await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM factory_bale_products WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM inventory_valuation_overrides WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM user_company_roles WHERE company_id = $1`, [id]);
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  }
  await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [companyB]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("F2: supplier cost update retired", () => {
  it("answers 410 and changes nothing", async () => {
    const response = await agent
      .post("/api/factory/raw-stock/update-cost")
      .send({ supplierId: ids.SUPPLIER, newCostPerKg: "0.5" });
    expect(response.status).toBe(410);
    expect(response.body.code).toBe("FACTORY_RAW_COST_UPDATE_RETIRED");
    expect(response.body.message).toContain("reviewed re-cost");
  });
});

describe("F3: bale status changes", () => {
  it("classifies value-neutral changes", () => {
    expect(isValueNeutralBaleStatusChange("IN_STOCK", "RESERVED_FOR_ORDER")).toBe(true);
    expect(isValueNeutralBaleStatusChange("RESERVED_FOR_DISPATCH", "IN_STOCK")).toBe(true);
    expect(isValueNeutralBaleStatusChange("LABEL_PRINTED", "PRESSED")).toBe(true);
    expect(isValueNeutralBaleStatusChange("IN_STOCK", "SOLD")).toBe(false);
    expect(isValueNeutralBaleStatusChange("SOLD", "IN_STOCK")).toBe(false);
    expect(isValueNeutralBaleStatusChange("DELETED", "IN_STOCK")).toBe(false);
    expect(isValueNeutralBaleStatusChange("PENDING_PRESSING", "IN_STOCK")).toBe(false);
    expect(isValueNeutralBaleStatusChange("PRESSED", "IN_STOCK")).toBe(false);
    expect(isValueNeutralBaleStatusChange("IN_STOCK", "REMOVED")).toBe(false);
    expect(isValueNeutralBaleStatusChange("IN_STOCK", "RESERVED_FOR_ORDER", new Date())).toBe(false);
  });

  it("is Admin/Owner only", async () => {
    const id = await bale("IN_STOCK", "P19C-ROLE");
    await asRole("Manager", async (manager) => {
      expect(
        (await manager.patch(`/api/factory/bales/${id}/status`).send({ status: "RESERVED_FOR_ORDER" })).status
      ).toBe(403);
      expect(
        (await manager.patch("/api/factory/bales/bulk-status").send({ ids: [id], status: "IN_STOCK" })).status
      ).toBe(403);
      expect((await manager.delete(`/api/factory/bales/${id}`)).status).toBe(403);
    });
    expect(await baleStatus(id)).toEqual({ status: "IN_STOCK", deleted: false });
  });

  it("allows a value-neutral change, audited, and refuses one that changes value", async () => {
    const id = await bale("IN_STOCK", "P19C-ONE");
    const ok = await agent.patch(`/api/factory/bales/${id}/status`).send({ status: "RESERVED_FOR_ORDER" });
    expect(ok.status).toBe(200);
    expect(await baleStatus(id)).toEqual({ status: "RESERVED_FOR_ORDER", deleted: false });
    expect(await auditCount("factory_bales", id)).toBe(1);

    for (const status of ["SOLD", "DELETED", "REMOVED", "PENDING_PRESSING", "PRESSED"]) {
      const refused = await agent.patch(`/api/factory/bales/${id}/status`).send({ status });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("FACTORY_BALE_STATUS_CHANGES_VALUE");
    }
    expect(await baleStatus(id)).toEqual({ status: "RESERVED_FOR_ORDER", deleted: false });

    const sold = await bale("SOLD", "P19C-SOLD");
    expect((await agent.patch(`/api/factory/bales/${sold}/status`).send({ status: "IN_STOCK" })).status).toBe(409);
    expect(await baleStatus(sold)).toEqual({ status: "SOLD", deleted: false });
    expect(await auditCount("factory_bales", sold)).toBe(0);
  });

  it("bulk: refuses the whole set when one change is not neutral; audits each bale changed", async () => {
    const a = await bale("IN_STOCK", "P19C-BULK-A");
    const b = await bale("RESERVED_FOR_DISPATCH", "P19C-BULK-B");
    const sold = await bale("SOLD", "P19C-BULK-S");
    const refused = await agent
      .patch("/api/factory/bales/bulk-status")
      .send({ ids: [a, b, sold], status: "RESERVED_FOR_ORDER" });
    expect(refused.status).toBe(409);
    expect(refused.body.refused).toEqual([{ id: sold, from: "SOLD", to: "RESERVED_FOR_ORDER" }]);
    expect((await baleStatus(a)).status).toBe("IN_STOCK");

    expect((await agent.patch("/api/factory/bales/bulk-status").send({ ids: [a], status: "SOLD" })).status).toBe(409);

    const ok = await agent.patch("/api/factory/bales/bulk-status").send({ ids: [a, b], status: "RESERVED_FOR_ORDER" });
    expect(ok.status).toBe(200);
    expect(ok.body.updated).toBe(2);
    expect(await auditCount("factory_bales", a)).toBe(1);
    expect(await auditCount("factory_bales", b)).toBe(1);
  });

  it("deletes only a pre-stock bale, audited", async () => {
    const stock = await bale("IN_STOCK", "P19C-DEL-STOCK");
    const refused = await agent.delete(`/api/factory/bales/${stock}`);
    expect(refused.status).toBe(409);
    expect(await baleStatus(stock)).toEqual({ status: "IN_STOCK", deleted: false });

    const label = await bale("LABEL_PRINTED", "P19C-DEL-LABEL");
    expect((await agent.delete(`/api/factory/bales/${label}`)).status).toBe(200);
    expect(await baleStatus(label)).toEqual({ status: "DELETED", deleted: true });
    expect(await auditCount("factory_bales", label)).toBe(1);
  });
});

describe("F7 / DI10: imports", () => {
  it("takes the cut-over apply's advisory lock", async () => {
    await setCutover(ctx.companyId, null);
    const other = await pool.connect();
    try {
      await asMaintenance(() =>
        db.transaction(async (tx) => {
          await assertStockImportAllowedTx(tx, ctx.companyId);
          await other.query("BEGIN");
          const { rows } = await other.query(
            `SELECT pg_try_advisory_xact_lock(hashtext('gl_inventory_cutover'), $1) AS got`,
            [ctx.companyId]
          );
          await other.query("ROLLBACK");
          expect(rows[0].got).toBe(false);
        })
      );
    } finally {
      other.release();
    }
  });

  it("bale Excel import: Admin/Owner, batched and audited before the cut-over, refused after", async () => {
    await pool.query(
      `INSERT INTO factory_bale_products (company_id, code, article_code, name, weight_per_bale_kg)
       VALUES ($1, 'P19C-P', 'P19C-ART', 'P19C product', 40)`,
      [ctx.companyId]
    );
    const file = await excel([
      ["ITEM BARCODE", "QUANTITY", "PRODUCTION DATE"],
      ["P19C-ART", 2, "2026-05-01"],
    ]);
    await asRole("Manager", async (manager) => {
      expect((await manager.post("/api/factory/bales/import-excel").attach("file", file, "b.xlsx")).status).toBe(403);
    });

    await setCutover(ctx.companyId, null);
    const ok = await agent.post("/api/factory/bales/import-excel").attach("file", file, "b.xlsx");
    expect(ok.status).toBe(200);
    expect(ok.body.totalBalesCreated).toBe(2);
    const batchId = ok.body.importBatchId;
    const bales = await pool.query(`SELECT status FROM factory_bales WHERE company_id = $1 AND import_batch_id = $2`, [
      ctx.companyId,
      batchId,
    ]);
    expect(bales.rows.map((row) => row.status)).toEqual(["IN_STOCK", "IN_STOCK"]);
    expect(await auditCount("factory_bale_import_batches", batchId)).toBe(1);
    const report = await asMaintenance(() => perpetualReadinessReport(ctx.companyId));
    expect(report.importedAtSpreadsheetCost.rows.filter((row) => row.importBatchId === batchId)).toHaveLength(2);

    await setCutover(ctx.companyId, "2026-01-01");
    const before = await pool.query(`SELECT COUNT(*)::int AS n FROM factory_bales WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    const refused = await agent.post("/api/factory/bales/import-excel").attach("file", file, "b.xlsx");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("FACTORY_STOCK_IMPORT_AFTER_CUTOVER");
    const after = await pool.query(`SELECT COUNT(*)::int AS n FROM factory_bales WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    await setCutover(ctx.companyId, null);
  }, 60_000);

  it("opening raw-stock import: Admin/Owner, audited per row, refused after the cut-over", async () => {
    const items = [
      { supplier: `${PREFIX} supplier`, kg: "100", costPerKg: "1.5", currency: "USD", openingDate: "2026-01-01" },
    ];
    await asRole("Manager", async (manager) => {
      expect((await manager.post("/api/factory/import/opening-raw-stock").send({ items })).status).toBe(403);
    });

    await setCutover(ctx.companyId, "2026-01-01");
    const refused = await agent.post("/api/factory/import/opening-raw-stock").send({ items });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("FACTORY_STOCK_IMPORT_AFTER_CUTOVER");
    const none = await pool.query(
      `SELECT 1 FROM factory_containers WHERE company_id = $1 AND status = 'OPENING_BALANCE'`,
      [ctx.companyId]
    );
    expect(none.rows).toEqual([]);

    await setCutover(ctx.companyId, null);
    const ok = await agent.post("/api/factory/import/opening-raw-stock").send({
      items: [...items, { supplier: "nobody", kg: "1", costPerKg: "1", currency: "USD", openingDate: "2026-01-01" }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.imported).toBe(1);
    expect(ok.body.errors).toEqual(['Row 2: supplier "nobody" not found']);
    const raw = await pool.query(
      `SELECT rs.id FROM factory_raw_stock rs JOIN factory_containers c ON c.id = rs.container_id
        WHERE rs.company_id = $1 AND c.status = 'OPENING_BALANCE'`,
      [ctx.companyId]
    );
    expect(raw.rows).toHaveLength(1);
    const audit = await pool.query(
      `SELECT 1 FROM audit_log WHERE company_id = $1 AND table_name = 'factory_raw_stock' AND action = 'import'
          AND record_id = $2`,
      [ctx.companyId, raw.rows[0].id]
    );
    expect(audit.rows).toHaveLength(1);
  }, 60_000);

  it("company-data import: Admin/Owner and refused after the cut-over", async () => {
    const payload = Buffer.from(JSON.stringify({ sourceCompanyId: 987654, tables: {} }));
    await asRole("Manager", async (manager) => {
      expect((await manager.post("/api/factory/import-company-data").attach("file", payload, "c.json")).status).toBe(
        403
      );
    });
    await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
      ctx.userId,
      companyB,
    ]);
    const bAgent = request.agent(ctx.app);
    await bAgent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
    expect((await bAgent.post("/api/auth/set-company").send({ companyId: companyB })).status).toBe(200);
    await setCutover(companyB, "2026-01-01");
    const refused = await bAgent.post("/api/factory/import-company-data").attach("file", payload, "c.json");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("FACTORY_STOCK_IMPORT_AFTER_CUTOVER");
    await setCutover(companyB, null);
  }, 60_000);

  it("reimport keeps only this company's costed mix ids", async () => {
    const costed = await insertId(
      `INSERT INTO factory_mix_batches (company_id, batch_code, total_weight_kg, cost_per_kg, total_cost)
       VALUES ($1, 'P19C-MIX-OK', 100, 2, 200) RETURNING id`,
      [ctx.companyId]
    );
    const zero = await insertId(
      `INSERT INTO factory_mix_batches (company_id, batch_code, total_weight_kg, cost_per_kg, total_cost)
       VALUES ($1, 'P19C-MIX-ZERO', 100, 0, 0) RETURNING id`,
      [ctx.companyId]
    );
    const foreign = await insertId(
      `INSERT INTO factory_mix_batches (company_id, batch_code, total_weight_kg, cost_per_kg, total_cost)
       VALUES ($1, 'P19C-MIX-B', 100, 3, 300) RETURNING id`,
      [companyB]
    );
    const file = await excel([
      ["Reference Number", "Product Name", "Weight (kg)", "Cost per kg", "Mix Batch"],
      ["P19C-R-OK", "P19C reimport", 20, 1, costed],
      ["P19C-R-ZERO", "P19C reimport", 20, 1, zero],
      ["P19C-R-B", "P19C reimport", 20, 1, foreign],
    ]);
    const response = await agent.post("/api/factory/bales/reimport").attach("file", file, "r.xlsx");
    expect(response.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT reference_number, mix_batch_id FROM factory_bales
        WHERE company_id = $1 AND reference_number LIKE 'P19C-R-%' ORDER BY reference_number`,
      [ctx.companyId]
    );
    expect(rows).toEqual([
      { reference_number: "P19C-R-B", mix_batch_id: null },
      { reference_number: "P19C-R-OK", mix_batch_id: costed },
      { reference_number: "P19C-R-ZERO", mix_batch_id: null },
    ]);
    const audit = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'factory_bale_import_batches'
          AND record_id = $2`,
      [ctx.companyId, response.body.batchId]
    );
    expect(JSON.stringify(audit.rows[0].changes)).toContain(`${zero}`);
  }, 60_000);
});

describe("I2: location cost-price import", () => {
  it("is Admin/Owner, exact at 6dp, audited, refused after the cut-over", async () => {
    const url = `/api/locations/${ctx.locationId}/import-cost-prices`;
    const updates = [{ barcode: `${PREFIX}-ITEM1`, costPrice: "1.1234567" }];
    await asRole("Manager", async (manager) => {
      expect((await manager.post(url).send({ updates })).status).toBe(403);
    });

    await setCutover(ctx.companyId, "2026-01-01");
    const refused = await agent.post(url).send({ updates });
    expect(refused.status).toBe(409);
    const unchanged = await pool.query(
      `SELECT average_rate::text, total_value::text FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
      [ctx.locationId, ctx.stockItemIds[0]]
    );
    expect(unchanged.rows[0]).toEqual({ average_rate: "10.0000000", total_value: "1000.00" });

    await setCutover(ctx.companyId, null);
    const ok = await agent.post(url).send({ updates });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ updated: 1, errors: [] });
    const { rows } = await pool.query(
      `SELECT id, average_rate::text, total_value::text FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
      [ctx.locationId, ctx.stockItemIds[0]]
    );
    expect(rows[0]).toMatchObject({ average_rate: "1.1234570", total_value: "112.35" });
    expect(await auditCount("inventory", rows[0].id)).toBe(1);
  }, 60_000);
});

describe("M2: recorded dated factory rates", () => {
  it("container create refuses EUR with no recorded rate and posts at the recorded one", async () => {
    const body = {
      containerNumber: "P19C-C1",
      supplierId: ids.SUPPLIER,
      currencyCode: "EUR",
      totalKg: "100",
      arrivalDate: "2026-06-10",
    };
    const refused = await agent.post("/api/factory/containers").send(body);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "FACTORY_FX_RATE_REQUIRED",
      currency: "EUR",
      documentDate: "2026-06-10",
    });
    expect((await pool.query(`SELECT 1 FROM factory_containers WHERE container_number = 'P19C-C1'`)).rows).toEqual([]);

    // A rate dated after the document does not count.
    await pool.query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
       VALUES ($1, 'EUR', '1.30000000', '2026-07-01', 'manual')`,
      [ctx.companyId]
    );
    expect((await agent.post("/api/factory/containers").send(body)).status).toBe(409);

    await pool.query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
       VALUES ($1, 'EUR', '1.10000000', '2026-06-01', 'manual')`,
      [ctx.companyId]
    );
    const ok = await agent.post("/api/factory/containers").send(body);
    expect(ok.status).toBe(200);
    expect(Number(ok.body.fxRateToUsd)).toBe(1.1);
    expect(ok.body.fxRateSource).toBe("manual");
    ids.CONTAINER = ok.body.id;
  }, 60_000);

  it("container Excel import reports a row with no recorded rate and creates nothing", async () => {
    const response = await agent.post("/api/factory/containers/import-excel").send({
      rows: [{ containerNumber: "P19C-X1", currencyCode: "EUR", arrivalDate: "2026-05-01", totalKg: "10" }],
    });
    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(0);
    expect(response.body.errors[0]).toContain("no confirmed exchange rate");
    expect((await pool.query(`SELECT 1 FROM factory_containers WHERE container_number = 'P19C-X1'`)).rows).toEqual([]);
  });

  it("other charges in a third currency need a recorded rate", async () => {
    const usdContainer = await insertId(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id, currency_code, arrival_date)
       VALUES ($1, 'P19C-USD', $2, 'USD', '2026-06-10') RETURNING id`,
      [ctx.companyId, ids.SUPPLIER]
    );
    const response = await agent.post(`/api/factory/containers/${usdContainer}/other-charges/sync`).send({
      charges: [{ description: "Handling", amount: "10", currencyCode: "AUD", ledgerAccountId: ids.CHARGE_ACCOUNT }],
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "FACTORY_FX_RATE_REQUIRED", currency: "AUD" });
    const charges = await pool.query(`SELECT 1 FROM factory_container_other_charges WHERE container_id = $1`, [
      usdContainer,
    ]);
    expect(charges.rows).toEqual([]);
  });
});

describe("M3: no rate-1 fallback", () => {
  it("every daybook copy is the shared writer, which stores a missing rate as unresolved", async () => {
    expect(payrollDaybookWriter).toBe(sharedDaybookWriter);
    expect(factoryDaybookWriter).toBe(sharedDaybookWriter);
    const row = await asMaintenance(() =>
      sharedDaybookWriter(db, {
        companyId: companyB,
        txDate: "2026-06-10",
        txType: "P19C_TEST",
        description: "unresolved",
        currencyCode: "EUR",
        amountCurrency: 50,
      })
    );
    const { rows } = await pool.query(
      `SELECT fx_rate_to_usd::numeric AS rate, amount_usd::numeric AS usd FROM factory_daybook_entries WHERE id = $1`,
      [row.id]
    );
    expect(Number(rows[0].rate)).toBe(0);
    expect(Number(rows[0].usd)).toBe(0);
  });

  it("deduct-received refuses EUR with no recorded rate and is dated by the business date", async () => {
    const body = { supplierId: ids.SUPPLIER, kg: "1", costPerKg: "2", currencyCode: "AUD" };
    const refused = await agent.post("/api/factory/raw-stock/deduct-received").send(body);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("FACTORY_FX_RATE_REQUIRED");

    const ok = await agent.post("/api/factory/raw-stock/deduct-received").send({ ...body, currencyCode: "EUR" });
    expect(ok.status).toBe(200);
    const businessDate = await asMaintenance(() => companyBusinessDate(ctx.companyId));
    const { rows } = await pool.query(
      `SELECT tx_date::text AS date, fx_rate_to_usd::numeric AS rate FROM factory_daybook_entries
        WHERE company_id = $1 AND tx_type = 'RAW_DEDUCT_RECEIVED'`,
      [ctx.companyId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe(businessDate);
    // The latest manual rate on or before the business date (2026-10 or later).
    expect(Number(rows[0].rate)).toBe(1.3);
  });
});

describe("MC-2: intercompany transfer legs", () => {
  it("every generic editor refuses a leg (409) and nothing changes", async () => {
    const legs = await withFixtureTransaction(async (client) => {
      const leg = async (companyId: number, type: string, number: string, debitLedger: boolean) => {
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
           VALUES ($1, $2, $3, '2026-06-10', 100, 'USD', false) RETURNING id`,
          [companyId, number, type]
        );
        const ledger = companyId === ctx.companyId ? ctx.cashAccountId : ids.B_CASH;
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
           VALUES ($1, $2, $3, $4), ($1, $5, $4, $3)`,
          [
            rows[0].id,
            ledger,
            debitLedger ? "100" : "0",
            debitLedger ? "0" : "100",
            companyId === ctx.companyId ? ctx.salesAccountId : ids.B_OTHER,
          ]
        );
        return rows[0].id;
      };
      ids.B_CASH = (
        await client.query<{ id: number }>(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
           VALUES ($1, $2, 'B cash', 'Cash', 0, 'Dr') RETURNING id`,
          [companyB, `${PREFIX}-BCASH`]
        )
      ).rows[0].id;
      ids.B_OTHER = (
        await client.query<{ id: number }>(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
           VALUES ($1, $2, 'B intercompany', 'Liability', 0, 'Cr') RETURNING id`,
          [companyB, `${PREFIX}-BIC`]
        )
      ).rows[0].id;
      const from = await leg(ctx.companyId, "Payment", "P19C-ICT-A", false);
      const to = await leg(companyB, "Receipt", "P19C-ICT-B", true);
      await client.query(
        `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
                                              from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id)
         VALUES ('Cash', $1, $2, '2026-06-10', 100, $3, $4, $5, $6)`,
        [ctx.companyId, companyB, ctx.salesAccountId, ids.B_OTHER, from, to]
      );
      return { from, to };
    });
    const entry = await pool.query<{ id: number }>(`SELECT id FROM voucher_entries WHERE voucher_id = $1 LIMIT 1`, [
      legs.from,
    ]);
    const lines = [
      { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "150" },
      { ledgerAccountId: ctx.salesAccountId, debitAmount: "150", creditAmount: "0" },
    ];
    const attempts: Array<() => request.Test> = [
      () =>
        agent.put(`/api/vouchers/${legs.from}/with-entries`).send({
          voucher: { voucherType: "Payment", voucherDate: "2026-06-10" },
          entries: lines,
        }),
      () => agent.patch(`/api/vouchers/${legs.from}/payment-receipt`).send({ voucherType: "Payment" }),
      () =>
        agent.patch(`/api/vouchers/${legs.from}/journal`).send({
          voucherDate: "2026-06-11",
          entries: [{ accountType: "ledger", accountId: ctx.cashAccountId, type: "CR", amount: "150" }],
        }),
      () => agent.patch(`/api/vouchers/${legs.from}`).send({ voucherDate: "2026-06-11" }),
      () => agent.patch(`/api/vouchers/${legs.from}/optional`).send({ optional: true }),
      () => agent.patch(`/api/voucher-entries/${entry.rows[0].id}`).send({ debitAmount: "150" }),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("INTERCOMPANY_TRANSFER_LEG_EDIT_REFUSED");
    }
    const state = await pool.query(
      `SELECT id, voucher_date::text AS date, total_amount::numeric AS total, optional FROM vouchers
        WHERE id = ANY($1::int[]) ORDER BY id`,
      [[legs.from, legs.to]]
    );
    expect(state.rows.map((row) => [row.date, Number(row.total), row.optional])).toEqual([
      ["2026-06-10", 100, false],
      ["2026-06-10", 100, false],
    ]);
    const amounts = await pool.query(
      `SELECT SUM(debit_amount)::numeric AS d FROM voucher_entries WHERE voucher_id = ANY($1::int[])`,
      [[legs.from, legs.to]]
    );
    expect(Number(amounts.rows[0].d)).toBe(200);

    // A description-only edit is not a financial change.
    const described = await agent.patch(`/api/vouchers/${legs.from}`).send({ description: "P19C note" });
    expect(described.status).toBe(200);
  }, 60_000);
});
