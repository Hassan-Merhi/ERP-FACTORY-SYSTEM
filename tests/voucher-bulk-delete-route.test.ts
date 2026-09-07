/**
 * Behavioural coverage for `POST /api/vouchers/bulk-delete`
 * (`server/routes/voucher-entries/bulk-delete.ts`).
 *
 * This endpoint soft-deletes a batch of vouchers and, for each one, reverses
 * whatever that voucher did to inventory. It had no test, which matters more
 * here than for most routes: it is a loop that swallows per-voucher failures
 * into an `errors` array and still answers 200, so a reversal that silently
 * stopped working would look identical to one that worked.
 *
 * The properties worth holding:
 *
 *   - **Each voucher type is reversed the right way round.** A stock transfer
 *     returns stock to its source and removes it from its destination; a
 *     Production adjustment subtracts what it added; a Consumption adjustment
 *     adds back what it removed; a Credit Note subtracts and a Debit Note adds;
 *     a sale returns the sold quantity. Getting a sign wrong here doubles the
 *     error instead of cancelling it.
 *   - **`optional` vouchers are provisional and never touched inventory,** so
 *     deleting one must not "reverse" anything.
 *   - **Deletion is soft.** The voucher row stays with `deleted_at` set, so the
 *     audit trail survives.
 *   - **A bad voucher in the batch does not take the good ones with it.** Each
 *     failure is reported in `errors` while the rest still delete.
 *   - **The batch is Admin-only and company-scoped.** Another tenant's voucher
 *     is refused by id without being touched.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "vbulkdel";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let seq = 0;

async function setRole(role: string): Promise<void> {
  await db.update(schema.userCompanyRoles).set({ role }).where(eq(schema.userCompanyRoles.userId, ctx.userId));
  const res = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(res.status).toBe(200);
}

async function makeVoucher(
  voucherType: string,
  overrides: Partial<typeof schema.vouchers.$inferInsert> = {}
): Promise<typeof schema.vouchers.$inferSelect> {
  seq += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherType,
      voucherNumber: `${TEST_PREFIX}-${seq}`,
      voucherDate: "2026-01-05",
      description: `${voucherType} under test`,
      totalAmount: "100.00",
      currency: "USD",
      ...overrides,
    })
    .returning();
  return voucher;
}

async function bulkDelete(voucherIds: Array<number | string>) {
  return agent.post("/api/vouchers/bulk-delete").send({ voucherIds });
}

async function inventoryQty(locationId: number, stockItemId: number): Promise<number> {
  const result = await pool.query<{ quantity: string }>(
    `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, locationId, stockItemId]
  );
  return result.rows[0] ? Number(result.rows[0].quantity) : 0;
}

async function deletedAt(voucherId: number): Promise<Date | null> {
  const [row] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId));
  return row?.deletedAt ?? null;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 90000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

beforeEach(async () => {
  await setRole("Admin");
});

describe("POST /api/vouchers/bulk-delete request validation", () => {
  it("requires at least one voucher id", async () => {
    const empty = await bulkDelete([]);
    expect(empty.status).toBe(400);
    expect(empty.body.message).toMatch(/At least one voucher ID required/i);

    const missing = await agent.post("/api/vouchers/bulk-delete").send({});
    expect(missing.status).toBe(400);
  });

  it("is refused for a non-Admin role", async () => {
    const voucher = await makeVoucher("Journal");
    await setRole("Manager");

    const response = await bulkDelete([voucher.id]);
    expect(response.status).toBe(403);
    expect(await deletedAt(voucher.id)).toBeNull();
  });
});

describe("POST /api/vouchers/bulk-delete per-voucher outcomes", () => {
  it("soft-deletes a plain journal voucher and records it in the audit log", async () => {
    const voucher = await makeVoucher("Journal");

    const response = await bulkDelete([voucher.id]);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ deletedCount: 1 });
    expect(response.body.errors).toBeUndefined();

    // Soft delete: the row survives with deleted_at set.
    expect(await deletedAt(voucher.id)).not.toBeNull();

    const audit = await pool.query<{ action: string; record_identifier: string }>(
      `SELECT action, record_identifier FROM audit_log
        WHERE company_id = $1 AND table_name = 'vouchers' AND record_id = $2`,
      [ctx.companyId, voucher.id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe("delete");
    expect(audit.rows[0].record_identifier).toBe(voucher.voucherNumber);
  });

  it("accepts numeric ids given as strings", async () => {
    const voucher = await makeVoucher("Journal");

    const response = await bulkDelete([String(voucher.id)]);

    expect(response.status).toBe(200);
    expect(response.body.deletedCount).toBe(1);
    expect(await deletedAt(voucher.id)).not.toBeNull();
  });

  it("reports each bad id without abandoning the good ones", async () => {
    const good = await makeVoucher("Journal");
    const migrated = await makeVoucher("Journal", { voucherNumber: `MIG-${TEST_PREFIX}-${seq + 1}` });

    const [foreignCompany] = await db
      .insert(schema.companies)
      .values({
        code: `${TEST_PREFIX.slice(0, 4).toUpperCase()}FGN`,
        name: `${TEST_PREFIX}_ForeignCompany`,
        baseCurrency: "USD",
      })
      .returning();
    const [foreignVoucher] = await db
      .insert(schema.vouchers)
      .values({
        companyId: foreignCompany.id,
        voucherType: "Journal",
        voucherNumber: `${TEST_PREFIX}-FGN`,
        voucherDate: "2026-01-05",
        totalAmount: "10.00",
        currency: "USD",
      })
      .returning();

    try {
      const response = await bulkDelete([good.id, 99999999, "not-a-number", migrated.id, foreignVoucher.id]);

      expect(response.status).toBe(200);
      expect(response.body.deletedCount).toBe(1);
      const errors: string[] = response.body.errors;
      expect(errors).toHaveLength(4);
      expect(errors.some((e) => e.includes("99999999") && /not found/i.test(e))).toBe(true);
      expect(errors.some((e) => /Invalid voucher ID: not-a-number/i.test(e))).toBe(true);
      expect(errors.some((e) => e.includes(String(migrated.id)) && /read-only|migration/i.test(e))).toBe(true);
      expect(
        errors.some((e) => e.includes(String(foreignVoucher.id)) && /does not belong to current company/i.test(e))
      ).toBe(true);

      // Only the good one went; the blocked and foreign rows are untouched.
      expect(await deletedAt(good.id)).not.toBeNull();
      expect(await deletedAt(migrated.id)).toBeNull();
      expect(await deletedAt(foreignVoucher.id)).toBeNull();
    } finally {
      await db.delete(schema.vouchers).where(eq(schema.vouchers.id, foreignVoucher.id));
      await db.delete(schema.companies).where(eq(schema.companies.id, foreignCompany.id));
    }
  });
});

describe("POST /api/vouchers/bulk-delete inventory reversal", () => {
  it("refuses a batch containing a stock transfer and moves nothing", async () => {
    // `centralStockTransferDeleteRoute` intercepts the batch before the loop:
    // transfer reversal has to take a per-voucher lock to stay replay-safe, so
    // it is only available through the single-voucher delete path.
    const item = ctx.stockItemIds[0];
    const journal = await makeVoucher("Journal");
    const voucher = await makeVoucher("Stock Transfer");
    const [transfer] = await db
      .insert(schema.stockTransferVouchers)
      .values({
        voucherId: voucher.id,
        sourceLocationId: ctx.locationId,
        destinationLocationId: ctx.location2Id,
        inventoryApplied: true,
      })
      .returning();
    await db.insert(schema.stockTransferItems).values({
      transferId: transfer.id,
      stockItemId: item,
      sourceLocationId: ctx.locationId,
      quantity: "7.000",
      rate: "9.00",
      totalAmount: "63.00",
    });

    const sourceBefore = await inventoryQty(ctx.locationId, item);
    const destinationBefore = await inventoryQty(ctx.location2Id, item);

    const response = await bulkDelete([journal.id, voucher.id]);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("STOCK_TRANSFER_BULK_DELETE_REQUIRES_SINGLE");
    expect(response.body.stockTransferVoucherIds).toContain(voucher.id);

    // The whole batch is refused, so even the plain journal in it survives.
    expect(await deletedAt(journal.id)).toBeNull();
    expect(await deletedAt(voucher.id)).toBeNull();
    expect(await inventoryQty(ctx.locationId, item)).toBeCloseTo(sourceBefore, 3);
    expect(await inventoryQty(ctx.location2Id, item)).toBeCloseTo(destinationBefore, 3);

    // The transfer document is left intact for the single-delete path.
    const remaining = await db
      .select()
      .from(schema.stockTransferVouchers)
      .where(eq(schema.stockTransferVouchers.voucherId, voucher.id));
    expect(remaining).toHaveLength(1);
  });

  it("subtracts what a Production adjustment added and adds back what a Consumption adjustment removed", async () => {
    const item = ctx.stockItemIds[1];

    const production = await makeVoucher("Production");
    const [productionAdj] = await db
      .insert(schema.stockAdjustmentVouchers)
      .values({ voucherId: production.id, locationId: ctx.locationId, adjustmentType: "Production" })
      .returning();
    await db.insert(schema.stockAdjustmentItems).values({
      adjustmentId: productionAdj.id,
      stockItemId: item,
      quantity: "6.000",
      rate: "4.00",
      totalAmount: "24.00",
    });

    const consumption = await makeVoucher("Consumption");
    const [consumptionAdj] = await db
      .insert(schema.stockAdjustmentVouchers)
      .values({ voucherId: consumption.id, locationId: ctx.locationId, adjustmentType: "Consumption" })
      .returning();
    await db.insert(schema.stockAdjustmentItems).values({
      adjustmentId: consumptionAdj.id,
      stockItemId: item,
      quantity: "2.000",
      rate: "4.00",
      totalAmount: "8.00",
    });

    const before = await inventoryQty(ctx.locationId, item);

    const response = await bulkDelete([production.id, consumption.id]);
    expect(response.body.deletedCount).toBe(2);

    // Production reversal is -6, consumption reversal is +2 → net -4.
    expect(await inventoryQty(ctx.locationId, item)).toBeCloseTo(before - 4, 3);

    for (const adjustmentId of [productionAdj.id, consumptionAdj.id]) {
      const items = await db
        .select()
        .from(schema.stockAdjustmentItems)
        .where(eq(schema.stockAdjustmentItems.adjustmentId, adjustmentId));
      expect(items).toHaveLength(0);
    }
  });

  it("reverses an adjustment created through the PATCH route, whose type is stored lowercased", async () => {
    // Regression: `createStockAdjustment` stores "Production" while
    // PATCH /api/vouchers/:id/adjustment stores "production". Bulk delete used to
    // compare case-sensitively, so a real Production voucher created through the
    // route was classified as consumption and had its quantity ADDED back on
    // delete — inflating stock by twice the adjusted quantity instead of
    // cancelling it. Seeding through the route is what makes this test bite.
    const item = ctx.stockItemIds[1];
    const voucher = await makeVoucher("Production");
    const before = await inventoryQty(ctx.locationId, item);

    const created = await agent.patch(`/api/vouchers/${voucher.id}/adjustment`).send({
      locationId: ctx.locationId,
      description: "Produced through the route",
      items: [{ stockItemId: item, quantity: "6", rate: "5" }],
    });
    expect(created.status).toBe(200);
    expect(await inventoryQty(ctx.locationId, item)).toBeCloseTo(before + 6, 3);

    // The stored casing really is lowercase — the premise of this regression.
    const header = await pool.query<{ adjustment_type: string }>(
      `SELECT adjustment_type FROM stock_adjustment_vouchers WHERE voucher_id = $1`,
      [voucher.id]
    );
    expect(header.rows[0].adjustment_type).toBe("production");

    expect((await bulkDelete([voucher.id])).body.deletedCount).toBe(1);

    // Back to exactly where we started, not 12 above it.
    expect(await inventoryQty(ctx.locationId, item)).toBeCloseTo(before, 3);
  });

  it("reverses a lowercase Mixed adjustment per line sign", async () => {
    const positive = ctx.stockItemIds[0];
    const negative = ctx.stockItemIds[1];
    const voucher = await makeVoucher("Mixed");
    const positiveBefore = await inventoryQty(ctx.locationId, positive);
    const negativeBefore = await inventoryQty(ctx.locationId, negative);

    const created = await agent.patch(`/api/vouchers/${voucher.id}/adjustment`).send({
      locationId: ctx.locationId,
      items: [
        { stockItemId: positive, quantity: "5", rate: "3" },
        { stockItemId: negative, quantity: "-2", rate: "3" },
      ],
    });
    expect(created.status).toBe(200);

    const header = await pool.query<{ adjustment_type: string }>(
      `SELECT adjustment_type FROM stock_adjustment_vouchers WHERE voucher_id = $1`,
      [voucher.id]
    );
    expect(header.rows[0].adjustment_type).toBe("mixed");

    expect((await bulkDelete([voucher.id])).body.deletedCount).toBe(1);

    // Each line is reversed according to its own sign, so both return to baseline.
    expect(await inventoryQty(ctx.locationId, positive)).toBeCloseTo(positiveBefore, 3);
    expect(await inventoryQty(ctx.locationId, negative)).toBeCloseTo(negativeBefore, 3);
  });

  it("leaves inventory alone for an optional adjustment voucher", async () => {
    const item = ctx.stockItemIds[1];
    const voucher = await makeVoucher("Production", { optional: true });
    const [adjustment] = await db
      .insert(schema.stockAdjustmentVouchers)
      .values({ voucherId: voucher.id, locationId: ctx.locationId, adjustmentType: "Production" })
      .returning();
    await db.insert(schema.stockAdjustmentItems).values({
      adjustmentId: adjustment.id,
      stockItemId: item,
      quantity: "3.000",
      rate: "4.00",
      totalAmount: "12.00",
    });

    const before = await inventoryQty(ctx.locationId, item);
    expect((await bulkDelete([voucher.id])).body.deletedCount).toBe(1);
    expect(await inventoryQty(ctx.locationId, item)).toBeCloseTo(before, 3);
  });

  it("returns sold quantity to inventory and clears the sale lines", async () => {
    const item = ctx.stockItemIds[2];
    const voucher = await makeVoucher("Sales", { locationId: ctx.locationId });
    await db.insert(schema.salesItems).values({
      voucherId: voucher.id,
      stockItemId: item,
      quantity: "8.000",
      sellingPrice: "20.000000",
      costPrice: "12.00",
      totalSales: "160.00",
      totalCost: "96.00",
      profit: "64.00",
    });

    const before = await inventoryQty(ctx.locationId, item);

    expect((await bulkDelete([voucher.id])).body.deletedCount).toBe(1);

    expect(await inventoryQty(ctx.locationId, item)).toBeCloseTo(before + 8, 3);
    const remaining = await db.select().from(schema.salesItems).where(eq(schema.salesItems.voucherId, voucher.id));
    expect(remaining).toHaveLength(0);
  });

  it("subtracts a Credit Note's quantity and adds a Debit Note's back", async () => {
    const item = ctx.stockItemIds[2];

    const creditNote = await makeVoucher("Credit Note");
    await db.insert(schema.creditNoteItems).values({
      voucherId: creditNote.id,
      stockItemId: item,
      locationId: ctx.locationId,
      quantity: "5.000",
      rate: "10.00",
      inventoryCost: "6.00",
      totalValue: "50.00",
    });

    const debitNote = await makeVoucher("Debit Note");
    await db.insert(schema.creditNoteItems).values({
      voucherId: debitNote.id,
      stockItemId: item,
      locationId: ctx.locationId,
      quantity: "2.000",
      rate: "10.00",
      inventoryCost: "6.00",
      totalValue: "20.00",
    });

    const before = await inventoryQty(ctx.locationId, item);

    const response = await bulkDelete([creditNote.id, debitNote.id]);
    expect(response.body.deletedCount).toBe(2);

    // Credit note reversal is -5, debit note reversal is +2 → net -3.
    expect(await inventoryQty(ctx.locationId, item)).toBeCloseTo(before - 3, 3);

    for (const voucherId of [creditNote.id, debitNote.id]) {
      const remaining = await db
        .select()
        .from(schema.creditNoteItems)
        .where(eq(schema.creditNoteItems.voucherId, voucherId));
      expect(remaining).toHaveLength(0);
    }
  });
});
