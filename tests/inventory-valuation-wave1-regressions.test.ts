import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import { adjustInventory } from "../server/inventoryHelper";
import { reverseOriginalSaleInventory } from "../server/services/pos/edit/reverseOriginalSaleInventory";
import { storage } from "../server/storage";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "invvalw1";
const ITEM_RATE = 66.65;
const ITEM_QTY = 18;
const EDIT_QTY = 5;

let ctx: TestContext;

async function setInventoryState(stockItemId: number, quantity: number, averageRate: number): Promise<void> {
  const totalValue = quantity * averageRate;
  const [existing] = await db
    .select({ id: schema.inventory.id })
    .from(schema.inventory)
    .where(and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, stockItemId)))
    .limit(1);

  if (existing) {
    await db
      .update(schema.inventory)
      .set({
        quantity: quantity.toFixed(3),
        averageRate: averageRate.toFixed(2),
        totalValue: totalValue.toFixed(2),
      })
      .where(eq(schema.inventory.id, existing.id));
  } else {
    await db.insert(schema.inventory).values({
      companyId: ctx.companyId,
      locationId: ctx.locationId,
      stockItemId,
      quantity: quantity.toFixed(3),
      averageRate: averageRate.toFixed(2),
      totalValue: totalValue.toFixed(2),
    });
  }
}

async function clearNegativeLayers(stockItemId: number): Promise<void> {
  await db.execute(sql`
    DELETE FROM inventory_negative_layers
    WHERE company_id = ${ctx.companyId}
      AND location_id = ${ctx.locationId}
      AND stock_item_id = ${stockItemId}
  `);
}

async function addNegativeLayer(stockItemId: number, qty: number, provisionalRate: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO inventory_negative_layers
      (company_id, location_id, stock_item_id, qty, provisional_rate, source_voucher_type, source_voucher_id)
    VALUES
      (${ctx.companyId}, ${ctx.locationId}, ${stockItemId}, ${qty.toFixed(3)}, ${provisionalRate.toFixed(4)},
       'wave1-regression-fixture', NULL)
  `);
}

async function readInventoryState(stockItemId: number) {
  const [row] = await db
    .select({
      quantity: schema.inventory.quantity,
      averageRate: schema.inventory.averageRate,
      totalValue: schema.inventory.totalValue,
    })
    .from(schema.inventory)
    .where(and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, stockItemId)))
    .limit(1);

  if (!row) throw new Error(`Missing inventory fixture for stock item ${stockItemId}`);

  const layersResult = await db.execute(sql`
    SELECT COALESCE(SUM(qty), 0)::numeric AS qty
    FROM inventory_negative_layers
    WHERE company_id = ${ctx.companyId}
      AND location_id = ${ctx.locationId}
      AND stock_item_id = ${stockItemId}
  `);
  const layerRows = "rows" in layersResult ? layersResult.rows : layersResult;
  const layerQty = Number((layerRows[0] as { qty?: string | number } | undefined)?.qty ?? 0);

  return {
    quantity: Number(row.quantity),
    averageRate: Number(row.averageRate),
    totalValue: Number(row.totalValue),
    negativeLayerQty: layerQty,
  };
}

async function simulateUnchangedPosEdit(stockItemId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await reverseOriginalSaleInventory(
      tx,
      {
        id: 910_000 + stockItemId,
        locationId: ctx.locationId,
        companyId: ctx.companyId,
      },
      [
        {
          id: 920_000 + stockItemId,
          stockItemId,
          quantity: EDIT_QTY.toFixed(3),
          costPrice: ITEM_RATE.toFixed(2),
        },
      ]
    );

    await adjustInventory(tx, ctx.locationId, stockItemId, -EDIT_QTY, ctx.companyId);
  });
}

async function resetPrimaryItem(): Promise<void> {
  const stockItemId = ctx.stockItemIds[0];
  await clearNegativeLayers(stockItemId);
  await setInventoryState(stockItemId, ITEM_QTY, ITEM_RATE);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

beforeEach(async () => {
  await resetPrimaryItem();
});

describe("Wave 1 inventory valuation regression locks", () => {
  it("keeps an unchanged POS edit valuation-neutral when no shortage layer exists", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const before = await readInventoryState(stockItemId);

    await simulateUnchangedPosEdit(stockItemId);

    expect(await readInventoryState(stockItemId)).toEqual(before);
  });

  it.fails("does not consume an unrelated negative layer or collapse cost during an unchanged POS edit", async () => {
    const stockItemId = ctx.stockItemIds[0];
    await addNegativeLayer(stockItemId, EDIT_QTY, 60.47);
    const before = await readInventoryState(stockItemId);

    await simulateUnchangedPosEdit(stockItemId);

    const after = await readInventoryState(stockItemId);
    expect(after).toEqual(before);
  });

  it.fails("remains valuation-neutral across repeated unchanged POS edits", async () => {
    const stockItemId = ctx.stockItemIds[0];
    await addNegativeLayer(stockItemId, EDIT_QTY * 2, 60.47);
    const baseline = await readInventoryState(stockItemId);

    await simulateUnchangedPosEdit(stockItemId);
    const afterFirstEdit = await readInventoryState(stockItemId);
    await simulateUnchangedPosEdit(stockItemId);
    const afterSecondEdit = await readInventoryState(stockItemId);

    expect(afterFirstEdit).toEqual(baseline);
    expect(afterSecondEdit).toEqual(baseline);
  });

  it.fails("keeps current inventory unchanged when an old production adjustment is saved without changes", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const currentRate = 68.02;
    await setInventoryState(stockItemId, ITEM_QTY, currentRate);
    const before = await readInventoryState(stockItemId);

    const [voucher] = await db
      .insert(schema.vouchers)
      .values({
        companyId: ctx.companyId,
        locationId: ctx.locationId,
        voucherNumber: `${TEST_PREFIX}-ADJ-${Date.now()}-${stockItemId}`,
        voucherType: "Production",
        voucherDate: new Date().toISOString().slice(0, 10),
        description: "Wave 1 unchanged historical adjustment regression",
        totalAmount: ITEM_RATE.toFixed(2),
        currency: "USD",
        optional: false,
        sourceModule: "ERP",
      })
      .returning();

    const [adjustment] = await db
      .insert(schema.stockAdjustmentVouchers)
      .values({
        voucherId: voucher.id,
        locationId: ctx.locationId,
        adjustmentType: "Production",
        notes: "Wave 1 fixture",
      })
      .returning();

    await db.insert(schema.stockAdjustmentItems).values({
      adjustmentId: adjustment.id,
      stockItemId,
      quantity: "1.000",
      rate: ITEM_RATE.toFixed(2),
      totalAmount: ITEM_RATE.toFixed(2),
    });

    await storage.updateStockAdjustment(adjustment.id, ctx.locationId, "Production", "Wave 1 fixture", [
      {
        stockItemId,
        quantity: "1.000",
        rate: ITEM_RATE.toFixed(2),
      },
    ]);

    expect(await readInventoryState(stockItemId)).toEqual(before);
  });

  it.fails("does not hard-force live current-year inventory into December", () => {
    const source = readFileSync(resolve(process.cwd(), "server/routes/stock-summary-location/monthly-summary.ts"), "utf8");

    expect(source).not.toMatch(/monthlyData\s*\[\s*11\s*\]\.closingQty\s*=/);
    expect(source).not.toMatch(/monthlyData\s*\[\s*11\s*\]\.closingValue\s*=/);
    expect(source).toMatch(/totalValue\s*:\s*inventory\.totalValue/);
  });

  it("keeps the valuation audit executable tenant-scoped and read-only", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts/audit-inventory-valuation-drift.mjs"), "utf8");

    expect(source).toContain("BEGIN READ ONLY");
    expect(source).toContain("app.current_company_id");
    expect(source).toContain("app.company_scope_maintenance");
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
  });
});