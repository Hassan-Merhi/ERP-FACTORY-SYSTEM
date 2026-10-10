/**
 * tests/sp-sales-accounting.test.ts
 *
 * Regression test for Supplier Partner sale accounting.
 *
 * POST /api/sp/sales must post ONLY the customer cash collected on the sale
 * voucher — it must never look like Bank+COGS (e.g. 1700 for a 1000 sale
 * with a 700 cost). Supplier Cash Payable is the full selling price
 * collected from the customer; COGS/profit/remaining-stock-value are
 * derived separately from sp_stock_movements and sp_sale_lines.final_unit_cost_usd,
 * never posted as extra Dr/Cr lines on the sale voucher.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { pool, db } from "../server/db";
import { eq, sql } from "drizzle-orm";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "spsalestest";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let payableAcctId: number;
let salesAcctId: number;
let cogsAcctId: number;
let stockAcctId: number;
let costClrAcctId: number;
let bankAccountId: number;

async function loginAsTestUser() {
  const loginRes = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);

  // Mark the seeded company as a supplier_partner company (requireSpCompany gate).
  await pool.query(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [ctx.companyId]);

  // Seed the full SP chart of accounts (mirrors POST /api/sp/setup) so we can
  // assert that COGS/Sales/Stock/Cost-Clearing accounts are NOT touched.
  const [payableAcct] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: "SP-PAY",
      name: "Supplier Cash Payable",
      accountType: "Liability",
      subType: "sp_payable",
      openingBalance: "0",
      openingBalanceSide: "Cr",
    })
    .returning();
  payableAcctId = payableAcct.id;

  const [salesAcct] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: "SP-SALES",
      name: "Sales",
      accountType: "Income",
      subType: "sp_sales",
      openingBalance: "0",
      openingBalanceSide: "Cr",
    })
    .returning();
  salesAcctId = salesAcct.id;

  const [cogsAcct] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: "SP-COGS",
      name: "Cost of Goods Sold",
      accountType: "Direct Expense",
      subType: "sp_cogs",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  cogsAcctId = cogsAcct.id;

  const [stockAcct] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: "SP-STOCK",
      name: "Stock on Floor",
      accountType: "Asset",
      subType: "sp_stock",
      isHidden: true,
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  stockAcctId = stockAcct.id;

  const [costClrAcct] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: "SP-COSTCLR",
      name: "Stock Cost Payable Clearing",
      accountType: "Liability",
      subType: "sp_cost_clearing",
      isHidden: true,
      openingBalance: "0",
      openingBalanceSide: "Cr",
    })
    .returning();
  costClrAcctId = costClrAcct.id;

  const [bankAccount] = await db
    .insert(schema.bankAccounts)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}_BANK`,
      name: "Test Bank",
      bankName: "Test Bank Co",
      accountNumber: "0000000001",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  bankAccountId = bankAccount.id;

  agent = request.agent(ctx.app);
  await loginAsTestUser();
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM sp_sale_lines WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_sales WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_stock_movements WHERE company_id = $1`, [ctx.companyId]);
  // Lines on these bank accounts go first: voucher_entries.bank_account_id is a
  // RESTRICT foreign key. Every line of their vouchers goes with them, in one
  // statement, so no voucher is left one-sided for the voucher balance guard.
  await db
    .delete(schema.voucherEntries)
    .where(
      sql`${schema.voucherEntries.voucherId} IN (SELECT voucher_id FROM voucher_entries WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE company_id = ${ctx.companyId}))`
    );
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, ctx.companyId));
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

async function seedStockLot(qtyIn: number, baseUnitCost: number, finalUnitCost: number) {
  const [stockItemId] = ctx.stockItemIds;
  const { rows } = await pool.query(
    `INSERT INTO sp_stock_movements
       (company_id, article_code, description, stock_item_id, location_id, qty_in, qty_remaining, base_unit_cost_usd, landed_unit_cost_usd, final_unit_cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7, $8)
     RETURNING *`,
    [
      ctx.companyId,
      `${TEST_PREFIX}-ART`,
      "Test Article",
      stockItemId,
      ctx.locationId,
      qtyIn,
      baseUnitCost,
      finalUnitCost,
    ]
  );
  return rows[0];
}

describe("Supplier Partner sale accounting — POST /api/sp/sales", () => {
  it("posts ONLY Dr Bank / Cr Supplier Cash Payable = totalSalePrice (never Bank+COGS)", async () => {
    // Sale price = 1000, final cost = 700, base cost = 500, for qty = 1.
    await seedStockLot(1, 500, 700);
    const [stockItemId] = ctx.stockItemIds;

    const beforeQty = await pool.query(
      `SELECT COALESCE(SUM(qty_remaining::numeric), 0) AS qty FROM sp_stock_movements WHERE company_id = $1 AND stock_item_id = $2`,
      [ctx.companyId, stockItemId]
    );
    const qtyBefore = parseFloat(beforeQty.rows[0].qty);

    const res = await agent.post("/api/sp/sales").send({
      saleDate: new Date().toISOString().split("T")[0],
      customerName: "Test Customer",
      bankAccountId,
      saleLines: [{ stockItemId, qtySold: 1, salePricePerUnit: 1000 }],
    });

    expect(res.status).toBe(200);
    const sale = res.body;
    expect(sale.voucherId).toBeTruthy();

    // Sale record fields (reference-only totals).
    expect(parseFloat(sale.totalSalePriceUsd)).toBeCloseTo(1000, 2);
    expect(parseFloat(sale.totalBaseCostUsd)).toBeCloseTo(500, 2);
    expect(parseFloat(sale.totalFinalCostUsd)).toBeCloseTo(700, 2);
    expect(parseFloat(sale.grossProfitUsd)).toBeCloseTo(300, 2);

    const entries = await db
      .select()
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, sale.voucherId));

    const totalDebit = entries.reduce((s, e) => s + parseFloat(e.debitAmount as any), 0);
    const totalCredit = entries.reduce((s, e) => s + parseFloat(e.creditAmount as any), 0);

    // Voucher must be exactly 1000/1000 — never 1700 (Bank+COGS double-count).
    expect(totalDebit).toBeCloseTo(1000, 2);
    expect(totalCredit).toBeCloseTo(1000, 2);

    // Exactly two entries: Dr Bank, Cr Supplier Cash Payable.
    expect(entries.length).toBe(2);

    const bankEntry = entries.find((e) => e.bankAccountId === bankAccountId);
    expect(bankEntry).toBeDefined();
    expect(parseFloat(bankEntry!.debitAmount as any)).toBeCloseTo(1000, 2);
    expect(parseFloat(bankEntry!.creditAmount as any)).toBeCloseTo(0, 2);

    const payableEntry = entries.find((e) => e.ledgerAccountId === payableAcctId);
    expect(payableEntry).toBeDefined();
    expect(parseFloat(payableEntry!.creditAmount as any)).toBeCloseTo(1000, 2);
    expect(parseFloat(payableEntry!.debitAmount as any)).toBeCloseTo(0, 2);

    // No Sales credit, no COGS debit, no Stock credit, no Cost-Clearing debit.
    expect(entries.find((e) => e.ledgerAccountId === salesAcctId)).toBeUndefined();
    expect(entries.find((e) => e.ledgerAccountId === cogsAcctId)).toBeUndefined();
    expect(entries.find((e) => e.ledgerAccountId === stockAcctId)).toBeUndefined();
    expect(entries.find((e) => e.ledgerAccountId === costClrAcctId)).toBeUndefined();

    // Stock qty still decreases via sp_stock_movements.
    const afterQty = await pool.query(
      `SELECT COALESCE(SUM(qty_remaining::numeric), 0) AS qty FROM sp_stock_movements WHERE company_id = $1 AND stock_item_id = $2`,
      [ctx.companyId, stockItemId]
    );
    expect(parseFloat(afterQty.rows[0].qty)).toBeCloseTo(qtyBefore - 1, 4);

    // Sale line retains the true final unit cost for downstream COGS/profit reporting.
    const lines = await db.select().from(schema.spSaleLines).where(eq(schema.spSaleLines.saleId, sale.id));
    expect(lines.length).toBe(1);
    expect(parseFloat(lines[0].finalUnitCostUsd as any)).toBeCloseTo(700, 4);
  });

  it("rejects a sale with no bankAccountId (would otherwise post an unbalanced single-credit voucher)", async () => {
    const [stockItemId] = ctx.stockItemIds;
    await seedStockLot(1, 500, 700);

    const salesBefore = await pool.query(`SELECT COUNT(*)::int AS c FROM sp_sales WHERE company_id = $1`, [
      ctx.companyId,
    ]);

    const res = await agent.post("/api/sp/sales").send({
      saleDate: new Date().toISOString().split("T")[0],
      customerName: "Test Customer No Bank",
      saleLines: [{ stockItemId, qtySold: 1, salePricePerUnit: 1000 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cash or bank account/i);

    const salesAfter = await pool.query(`SELECT COUNT(*)::int AS c FROM sp_sales WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    expect(salesAfter.rows[0].c).toBe(salesBefore.rows[0].c);

    // No voucher should have been created either — the request must be rejected
    // before any pre-transaction side effect, not just fail to balance afterward.
    const voucherCountForNoBankSale = await pool.query(
      `SELECT COUNT(*)::int AS c FROM vouchers WHERE company_id = $1 AND description = $2`,
      [ctx.companyId, "Sale — Test Customer No Bank"]
    );
    expect(voucherCountForNoBankSale.rows[0].c).toBe(0);
  });

  it("posts ONLY Dr Cash / Cr Supplier Cash Payable = totalSalePrice when paymentAccountType is cash", async () => {
    await seedStockLot(1, 500, 700);
    const [stockItemId] = ctx.stockItemIds;

    const res = await agent.post("/api/sp/sales").send({
      saleDate: new Date().toISOString().split("T")[0],
      customerName: "Test Customer Cash",
      paymentAccountType: "cash",
      paymentAccountId: ctx.cashAccountId,
      saleLines: [{ stockItemId, qtySold: 1, salePricePerUnit: 1000 }],
    });

    expect(res.status).toBe(200);
    const sale = res.body;
    expect(sale.voucherId).toBeTruthy();

    const entries = await db
      .select()
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, sale.voucherId));

    expect(entries.length).toBe(2);

    const totalDebit = entries.reduce((s, e) => s + parseFloat(e.debitAmount as any), 0);
    const totalCredit = entries.reduce((s, e) => s + parseFloat(e.creditAmount as any), 0);
    expect(totalDebit).toBeCloseTo(1000, 2);
    expect(totalCredit).toBeCloseTo(1000, 2);

    const cashEntry = entries.find((e) => e.ledgerAccountId === ctx.cashAccountId);
    expect(cashEntry).toBeDefined();
    expect(cashEntry!.bankAccountId).toBeNull();
    expect(parseFloat(cashEntry!.debitAmount as any)).toBeCloseTo(1000, 2);
    expect(parseFloat(cashEntry!.creditAmount as any)).toBeCloseTo(0, 2);

    const payableEntry = entries.find((e) => e.ledgerAccountId === payableAcctId);
    expect(payableEntry).toBeDefined();
    expect(parseFloat(payableEntry!.creditAmount as any)).toBeCloseTo(1000, 2);
  });

  it("falls back to bankAccountId when paymentAccountType/paymentAccountId are not sent (legacy callers)", async () => {
    await seedStockLot(1, 500, 700);
    const [stockItemId] = ctx.stockItemIds;

    const res = await agent.post("/api/sp/sales").send({
      saleDate: new Date().toISOString().split("T")[0],
      customerName: "Test Customer Legacy",
      bankAccountId,
      saleLines: [{ stockItemId, qtySold: 1, salePricePerUnit: 1000 }],
    });

    expect(res.status).toBe(200);
    const sale = res.body;
    expect(sale.voucherId).toBeTruthy();

    const entries = await db
      .select()
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, sale.voucherId));

    const bankEntry = entries.find((e) => e.bankAccountId === bankAccountId);
    expect(bankEntry).toBeDefined();
    expect(bankEntry!.ledgerAccountId).toBeFalsy();
    expect(parseFloat(bankEntry!.debitAmount as any)).toBeCloseTo(1000, 2);
  });

  it("still requires the Supplier Cash Payable account to be configured", async () => {
    // Temporarily rename subType so getSpAccount can't find it, to confirm the gate uses payableAcct only.
    await db
      .update(schema.ledgerAccounts)
      .set({ subType: "sp_payable_disabled_temp" })
      .where(eq(schema.ledgerAccounts.id, payableAcctId));

    const [stockItemId] = ctx.stockItemIds;
    await seedStockLot(1, 500, 700);

    const res = await agent.post("/api/sp/sales").send({
      saleDate: new Date().toISOString().split("T")[0],
      customerName: "Test Customer 2",
      bankAccountId,
      saleLines: [{ stockItemId, qtySold: 1, salePricePerUnit: 1000 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not configured/i);

    // Restore for other tests / afterAll cleanup expectations.
    await db
      .update(schema.ledgerAccounts)
      .set({ subType: "sp_payable" })
      .where(eq(schema.ledgerAccounts.id, payableAcctId));
  });
});
