/**
 * Accounting audit wave 17 (C): Retail Wave 1 money paths, against the database.
 *
 *   - Payment lines are split by largest remainder (allocateCents): they add up
 *     to the sale exactly and none is negative (the old split could push the
 *     last line below zero); a payment whose share is zero gets no line.
 *   - The voucher date is the company's business date (its timezone).
 *   - The Retail default accounts come from the system account registry: an
 *     existing account is never renamed, retyped or restored; a conflicting one
 *     refuses the settings save (409) and is listed by the integrity diagnostic.
 *   - Settings saves and cash movements are audited in their transaction; a
 *     cash movement replay compares the amount exactly.
 */
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { getCompanyBusinessDate } from "../server/lib/dateUtils";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "wave17cretail";
const TIMEZONE = "Pacific/Kiritimati"; // UTC+14: its business date is often not the UTC date
let ctx: TestContext;
let agent: request.SuperAgentTest;
let variantId = 0;

async function purgeRetailRows(companyId: number) {
  for (const table of [
    "retail_cash_movements",
    "retail_pos_payments",
    "retail_pos_return_items",
    "retail_pos_returns",
    "retail_pos_sale_items",
    "retail_pos_sales",
    "retail_stock_movements",
    "retail_stock_operations",
    "retail_variant_inventory",
    "retail_product_variants",
    "retail_products",
    "retail_brands",
    "retail_accounting_settings",
    "pos_shifts",
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [companyId]);
  }
}

async function auditRows(tableName: string) {
  return (
    await pool.query(
      `SELECT action, record_identifier, changes FROM audit_log WHERE company_id = $1 AND table_name = $2 ORDER BY id`,
      [ctx.companyId, tableName]
    )
  ).rows;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'retail' WHERE id = $1`, [ctx.companyId]);
  await db
    .insert(schema.companySettings)
    .values({ companyId: ctx.companyId, timezone: TIMEZONE })
    .onConflictDoUpdate({ target: schema.companySettings.companyId, set: { timezone: TIMEZONE } });
  await db
    .update(schema.userCompanyRoles)
    .set({ assignedLocationId: ctx.locationId })
    .where(and(eq(schema.userCompanyRoles.userId, ctx.userId), eq(schema.userCompanyRoles.companyId, ctx.companyId)));
  await db
    .insert(schema.userLocations)
    .values({ userId: ctx.userId, companyId: ctx.companyId, locationId: ctx.locationId });

  const [brand] = await db
    .insert(schema.retailBrands)
    .values({ companyId: ctx.companyId, name: "W17C", normalizedName: "w17c" })
    .returning({ id: schema.retailBrands.id });
  const [product] = await db
    .insert(schema.retailProducts)
    .values({ companyId: ctx.companyId, code: "W17C-TEE", name: "Wave 17C Tee", brandId: brand.id })
    .returning({ id: schema.retailProducts.id });
  const [variant] = await db
    .insert(schema.retailProductVariants)
    .values({
      companyId: ctx.companyId,
      productId: product.id,
      color: "Red",
      size: "S",
      barcode: "W17C-BARCODE-001",
      sku: "W17C-TEE-S",
      cost: "0.400000",
      sellingPrice: "1.000000",
    })
    .returning({ id: schema.retailProductVariants.id });
  variantId = variant.id;
  await db.insert(schema.retailVariantInventory).values({
    companyId: ctx.companyId,
    variantId,
    locationId: ctx.locationId,
    quantity: "10.000000",
    averageCost: "0.400000",
  });

  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  await purgeRetailRows(ctx.companyId);
  await cleanupTestData(PREFIX);
  await closeTestServer();
}, 120000);

describe("Retail default accounts (registry, never rewritten)", () => {
  it("refuses the settings save while a default account has another type, changing nothing", async () => {
    const [conflicting] = await db
      .insert(schema.ledgerAccounts)
      .values({ companyId: ctx.companyId, code: "RETAIL-CARD", name: "Card float (kept)", accountType: "Expense" })
      .returning();
    const refused = await agent.put("/api/retail/financial/settings").send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("RETAIL_ACCOUNT_CONFLICT");
    expect(refused.body.conflicts).toEqual([
      expect.objectContaining({
        code: "RETAIL-CARD",
        issue: "type_differs",
        expectedType: "Asset",
        actualType: "Expense",
      }),
    ]);
    const [after] = await db.select().from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.id, conflicting.id));
    expect([after.name, after.accountType, after.deletedAt]).toEqual(["Card float (kept)", "Expense", null]);
    // Rolled back whole: no settings row and no other Retail account was created.
    expect(
      (await pool.query(`SELECT 1 FROM retail_accounting_settings WHERE company_id = $1`, [ctx.companyId])).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(`SELECT 1 FROM ledger_accounts WHERE company_id = $1 AND code = 'RETAIL-CASH'`, [
          ctx.companyId,
        ])
      ).rowCount
    ).toBe(0);

    const report = await runAccountingIntegrityDiagnostic(ctx.companyId);
    const review = report.checks.find((check) => check.key === "system_accounts_needing_review");
    expect(review?.samples).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "RETAIL-CARD", state: "type_differs" })])
    );
  });

  it("saves when the conflicting default is replaced by a chosen account, audited in the save", async () => {
    const [cardClearing] = await db
      .insert(schema.ledgerAccounts)
      .values({ companyId: ctx.companyId, code: `${PREFIX}-CARD`, name: "Card clearing", accountType: "Asset" })
      .returning();
    const saved = await agent.put("/api/retail/financial/settings").send({ cardLedgerAccountId: cardClearing.id });
    expect(saved.status).toBe(200);
    expect(saved.body.cardLedgerAccountId).toBe(cardClearing.id);
    const cash = await pool.query(
      `SELECT name, account_type FROM ledger_accounts WHERE company_id = $1 AND code = 'RETAIL-CASH'`,
      [ctx.companyId]
    );
    expect(cash.rows).toEqual([{ name: "Retail Cash", account_type: "Cash" }]);
    const audit = await auditRows("retail_accounting_settings");
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("create");
    expect(audit[0].changes.cardLedgerAccountId).toEqual({ new: cardClearing.id });
  });
});

describe("Retail sale posting", () => {
  let shiftId = 0;

  it("splits payments by largest remainder, never a negative or zero line, dated on the business date", async () => {
    const shift = await agent.post("/api/pos/shifts/open").send({ locationId: ctx.locationId, openingCash: 0 });
    expect(shift.status).toBe(200);
    shiftId = Number(shift.body.id);
    // Rounded one by one these are 0.50 + 0.50 + 0.01 + 0.01 = 1.02, and the old
    // split put the -0.02 difference on the last line (-0.01).
    const sale = await agent.post("/api/pos/retail/sales").send({
      locationId: ctx.locationId,
      shiftId,
      idempotencyKey: "wave17c-retail-sale-0001",
      payments: [
        { method: "cash", amount: "0.495", tenderedAmount: "0.495" },
        { method: "card", amount: 0.495 },
        { method: "mobile", amount: "0.005" },
        { method: "other", amount: "0.005" },
      ],
      items: [{ variantId, quantity: 1 }],
    });
    expect(sale.status).toBe(201);
    const voucherId = Number(sale.body.sale.accountingVoucherId);
    const [voucher] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId));
    expect(String(voucher.voucherDate).slice(0, 10)).toBe(getCompanyBusinessDate(TIMEZONE));
    const lines = (
      await pool.query(
        `SELECT debit_amount::text AS d, credit_amount::text AS c FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [voucherId]
      )
    ).rows;
    expect(lines.every((line) => Number(line.d) >= 0 && Number(line.c) >= 0)).toBe(true);
    expect(lines.every((line) => Number(line.d) > 0 || Number(line.c) > 0)).toBe(true);
    const debits = lines.filter((line) => Number(line.d) > 0).map((line) => line.d);
    // Payments 0.50 + 0.50, then COGS 0.40.
    expect(debits).toEqual(["0.50", "0.50", "0.40"]);
    const sum = (key: "d" | "c") => lines.reduce((acc, line) => acc + Math.round(Number(line[key]) * 100), 0);
    expect(sum("d")).toBe(sum("c"));
  });

  it("audits a cash movement in its transaction and compares a replay exactly", async () => {
    // Wave 17 (D): a movement names its reason code (journalled against its account);
    // amounts are in cents, so the changed replay differs by a cent.
    const body = {
      movementType: "cash_in",
      amount: "2.50",
      reason: "Float top-up",
      reasonCode: "owner_funding",
      idempotencyKey: "w17c-move-0001",
    };
    const first = await agent.post(`/api/pos/retail/shifts/${shiftId}/cash-movements`).send(body);
    expect(first.status).toBe(201);
    const replay = await agent.post(`/api/pos/retail/shifts/${shiftId}/cash-movements`).send({ ...body, amount: 2.5 });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const changed = await agent
      .post(`/api/pos/retail/shifts/${shiftId}/cash-movements`)
      .send({ ...body, amount: "2.51" });
    expect(changed.status).toBe(409);
    const audit = await auditRows("retail_cash_movements");
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.movement.new).toMatchObject({ movementType: "cash_in", amount: "2.500000" });
  });
});
