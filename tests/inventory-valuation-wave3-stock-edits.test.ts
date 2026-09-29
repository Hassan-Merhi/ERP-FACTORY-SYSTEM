import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { firstRow, resultRows } from "../server/lib/queryResult";
import { adjustInventory } from "../server/inventoryHelper";
import { createStockAdjustment, createStockTransfer } from "../server/storage/stock-ops/transfers-create";
import { updateStockAdjustment, updateStockTransfer } from "../server/storage/stock-ops/transfers-update";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "invvalw3";
let ctx: TestContext;
let voucherSequence = 0;

type InventorySnapshot = {
  quantity: string | number;
  average_rate: string | number;
  total_value: string | number;
};

type CountRow = { count: string | number };

const inventoryConnection = db as unknown as Parameters<typeof adjustInventory>[0];

async function resetInventory(locationId: number, stockItemId: number): Promise<void> {
  await db.execute(
    sql`DELETE FROM inventory_negative_layers WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}`
  );
  await db.execute(sql`DELETE FROM inventory WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}`);
}

async function seedInventory(
  locationId: number,
  stockItemId: number,
  quantity: number,
  rate: number,
  totalValue: number
): Promise<void> {
  await db.execute(sql`
    INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
    VALUES (${ctx.companyId}, ${locationId}, ${stockItemId}, ${quantity}, ${rate}, ${totalValue}, NOW())
  `);
}

async function readInventory(locationId: number, stockItemId: number): Promise<InventorySnapshot> {
  const result = await db.execute(sql`
    SELECT quantity, average_rate, total_value
    FROM inventory
    WHERE company_id = ${ctx.companyId}
      AND location_id = ${locationId}
      AND stock_item_id = ${stockItemId}
  `);
  const row = firstRow<InventorySnapshot>(result);
  if (!row) throw new Error(`Inventory row missing for location ${locationId}, stock item ${stockItemId}`);
  return row;
}

async function createVoucher(voucherType: string, locationId: number): Promise<number> {
  voucherSequence += 1;
  const voucherNumber = `${TEST_PREFIX}-${Date.now()}-${voucherSequence}`;
  const result = await db.execute(sql`
    INSERT INTO vouchers
      (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
    VALUES
      (${ctx.companyId}, ${locationId}, ${voucherNumber}, ${voucherType}, '2026-09-11', 0, 'USD', false)
    RETURNING id
  `);
  const row = firstRow<{ id: number }>(result);
  if (!row) throw new Error("Failed to create Wave 3 test voucher");
  return row.id;
}

async function countStockAdjustmentVoucherEntries(voucherId: number): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM voucher_entries ve
    JOIN ledger_accounts la ON la.id = ve.ledger_account_id
    WHERE ve.voucher_id = ${voucherId}
      AND la.code IN ('STOCK_ADJUSTMENT', 'PRODUCTION_ADJUSTMENT', 'CONSUMPTION_EXPENSE')
  `);
  return Number(firstRow<CountRow>(result)?.count ?? 0);
}

async function readVoucherTotal(voucherId: number): Promise<number> {
  const result = await db.execute(sql`
    SELECT total_amount
    FROM vouchers
    WHERE id = ${voucherId}
  `);
  return Number(firstRow<{ total_amount: string | number }>(result)?.total_amount ?? 0);
}

async function countStockAdjustmentsForVoucher(voucherId: number): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM stock_adjustment_vouchers
    WHERE voucher_id = ${voucherId}
  `);
  return Number(firstRow<CountRow>(result)?.count ?? 0);
}

function expectSameInventory(before: InventorySnapshot, after: InventorySnapshot): void {
  expect(Number(after.quantity)).toBeCloseTo(Number(before.quantity), 3);
  expect(Number(after.total_value)).toBeCloseTo(Number(before.total_value), 2);
  expect(Number(after.average_rate)).toBeCloseTo(Number(before.average_rate), 2);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

beforeEach(async () => {
  for (const stockItemId of ctx.stockItemIds) {
    await resetInventory(ctx.locationId, stockItemId);
    await resetInventory(ctx.location2Id, stockItemId);
  }
});

describe("Wave 3 exact-value transfer and adjustment edits", () => {
  it("uses the saved consumption value for the voucher header on create and edit", async () => {
    const stockItemId = ctx.stockItemIds[0];
    await seedInventory(ctx.locationId, stockItemId, 100, 10, 1000);

    const voucherId = await createVoucher("Consumption", ctx.locationId);
    const created = await createStockAdjustment(voucherId, ctx.locationId, "Consumption", "original", [
      // Deliberately wrong submitted rate. Consumption must use the locked
      // inventory value and the header must follow the saved line value.
      { stockItemId, quantity: "10.000", rate: "1.00" },
    ]);

    expect(Number(created.items[0].totalAmount)).toBeCloseTo(100, 2);
    expect(await readVoucherTotal(voucherId)).toBeCloseTo(100, 2);

    const updated = await updateStockAdjustment(created.adjustment.id, ctx.locationId, "Consumption", "edited", [
      { stockItemId, quantity: "20.000", rate: "1.00" },
    ]);

    expect(Number(updated.items[0].totalAmount)).toBeCloseTo(200, 2);
    expect(await readVoucherTotal(voucherId)).toBeCloseTo(200, 2);
  });

  it("nets mixed headers from the saved production and consumption values", async () => {
    const productionItemId = ctx.stockItemIds[0];
    const consumptionItemId = ctx.stockItemIds[2];
    await seedInventory(ctx.locationId, consumptionItemId, 100, 10, 1000);

    const voucherId = await createVoucher("Mixed", ctx.locationId);
    const created = await createStockAdjustment(voucherId, ctx.locationId, "Mixed", "mixed totals", [
      { stockItemId: productionItemId, quantity: "2.000", rate: "20.00" },
      // Submitted rate is intentionally stale; saved consumption value resolves
      // from inventory at 10.00, so the authoritative net is 40 - 30 = 10.
      { stockItemId: consumptionItemId, quantity: "-3.000", rate: "1.00" },
    ]);

    const productionLine = created.items.find((item) => item.stockItemId === productionItemId);
    const consumptionLine = created.items.find((item) => item.stockItemId === consumptionItemId);
    expect(Number(productionLine?.totalAmount ?? 0)).toBeCloseTo(40, 2);
    expect(Number(consumptionLine?.totalAmount ?? 0)).toBeCloseTo(30, 2);
    expect(await readVoucherTotal(voucherId)).toBeCloseTo(10, 2);
  });

  it("rolls back stock and adjustment rows when the atomic header write fails", async () => {
    const stockItemId = ctx.stockItemIds[1];
    await seedInventory(ctx.locationId, stockItemId, 100, 10, 1000);
    const before = await readInventory(ctx.locationId, stockItemId);
    const voucherId = await createVoucher("Production", ctx.locationId);

    await expect(
      createStockAdjustment(
        voucherId,
        ctx.locationId,
        "Production",
        "force header failure",
        [{ stockItemId, quantity: "5.000", rate: "20.00" }],
        undefined,
        { currency: "TOOLONG" }
      )
    ).rejects.toThrow();

    const after = await readInventory(ctx.locationId, stockItemId);
    expectSameInventory(before, after);
    expect(await countStockAdjustmentsForVoucher(voucherId)).toBe(0);
    expect(await readVoucherTotal(voucherId)).toBeCloseTo(0, 2);
  });

  it("keeps a production adjustment no-op edit valuation-neutral after later stock changes", async () => {
    const stockItemId = ctx.stockItemIds[0];
    await seedInventory(ctx.locationId, stockItemId, 100, 10, 1000);

    const voucherId = await createVoucher("Production", ctx.locationId);
    const created = await createStockAdjustment(voucherId, ctx.locationId, "Production", "original", [
      { stockItemId, quantity: "10.000", rate: "20.00" },
    ]);

    await adjustInventory(inventoryConnection, ctx.locationId, stockItemId, 10, ctx.companyId, 30);
    const before = await readInventory(ctx.locationId, stockItemId);
    const entriesBefore = await countStockAdjustmentVoucherEntries(voucherId);

    await updateStockAdjustment(created.adjustment.id, ctx.locationId, "Production", "notes changed", [
      { stockItemId, quantity: "10.000", rate: "20.00" },
    ]);

    const after = await readInventory(ctx.locationId, stockItemId);
    const entriesAfter = await countStockAdjustmentVoucherEntries(voucherId);

    expectSameInventory(before, after);
    expect(entriesBefore).toBe(1);
    expect(entriesAfter).toBe(1);
  });

  it("keeps a consumption adjustment no-op edit valuation-neutral after later stock changes", async () => {
    const stockItemId = ctx.stockItemIds[1];
    await seedInventory(ctx.locationId, stockItemId, 100, 10, 1000);

    const voucherId = await createVoucher("Consumption", ctx.locationId);
    const created = await createStockAdjustment(voucherId, ctx.locationId, "Consumption", "original", [
      { stockItemId, quantity: "10.000", rate: "10.00" },
    ]);

    // Later stock arrives at a different cost. Editing the old consumption must
    // not re-cost its historical 10 units at the new blended average.
    await adjustInventory(inventoryConnection, ctx.locationId, stockItemId, 10, ctx.companyId, 20);
    const before = await readInventory(ctx.locationId, stockItemId);
    const entriesBefore = await countStockAdjustmentVoucherEntries(voucherId);

    await updateStockAdjustment(created.adjustment.id, ctx.locationId, "Consumption", "notes changed", [
      { stockItemId, quantity: "10.000", rate: "10.00" },
    ]);

    const after = await readInventory(ctx.locationId, stockItemId);
    const entriesAfter = await countStockAdjustmentVoucherEntries(voucherId);

    expectSameInventory(before, after);
    expect(entriesBefore).toBe(1);
    expect(entriesAfter).toBe(1);
  });

  it("preserves both locations through a no-op stock-transfer edit", async () => {
    const stockItemId = ctx.stockItemIds[2];
    await seedInventory(ctx.locationId, stockItemId, 100, 10, 1000);
    await seedInventory(ctx.location2Id, stockItemId, 50, 20, 1000);

    const voucherId = await createVoucher("Stock Transfer", ctx.locationId);
    const created = await createStockTransfer(voucherId, ctx.location2Id, "original", [
      {
        sourceLocationId: ctx.locationId,
        stockItemId,
        quantity: "10.000",
        rate: "10.00",
      },
    ]);

    // Independent later receipts make both locations' live average costs differ
    // from the historical transfer rate. A no-op edit must still be exact.
    await adjustInventory(inventoryConnection, ctx.locationId, stockItemId, 10, ctx.companyId, 30);
    await adjustInventory(inventoryConnection, ctx.location2Id, stockItemId, 10, ctx.companyId, 5);

    const sourceBefore = await readInventory(ctx.locationId, stockItemId);
    const destinationBefore = await readInventory(ctx.location2Id, stockItemId);

    await updateStockTransfer(created.transfer.id, ctx.location2Id, "notes changed", [
      {
        sourceLocationId: ctx.locationId,
        stockItemId,
        quantity: "10.000",
        rate: "10.00",
      },
    ]);

    const sourceAfter = await readInventory(ctx.locationId, stockItemId);
    const destinationAfter = await readInventory(ctx.location2Id, stockItemId);

    expectSameInventory(sourceBefore, sourceAfter);
    expectSameInventory(destinationBefore, destinationAfter);
  });

  it("records transfer-edit reversal and apply evidence in the canonical journal", async () => {
    const stockItemId = ctx.stockItemIds[0];
    await seedInventory(ctx.locationId, stockItemId, 100, 10, 1000);

    const voucherId = await createVoucher("Stock Transfer", ctx.locationId);
    const created = await createStockTransfer(voucherId, ctx.location2Id, "original", [
      {
        sourceLocationId: ctx.locationId,
        stockItemId,
        quantity: "5.000",
        rate: "10.00",
      },
    ]);

    await updateStockTransfer(created.transfer.id, ctx.location2Id, "edited", [
      {
        sourceLocationId: ctx.locationId,
        stockItemId,
        quantity: "5.000",
        rate: "10.00",
      },
    ]);

    const journalResult = await db.execute(sql`
      SELECT source_type
      FROM canonical_stock_movements
      WHERE company_id = ${ctx.companyId}
        AND stock_item_id = ${stockItemId}
        AND source_id = ${String(voucherId)}
        AND source_type IN ('stock_transfer_edit_reverse', 'stock_transfer_edit_apply')
    `);
    const sourceTypes = resultRows<{ source_type: string }>(journalResult).map((row) => row.source_type);

    expect(sourceTypes).toContain("stock_transfer_edit_reverse");
    expect(sourceTypes).toContain("stock_transfer_edit_apply");
  });
});
