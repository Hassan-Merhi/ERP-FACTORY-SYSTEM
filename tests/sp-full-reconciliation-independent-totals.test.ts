/**
 * The Supplier Partner full reconciliation has to be able to fail.
 *
 * GET /api/sp/reconciliation/full is the report an SP company uses to decide
 * whether its sub-ledger agrees with the general ledger. Five of its surfaces
 * used to fill both compared columns from the same row and hard-code
 * `pass: true`; two more queried source_type values that no writer produces, so
 * the reversal exclusion was dead and opening stock always totalled zero. The
 * report therefore returned PASS for any data at all.
 *
 * These tests seed a consistent SP position, confirm the report passes it, then
 * break one relationship at a time and require the exact surface to fail.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "sprecon";
const INVOICE_TOTAL = 1200;

let ctx: TestContext;
let agent: request.SuperAgentTest;
let containerId: number;
let otwVoucherId: number;
let openingMovementId: number | null = null;

type Surface = {
  key: string;
  databaseValue: number;
  reportValue: number;
  pass: boolean;
  basis: string;
};

type Report = {
  status: string;
  mismatchCount: number;
  surfaces: Surface[];
  summary: Record<string, number>;
};

async function reconciliation(): Promise<Report> {
  const response = await agent.get("/api/sp/reconciliation/full");
  expect(response.status, response.text.slice(0, 400)).toBe(200);
  return response.body as Report;
}

function surface(report: Report, key: string): Surface {
  const found = report.surfaces.find((entry) => entry.key === key);
  expect(found, `surface ${key} missing`).toBeTruthy();
  return found!;
}

async function createSpAccount(code: string, name: string, accountType: string, subType: string) {
  const [account] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code,
      name,
      accountType,
      subType,
      openingBalance: "0",
      openingBalanceSide: accountType === "Asset" ? "Dr" : "Cr",
    })
    .returning();
  return account;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [ctx.companyId]);

  await createSpAccount("SP-OTW-REC", "SP Recon Goods OTW", "Asset", "sp_goods_otw");
  await createSpAccount("SP-OTWCLR-REC", "SP Recon OTW Clearing", "Liability", "sp_otw_clearing");
  await createSpAccount("SP-PAY-REC", "SP Recon Payable", "Liability", "sp_payable");
  await createSpAccount("SP-STOCK-REC", "SP Recon Stock", "Asset", "sp_stock");
  await createSpAccount("SP-COSTCLR-REC", "SP Recon Cost Clearing", "Liability", "sp_cost_clearing");
  await createSpAccount("SP-OPNBAL-REC", "SP Recon Opening Balance", "Equity", "sp_opnbal");
  await createSpAccount("SP-PREEXP-REC", "SP Recon Prepaid Expenses", "Asset", "sp_prepaid_expenses");

  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);

  // A container in transit is the position every OTW surface is built from: the
  // register row plus the Dr Goods OTW / Cr OTW Clearing voucher it posted.
  const created = await agent.post("/api/sp/containers").send({
    supplierName: `${TEST_PREFIX} Supplier`,
    invoiceNumber: `${TEST_PREFIX}-INV-1`,
    containerNumber: `${TEST_PREFIX}-CNT-1`,
    invoiceDate: "2026-08-03",
    invoiceTotalUsd: INVOICE_TOTAL,
    lines: [],
  });
  expect(created.status).toBe(200);
  containerId = created.body.id;

  const [container] = await db
    .select({ goodsOtwVoucherId: schema.spContainers.goodsOtwVoucherId })
    .from(schema.spContainers)
    .where(eq(schema.spContainers.id, containerId));
  otwVoucherId = Number(container.goodsOtwVoucherId);
  expect(otwVoucherId).toBeGreaterThan(0);
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM sp_container_lines WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_stock_movements WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_offload_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_offloads WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_sale_lines WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_sales WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_profit_splits WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_prepaid_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_containers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("SP full reconciliation independent totals", () => {
  it("passes a consistent position and states what each surface compares", async () => {
    const report = await reconciliation();

    expect(report.status).toBe("PASS");
    expect(report.mismatchCount).toBe(0);

    const otw = surface(report, "goods_otw_open");
    expect(otw.databaseValue).toBeCloseTo(INVOICE_TOTAL, 2);
    expect(otw.reportValue).toBeCloseTo(INVOICE_TOTAL, 2);
    expect(otw.pass).toBe(true);

    const statements = surface(report, "supplier_statements");
    expect(statements.databaseValue).toBeCloseTo(INVOICE_TOTAL, 2);
    expect(statements.reportValue).toBeCloseTo(INVOICE_TOTAL, 2);

    for (const entry of report.surfaces) {
      expect(entry.basis.length, `${entry.key} states no basis`).toBeGreaterThan(20);
      expect(Number.isFinite(entry.databaseValue), `${entry.key} database value`).toBe(true);
      expect(Number.isFinite(entry.reportValue), `${entry.key} report value`).toBe(true);
    }
  }, 60000);

  it("fails goods in transit when the ledger voucher disappears", async () => {
    // The register still says $1,200 of goods are on the way; the general ledger
    // no longer holds the asset. A report that compares each side with itself
    // keeps passing this.
    await pool.query(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [otwVoucherId]);

    const report = await reconciliation();
    expect(report.status).toBe("FAIL");

    const otw = surface(report, "goods_otw_open");
    expect(otw.pass).toBe(false);
    expect(otw.databaseValue).toBeCloseTo(INVOICE_TOTAL, 2);
    expect(otw.reportValue).toBeCloseTo(0, 2);
    expect(report.mismatchCount).toBeGreaterThanOrEqual(1);

    await pool.query(`UPDATE vouchers SET deleted_at = NULL WHERE id = $1`, [otwVoucherId]);
    expect((await reconciliation()).status).toBe("PASS");
  }, 60000);

  it("fails the supplier statement surface when the two OTW legs disagree", async () => {
    // Dr Goods OTW / Cr OTW Clearing is one posting seen from two sides, so the
    // liability leg has to equal the asset leg. Editing one of them is exactly the
    // drift this surface exists for.
    const edited = await pool.query(
      `UPDATE voucher_entries SET credit_amount = '1000' WHERE voucher_id = $1 AND credit_amount::numeric > 0`,
      [otwVoucherId]
    );
    expect(edited.rowCount).toBe(1);

    const report = await reconciliation();
    const statements = surface(report, "supplier_statements");
    expect(statements.pass).toBe(false);
    expect(statements.databaseValue).toBeCloseTo(1000, 2);
    expect(statements.reportValue).toBeCloseTo(INVOICE_TOTAL, 2);
    expect(report.status).toBe("FAIL");

    await pool.query(
      `UPDATE voucher_entries SET credit_amount = '1200' WHERE voucher_id = $1 AND credit_amount::numeric > 0`,
      [otwVoucherId]
    );
    expect((await reconciliation()).status).toBe("PASS");
  }, 60000);

  it("fails opening balances when the movement has no voucher behind it", async () => {
    // Writers stamp source_type 'opening'. The surface used to look for
    // 'opening_stock', a value nothing writes, so it compared 0 with 0 and passed
    // no matter what opening stock existed.
    const [movement] = await db
      .insert(schema.spStockMovements)
      .values({
        companyId: ctx.companyId,
        sourceType: "opening",
        articleCode: `${TEST_PREFIX}-OPEN`,
        stockItemId: ctx.stockItemIds[0],
        locationId: ctx.locationId,
        qtyIn: "10",
        qtyRemaining: "10",
        baseUnitCostUsd: "4",
        landedUnitCostUsd: "4.5",
        finalUnitCostUsd: "5",
      })
      .returning();
    openingMovementId = movement.id;

    const report = await reconciliation();
    const opening = surface(report, "opening_balances");
    expect(opening.databaseValue).toBeCloseTo(50, 2);
    expect(opening.reportValue).toBeCloseTo(0, 2);
    expect(opening.pass).toBe(false);
    expect(report.status).toBe("FAIL");

    // The lot is also stock the ERP inventory knows nothing about.
    expect(surface(report, "stock_on_hand").pass).toBe(false);

    await pool.query(`DELETE FROM sp_stock_movements WHERE id = $1`, [openingMovementId]);
    expect((await reconciliation()).status).toBe("PASS");
  }, 60000);

  it("fails container costs when the recorded offload cost disagrees with its components", async () => {
    await pool.query(
      `INSERT INTO sp_container_lines (container_id, company_id, article_code, qty, unit_rate_usd, stock_item_id)
       VALUES ($1, $2, $3, '10', '100', $4)`,
      [containerId, ctx.companyId, `${TEST_PREFIX}-LINE`, ctx.stockItemIds[0]]
    );
    const [offload] = await db
      .insert(schema.spOffloads)
      .values({
        companyId: ctx.companyId,
        containerId,
        offloadDate: "2026-08-10",
        totalQty: "10",
        totalBaseCostUsd: "1000",
        totalLandedCostUsd: "200",
        totalFinalCostUsd: "1200",
      })
      .returning();
    await pool.query(
      `INSERT INTO sp_offload_charges (offload_id, company_id, charge_type, description, amount_usd)
       VALUES ($1, $2, 'invoice_freight', 'freight', '200')`,
      [offload.id, ctx.companyId]
    );

    // Components: 10 x $100 with no discount = $1,000 base, plus a $200 charge.
    const consistent = await reconciliation();
    const costs = surface(consistent, "container_costs");
    expect(costs.databaseValue).toBeCloseTo(1200, 2);
    expect(costs.reportValue).toBeCloseTo(1200, 2);

    // The container was never marked offloaded, which the same surface reports.
    expect(costs.pass).toBe(false);
    expect(consistent.status).toBe("FAIL");

    await pool.query(`UPDATE sp_containers SET status = 'offloaded' WHERE id = $1`, [containerId]);
    expect(surface(await reconciliation(), "container_costs").pass).toBe(true);

    // Now break the arithmetic: the stored final cost no longer matches its parts.
    await pool.query(`UPDATE sp_offloads SET total_final_cost_usd = '1500' WHERE id = $1`, [offload.id]);
    const broken = await reconciliation();
    const brokenCosts = surface(broken, "container_costs");
    expect(brokenCosts.databaseValue).toBeCloseTo(1500, 2);
    expect(brokenCosts.reportValue).toBeCloseTo(1200, 2);
    expect(brokenCosts.pass).toBe(false);

    await pool.query(`DELETE FROM sp_offload_charges WHERE offload_id = $1`, [offload.id]);
    await pool.query(`DELETE FROM sp_offloads WHERE id = $1`, [offload.id]);
    await pool.query(`DELETE FROM sp_container_lines WHERE container_id = $1`, [containerId]);
    await pool.query(`UPDATE sp_containers SET status = 'open' WHERE id = $1`, [containerId]);
    expect((await reconciliation()).status).toBe("PASS");
  }, 60000);
});
