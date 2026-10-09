/**
 * Accounting audit wave 17 (D), owner decisions 2 and 3 of 2026-10-09, against
 * the database.
 *
 *   Decision 2, Retail cash movements journalled:
 *     - cash in/out posts RETAIL-CASH-{movement} in the movement's transaction:
 *       the shift's cash account against the reason code's account (registry
 *       defaults: owner funding -> RETAIL-OWNER-FUNDS, expense ->
 *       RETAIL-CASH-EXPENSE); an unmapped reason ("other") is refused (409)
 *       until it is mapped, the mapping save is audited; a reason in the wrong
 *       direction and an amount below the cent are refused (400);
 *     - a shift close journals counted − expected to RETAIL-CASH-OVER-SHORT;
 *     - movements before the wave (no voucher) are listed by the diagnostic.
 *   Decision 3, RETAIL-INVENTORY connected to stock:
 *     - before the opening nothing is journalled (receipt);
 *     - the Owner preview/apply posts the opening (sub-ledger less ledger) Dr
 *       Retail inventory / Cr Opening Balance Equity, refuses a future date, a
 *       changed plan, a second apply and a non-Owner;
 *     - after it receipts (Cr RETAIL-GRNI), adjustments (RETAIL-INVENTORY-
 *       ADJUSTMENT), transfers (cost moved, no journal) and returns (at the
 *       sale's cost, the refund journal already debits it) keep the ledger
 *       equal to the sub-ledger; the reconciliation and diagnostic agree.
 */
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { getCompanyBusinessDate } from "../server/lib/dateUtils";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import { ensureRetailLedgerSchema } from "../server/services/retail/retailLedgerSchema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "wave17dretail";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let variantId = 0;
const today = () => getCompanyBusinessDate(undefined);

async function purgeRetailRows(companyId: number) {
  for (const table of [
    "retail_cash_movements",
    "retail_cash_reason_accounts",
    "retail_inventory_openings",
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

/** The lines of a voucher by number: account code (or bank), debit, credit. */
async function voucherLines(voucherNumber: string) {
  return (
    await pool.query(
      `SELECT COALESCE(la.code, 'bank:' || ve.bank_account_id::text) AS code,
              ve.debit_amount::text AS d, ve.credit_amount::text AS c
         FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = $1 AND v.voucher_number = $2 AND v.deleted_at IS NULL
        ORDER BY ve.id`,
      [ctx.companyId, voucherNumber]
    )
  ).rows.map((row) => ({ code: row.code, d: Number(row.d).toFixed(2), c: Number(row.c).toFixed(2) }));
}

async function vouchersLike(pattern: string) {
  return (
    await pool.query(
      `SELECT voucher_number FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL ORDER BY id`,
      [ctx.companyId, pattern]
    )
  ).rows.map((row) => row.voucher_number as string);
}

async function openShift(openingCash: number): Promise<number> {
  const shift = await agent.post("/api/pos/shifts/open").send({ locationId: ctx.locationId, openingCash });
  expect(shift.status).toBe(200);
  return Number(shift.body.id);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureRetailLedgerSchema(pool);
  await pool.query(`UPDATE companies SET company_type = 'retail' WHERE id = $1`, [ctx.companyId]);
  await db
    .update(schema.userCompanyRoles)
    .set({ assignedLocationId: ctx.locationId })
    .where(and(eq(schema.userCompanyRoles.userId, ctx.userId), eq(schema.userCompanyRoles.companyId, ctx.companyId)));
  await db
    .insert(schema.userLocations)
    .values({ userId: ctx.userId, companyId: ctx.companyId, locationId: ctx.locationId });

  const [brand] = await db
    .insert(schema.retailBrands)
    .values({ companyId: ctx.companyId, name: "W17D", normalizedName: "w17d" })
    .returning({ id: schema.retailBrands.id });
  const [product] = await db
    .insert(schema.retailProducts)
    .values({ companyId: ctx.companyId, code: "W17D-TEE", name: "Wave 17D Tee", brandId: brand.id })
    .returning({ id: schema.retailProducts.id });
  const [variant] = await db
    .insert(schema.retailProductVariants)
    .values({
      companyId: ctx.companyId,
      productId: product.id,
      color: "Blue",
      size: "M",
      barcode: "W17D-BARCODE-001",
      sku: "W17D-TEE-M",
      cost: "4.000000",
      sellingPrice: "9.000000",
    })
    .returning({ id: schema.retailProductVariants.id });
  variantId = variant.id;
  await db.insert(schema.retailVariantInventory).values({
    companyId: ctx.companyId,
    variantId,
    locationId: ctx.locationId,
    quantity: "10.000000",
    averageCost: "4.000000",
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

describe("Retail cash movements in the ledger (decision 2)", () => {
  let shiftId = 0;
  const move = (body: Record<string, unknown>) =>
    agent.post(`/api/pos/retail/shifts/${shiftId}/cash-movements`).send(body);

  it("journals cash in and cash out against the reason's default account, in the movement's transaction", async () => {
    shiftId = await openShift(100);
    const cashIn = await move({
      movementType: "cash_in",
      amount: "20.00",
      reason: "Owner float",
      reasonCode: "owner_funding",
      idempotencyKey: "w17d-move-0001",
    });
    expect(cashIn.status).toBe(201);
    const movementId = Number(cashIn.body.movement.id);
    expect(await voucherLines(`RETAIL-CASH-${movementId}`)).toEqual([
      { code: "RETAIL-CASH", d: "20.00", c: "0.00" },
      { code: "RETAIL-OWNER-FUNDS", d: "0.00", c: "20.00" },
    ]);
    expect(cashIn.body.movement.voucherId ?? null).toBeNull(); // the row as inserted
    const stored = await pool.query(`SELECT voucher_id, reason_code FROM retail_cash_movements WHERE id = $1`, [
      movementId,
    ]);
    expect(stored.rows[0].reason_code).toBe("owner_funding");
    expect(stored.rows[0].voucher_id).toBeGreaterThan(0);
    const audit = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'retail_cash_movements' AND record_id = $2`,
      [ctx.companyId, movementId]
    );
    expect(audit.rows[0].changes.movement.new).toMatchObject({
      reasonCode: "owner_funding",
      voucherId: stored.rows[0].voucher_id,
    });

    const cashOut = await move({
      movementType: "cash_out",
      amount: "5.25",
      reason: "Cleaning supplies",
      reasonCode: "expense",
      idempotencyKey: "w17d-move-0002",
    });
    expect(cashOut.status).toBe(201);
    expect(await voucherLines(`RETAIL-CASH-${cashOut.body.movement.id}`)).toEqual([
      { code: "RETAIL-CASH", d: "0.00", c: "5.25" },
      { code: "RETAIL-CASH-EXPENSE", d: "5.25", c: "0.00" },
    ]);
  });

  it("refuses an unmapped reason (409) until it is mapped, a wrong direction and sub-cent amounts (400)", async () => {
    const before = (
      await pool.query(`SELECT COUNT(*)::int AS n FROM retail_cash_movements WHERE company_id = $1`, [ctx.companyId])
    ).rows[0].n;
    const unmapped = await move({
      movementType: "cash_in",
      amount: "1.00",
      reason: "Found",
      idempotencyKey: "w17d-move-0003",
    });
    expect(unmapped.status).toBe(409);
    expect(unmapped.body).toMatchObject({ code: "RETAIL_CASH_REASON_UNMAPPED", reasonCode: "other" });
    const wrongWay = await move({
      movementType: "cash_in",
      amount: "1.00",
      reason: "Wrong way",
      reasonCode: "expense",
      idempotencyKey: "w17d-move-0004",
    });
    expect(wrongWay.status).toBe(400);
    const subCent = await move({
      movementType: "cash_in",
      amount: "1.005",
      reason: "Owner",
      reasonCode: "owner_funding",
      idempotencyKey: "w17d-move-0005",
    });
    expect(subCent.status).toBe(400);
    const after = (
      await pool.query(`SELECT COUNT(*)::int AS n FROM retail_cash_movements WHERE company_id = $1`, [ctx.companyId])
    ).rows[0].n;
    expect(after).toBe(before);

    const [suspense] = await db
      .insert(schema.ledgerAccounts)
      .values({ companyId: ctx.companyId, code: `${PREFIX}-SUSP`, name: "Cash suspense", accountType: "Liability" })
      .returning();
    const mapped = await agent
      .put("/api/retail/financial/cash-reasons")
      .send({ reasons: [{ reasonCode: "other", ledgerAccountId: suspense.id, bankAccountId: null }] });
    expect(mapped.status).toBe(200);
    expect(mapped.body.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCode: "other", ledgerAccountId: suspense.id, source: "mapping" }),
      ])
    );
    const mappingAudit = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'retail_cash_reason_accounts'`,
      [ctx.companyId]
    );
    expect(mappingAudit.rows[0].changes.other).toEqual({
      old: { ledgerAccountId: null, bankAccountId: null },
      new: { ledgerAccountId: suspense.id, bankAccountId: null },
    });
    const nowMapped = await move({
      movementType: "cash_in",
      amount: "1.00",
      reason: "Found",
      idempotencyKey: "w17d-move-0003",
    });
    expect(nowMapped.status).toBe(201);
    expect(await voucherLines(`RETAIL-CASH-${nowMapped.body.movement.id}`)).toEqual([
      { code: "RETAIL-CASH", d: "1.00", c: "0.00" },
      { code: `${PREFIX}-SUSP`, d: "0.00", c: "1.00" },
    ]);
  });

  it("journals the shift's cash short at close to Cash Over/Short", async () => {
    // Expected 100 + 20 − 5.25 + 1 = 115.75; counted 113.75: short 2.00.
    const closed = await agent.post(`/api/pos/shifts/${shiftId}/close`).send({ closingCash: "113.75" });
    expect(closed.status).toBe(200);
    expect(closed.body.variance).toBe("-2.00");
    expect(await voucherLines(`RETAIL-OVERSHORT-${shiftId}`)).toEqual([
      { code: "RETAIL-CASH", d: "0.00", c: "2.00" },
      { code: "RETAIL-CASH-OVER-SHORT", d: "2.00", c: "0.00" },
    ]);
  });

  it("lists a movement recorded before the wave (no voucher) in the diagnostic, without back-filling it", async () => {
    await pool.query(
      `INSERT INTO retail_cash_movements (company_id, location_id, shift_id, movement_type, amount, reason, idempotency_key, created_by)
       VALUES ($1, $2, $3, 'cash_out', 3, 'legacy drop', 'w17d-legacy-0001', $4)`,
      [ctx.companyId, ctx.locationId, shiftId, ctx.userId]
    );
    const report = await runAccountingIntegrityDiagnostic(ctx.companyId);
    const legacy = report.checks.find((check) => check.key === "retail_cash_movements_without_journal");
    expect(legacy).toMatchObject({ status: "warn", count: 1, amount: "-3.00" });
    expect(await vouchersLike("RETAIL-CASH-%")).toHaveLength(3);
  });
});

describe("RETAIL-INVENTORY connected to the Retail stock (decision 3)", () => {
  let shiftId = 0;
  const reconciliation = async () => (await agent.get("/api/retail/financial/inventory-reconciliation")).body;

  it("journals nothing before the opening", async () => {
    const receipt = await agent.post("/api/pos/retail/receipts").send({
      idempotencyKey: "w17d-receipt-0001",
      variantId,
      locationId: ctx.locationId,
      quantity: 5,
      unitCost: 6,
    });
    expect(receipt.status).toBe(201);
    expect(await vouchersLike("RETAIL-STK-%")).toEqual([]);
    // 10 × 4 + 5 × 6 = 70 in stock, nothing in the ledger.
    expect(await reconciliation()).toMatchObject({
      ledger: "0.00",
      subLedger: "70.00",
      difference: "-70.00",
      opening: null,
    });
  });

  it("applies the opening by Owner preview/apply only, refusing a future date, a changed plan and a second apply", async () => {
    const asAdmin = await agent.get(`/api/retail/financial/inventory-opening/preview?openingDate=${today()}`);
    expect(asAdmin.status).toBe(403);
    await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
      ctx.userId,
      ctx.companyId,
    ]);
    // The role is read at sign-in.
    await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
    expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
    const future = await agent.get(`/api/retail/financial/inventory-opening/preview?openingDate=2099-01-01`);
    expect(future.body.blockers).toContain("RETAIL_INVENTORY_OPENING_FUTURE_DATE");
    const yesterday = new Date(Date.parse(`${today()}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const earlier = await agent.get(`/api/retail/financial/inventory-opening/preview?openingDate=${yesterday}`);
    expect(earlier.body.blockers).toContain("RETAIL_INVENTORY_OPENING_LATER_DOCUMENTS");

    const plan = await agent.get(`/api/retail/financial/inventory-opening/preview?openingDate=${today()}`);
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ subLedgerValue: "70.00", ledgerBalance: "0.00", amount: "70.00", blockers: [] });
    const stale = await agent
      .post("/api/retail/financial/inventory-opening/apply")
      .send({ openingDate: today(), planHash: "0".repeat(64), confirm: true });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("RETAIL_INVENTORY_OPENING_PLAN_CHANGED");
    const applied = await agent
      .post("/api/retail/financial/inventory-opening/apply")
      .send({ openingDate: today(), planHash: plan.body.planHash, confirm: true });
    expect(applied.status).toBe(200);
    expect(await voucherLines(`RETAIL-INV-OPEN-${ctx.companyId}`)).toEqual([
      { code: "RETAIL-INVENTORY", d: "70.00", c: "0.00" },
      { code: "OPENING_BALANCE_EQUITY", d: "0.00", c: "70.00" },
    ]);
    const again = await agent
      .post("/api/retail/financial/inventory-opening/apply")
      .send({ openingDate: today(), planHash: plan.body.planHash, confirm: true });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("RETAIL_INVENTORY_OPENING_ALREADY_APPLIED");
    const audit = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'retail_inventory_openings'`,
      [ctx.companyId]
    );
    expect(audit.rows[0].changes.amount).toEqual({ new: "70.00" });
    expect(await reconciliation()).toMatchObject({ difference: "0.00" });
  });

  it("journals receipts, adjustments, transfers and returns value-exactly after the opening", async () => {
    const receipt = await agent.post("/api/pos/retail/receipts").send({
      idempotencyKey: "w17d-receipt-0002",
      variantId,
      locationId: ctx.locationId,
      quantity: 5,
      unitCost: 6,
    });
    expect(receipt.status).toBe(201);
    expect(await voucherLines(`RETAIL-STK-RECEIPT-${receipt.body.operationId}`)).toEqual([
      { code: "RETAIL-INVENTORY", d: "30.00", c: "0.00" },
      { code: "RETAIL-GRNI", d: "0.00", c: "30.00" },
    ]);

    const adjustment = await agent.post("/api/pos/retail/adjustments").send({
      idempotencyKey: "w17d-adjust-0001",
      variantId,
      locationId: ctx.locationId,
      quantityDelta: -2,
      reason: "Damaged",
    });
    expect(adjustment.status).toBe(201);
    expect(await voucherLines(`RETAIL-STK-ADJUSTMENT-${adjustment.body.operationId}`)).toEqual([
      { code: "RETAIL-INVENTORY", d: "0.00", c: "10.00" },
      { code: "RETAIL-INVENTORY-ADJUSTMENT", d: "10.00", c: "0.00" },
    ]);

    const transfer = await agent.post("/api/pos/retail/transfers").send({
      idempotencyKey: "w17d-transfer-0001",
      variantId,
      fromLocationId: ctx.locationId,
      toLocationId: ctx.location2Id,
      quantity: 3,
    });
    expect(transfer.status).toBe(201);
    // The destination takes the source's cost: the value moves, nothing to journal.
    expect(await vouchersLike("RETAIL-STK-TRANSFER-%")).toEqual([]);
    const destination = await pool.query(
      `SELECT quantity::text AS q, average_cost::text AS cost FROM retail_variant_inventory WHERE company_id = $1 AND location_id = $2`,
      [ctx.companyId, ctx.location2Id]
    );
    expect(destination.rows[0]).toEqual({ q: "3.000000", cost: "5.000000" });

    shiftId = await openShift(0);
    const sale = await agent.post("/api/pos/retail/sales").send({
      locationId: ctx.locationId,
      shiftId,
      idempotencyKey: "w17d-sale-0001",
      payments: [{ method: "cash", amount: 9, tenderedAmount: 9 }],
      items: [{ variantId, quantity: 1 }],
    });
    expect(sale.status).toBe(201);
    const saleItemId = Number(sale.body.sale.items[0].id);
    const returned = await agent.post(`/api/pos/retail/sales/${sale.body.sale.id}/returns`).send({
      locationId: ctx.locationId,
      shiftId,
      idempotencyKey: "w17d-return-0001",
      items: [{ saleItemId, quantity: 1 }],
    });
    expect(returned.status).toBe(201);
    // The refund journal puts the sale's cost back; the stock came back at that cost: nothing more.
    expect(await vouchersLike("RETAIL-STK-RETURN-%")).toEqual([]);

    expect(await reconciliation()).toMatchObject({ ledger: "90.00", subLedger: "90.00", difference: "0.00" });
    const report = await runAccountingIntegrityDiagnostic(ctx.companyId);
    expect(report.checks.find((check) => check.key === "retail_inventory_ledger_vs_stock")?.status).toBe("pass");
  });
});
