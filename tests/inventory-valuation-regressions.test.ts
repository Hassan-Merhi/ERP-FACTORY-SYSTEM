import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { adjustInventory } from "../server/inventoryHelper";
import { reverseOriginalSaleInventory } from "../server/services/pos/edit/reverseOriginalSaleInventory";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "invvalreg";
let ctx: TestContext;

async function resetInventory(locationId: number, stockItemId: number): Promise<void> {
  await db.execute(
    sql`DELETE FROM inventory_negative_layers WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}`
  );
  await db.execute(sql`DELETE FROM inventory WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}`);
}

async function readInventory(locationId: number, stockItemId: number) {
  const inv: any = await db.execute(sql`
    SELECT quantity, average_rate, total_value
    FROM inventory
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
  `);
  const layers: any = await db.execute(sql`
    SELECT qty, provisional_rate, source_voucher_type, source_voucher_id
    FROM inventory_negative_layers
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
    ORDER BY id
  `);
  return {
    inventory: (inv.rows ?? inv)[0],
    layers: layers.rows ?? layers,
  };
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
  }
});

describe("inventory valuation regression guards", () => {
  it("POS edit reversal must not consume an unrelated negative layer or change the live cost basis", async () => {
    const stockItemId = ctx.stockItemIds[0];

    // Mirrors the production failure mode observed for SH.MIX3:
    // positive live stock at its normal cost, plus an older unrelated shortage layer.
    await db.execute(sql`
      INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
      VALUES (${ctx.companyId}, ${ctx.locationId}, ${stockItemId}, 16, 66.65, 1066.40, NOW())
    `);
    await db.execute(sql`
      INSERT INTO inventory_negative_layers
        (company_id, location_id, stock_item_id, qty, provisional_rate, source_voucher_type, source_voucher_id)
      VALUES
        (${ctx.companyId}, ${ctx.locationId}, ${stockItemId}, 5, 60.47, 'legacy-shortage', 999001)
    `);

    await reverseOriginalSaleInventory(
      db as any,
      { id: 700001, companyId: ctx.companyId, locationId: ctx.locationId },
      [{ id: 800001, stockItemId, quantity: "5", costPrice: "66.65" }]
    );

    const state = await readInventory(ctx.locationId, stockItemId);

    // Reversing an already-issued POS line restores quantity at the current live
    // cost basis. It must not run receipt settlement against unrelated negative
    // layers, because that silently destroys positive-stock valuation.
    expect(Number(state.inventory.quantity)).toBe(21);
    expect(Number(state.inventory.total_value)).toBeCloseTo(1399.65, 2);
    expect(Number(state.inventory.average_rate)).toBeCloseTo(66.65, 2);

    expect(state.layers).toHaveLength(1);
    expect(Number(state.layers[0].qty)).toBe(5);
    expect(Number(state.layers[0].provisional_rate)).toBeCloseTo(60.47, 4);
    expect(state.layers[0].source_voucher_type).toBe("legacy-shortage");
  });

  it("repeating a no-op POS edit must be valuation-neutral", async () => {
    const stockItemId = ctx.stockItemIds[1];
    await db.execute(sql`
      INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
      VALUES (${ctx.companyId}, ${ctx.locationId}, ${stockItemId}, 16, 66.65, 1066.40, NOW())
    `);
    await db.execute(sql`
      INSERT INTO inventory_negative_layers
        (company_id, location_id, stock_item_id, qty, provisional_rate, source_voucher_type, source_voucher_id)
      VALUES
        (${ctx.companyId}, ${ctx.locationId}, ${stockItemId}, 7, 60.47, 'legacy-shortage', 999002)
    `);

    const saleLine = { id: 800002, stockItemId, quantity: "7", costPrice: "66.65" };
    const voucher = { id: 700002, companyId: ctx.companyId, locationId: ctx.locationId };

    // Reverse/re-issue cycle, twice. A real no-op edit rebuilds the sale after this
    // reversal; we emulate that issue with the same inventory footprint and repeat.
    for (let i = 0; i < 2; i += 1) {
      await reverseOriginalSaleInventory(db as any, voucher, [saleLine]);
      await adjustInventory(db as any, ctx.locationId, stockItemId, -7, ctx.companyId, undefined, "pos-sale", voucher.id);
    }

    const state = await readInventory(ctx.locationId, stockItemId);
    expect(Number(state.inventory.quantity)).toBe(16);
    expect(Number(state.inventory.total_value)).toBeCloseTo(1066.4, 2);
    expect(Number(state.inventory.average_rate)).toBeCloseTo(66.65, 2);
    expect(state.layers).toHaveLength(1);
    expect(Number(state.layers[0].qty)).toBe(7);
    expect(state.layers[0].source_voucher_type).toBe("legacy-shortage");
  });

  it("POS edit reversal releases only shortage layers attributed to that sale", async () => {
    const stockItemId = ctx.stockItemIds[2];
    const voucher = { id: 700003, companyId: ctx.companyId, locationId: ctx.locationId };
    const saleLine = { id: 800003, stockItemId, quantity: "5", costPrice: "66.65" };

    await db.execute(sql`
      INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value, last_updated)
      VALUES (${ctx.companyId}, ${ctx.locationId}, ${stockItemId}, -3, 66.65, 0, NOW())
    `);
    await db.execute(sql`
      INSERT INTO inventory_negative_layers
        (company_id, location_id, stock_item_id, qty, provisional_rate, source_voucher_type, source_voucher_id)
      VALUES
        (${ctx.companyId}, ${ctx.locationId}, ${stockItemId}, 3, 66.65, 'pos-sale', ${voucher.id})
    `);

    await reverseOriginalSaleInventory(db as any, voucher, [saleLine]);

    let state = await readInventory(ctx.locationId, stockItemId);
    expect(Number(state.inventory.quantity)).toBe(2);
    expect(Number(state.inventory.total_value)).toBeCloseTo(133.3, 2);
    expect(Number(state.inventory.average_rate)).toBeCloseTo(66.65, 2);
    expect(state.layers).toHaveLength(0);

    await adjustInventory(db as any, ctx.locationId, stockItemId, -5, ctx.companyId, undefined, "pos-sale", voucher.id);

    state = await readInventory(ctx.locationId, stockItemId);
    expect(Number(state.inventory.quantity)).toBe(-3);
    expect(Number(state.inventory.total_value)).toBe(0);
    expect(Number(state.inventory.average_rate)).toBeCloseTo(66.65, 2);
    expect(state.layers).toHaveLength(1);
    expect(Number(state.layers[0].qty)).toBe(3);
    expect(state.layers[0].source_voucher_type).toBe("pos-sale");
    expect(Number(state.layers[0].source_voucher_id)).toBe(voucher.id);
  });
});
