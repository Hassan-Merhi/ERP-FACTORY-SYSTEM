import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  companies,
  inventory,
  locations,
  stockItems,
  stockTransferItems,
  stockTransferVouchers,
  vouchers,
} from "../shared/schema";
import {
  finalizeOptionalStockTransfer,
  reopenStockTransferAsDraft,
  saveStockTransferLifecycle,
} from "../server/services/stockTransferLifecycle";

const PREFIX = `stl-${Date.now()}`;
let companyId = 0;
let sourceAId = 0;
let sourceBId = 0;
let destinationId = 0;
let itemId = 0;
let voucherId = 0;
let transferId = 0;

async function inventoryQty(locationId: number): Promise<number> {
  const [row] = await db
    .select({ quantity: inventory.quantity })
    .from(inventory)
    .where(and(eq(inventory.locationId, locationId), eq(inventory.stockItemId, itemId)));
  return Number(row?.quantity ?? 0);
}

async function cleanup() {
  if (!companyId) return;
  await db.delete(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
  await db.delete(stockTransferVouchers).where(eq(stockTransferVouchers.id, transferId));
  await db.delete(vouchers).where(eq(vouchers.id, voucherId));
  await db.delete(inventory).where(eq(inventory.companyId, companyId));
  await db.execute(sql`DELETE FROM inventory_negative_layers WHERE stock_item_id = ${itemId}`);
  await db.execute(sql`DELETE FROM canonical_stock_movements WHERE stock_item_id = ${itemId}`);
  await db.execute(sql`DELETE FROM canonical_stock_movement_audit WHERE company_id = ${companyId}`);
  await db.execute(sql`DELETE FROM canonical_stock_movement_requests WHERE company_id = ${companyId}`);
  await db.delete(stockItems).where(eq(stockItems.companyId, companyId));
  await db.delete(locations).where(eq(locations.companyId, companyId));
  await db.delete(companies).where(eq(companies.id, companyId));
}

beforeAll(async () => {
  const [company] = await db
    .insert(companies)
    .values({ code: `${PREFIX}-co`, name: `${PREFIX} lifecycle`, baseCurrency: "USD" })
    .returning();
  companyId = company.id;

  const insertedLocations = await db
    .insert(locations)
    .values([
      { companyId, code: `${PREFIX}-a`, name: "Lifecycle Source A" },
      { companyId, code: `${PREFIX}-b`, name: "Lifecycle Source B" },
      { companyId, code: `${PREFIX}-d`, name: "Lifecycle Destination" },
    ])
    .returning();
  sourceAId = insertedLocations[0].id;
  sourceBId = insertedLocations[1].id;
  destinationId = insertedLocations[2].id;

  const [item] = await db
    .insert(stockItems)
    .values({ companyId, code: `${PREFIX}-item`, name: "Lifecycle Bale", uom: "BALE", active: true })
    .returning();
  itemId = item.id;

  await db.insert(inventory).values([
    {
      companyId,
      locationId: sourceAId,
      stockItemId: itemId,
      quantity: "100",
      averageRate: "10",
      totalValue: "1000",
    },
    {
      companyId,
      locationId: sourceBId,
      stockItemId: itemId,
      quantity: "50",
      averageRate: "10",
      totalValue: "500",
    },
    {
      companyId,
      locationId: destinationId,
      stockItemId: itemId,
      quantity: "0",
      averageRate: "0",
      totalValue: "0",
    },
  ]);

  const [voucher] = await db
    .insert(vouchers)
    .values({
      companyId,
      voucherNumber: `${PREFIX}-voucher`,
      voucherType: "Stock Transfer",
      voucherDate: "2026-07-22",
      optional: true,
      totalAmount: "100",
      description: "Lifecycle test draft",
      locationId: sourceAId,
    })
    .returning();
  voucherId = voucher.id;

  const [transfer] = await db
    .insert(stockTransferVouchers)
    .values({
      voucherId,
      sourceLocationId: sourceAId,
      destinationLocationId: destinationId,
      notes: "Lifecycle test draft",
      inventoryApplied: false,
    })
    .returning();
  transferId = transfer.id;

  await db.insert(stockTransferItems).values({
    transferId,
    stockItemId: itemId,
    sourceLocationId: sourceAId,
    quantity: "10",
    rate: "10",
    totalAmount: "100",
  });
});

afterAll(cleanup);

describe("stock transfer optional lifecycle", () => {
  it("totals a line at exact cents: 3 x 1.115 is 3.35, not the float's 3.34", async () => {
    const result = await saveStockTransferLifecycle({
      companyId,
      transferId,
      destinationLocationId: destinationId,
      notes: "Exact line total",
      items: [{ stockItemId: itemId, sourceLocationId: sourceAId, quantity: 3, rate: 1.115 }],
    });

    expect(result.totalAmount).toBe("3.35");
    expect(result.items.map((item) => item.totalAmount)).toEqual(["3.35"]);
    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.id, voucherId));
    expect(voucher.totalAmount).toBe("3.35");
  });

  it("edits a multi-source optional draft without moving inventory", async () => {
    const before = [await inventoryQty(sourceAId), await inventoryQty(sourceBId), await inventoryQty(destinationId)];

    const result = await saveStockTransferLifecycle({
      companyId,
      transferId,
      destinationLocationId: destinationId,
      notes: "Edited draft",
      items: [
        { stockItemId: itemId, sourceLocationId: sourceAId, quantity: 12, rate: 10 },
        { stockItemId: itemId, sourceLocationId: sourceBId, quantity: 8, rate: 10 },
      ],
    });

    expect(result.transition).toBe("draft-edit");
    expect(result.inventoryApplied).toBe(false);
    expect(result.items).toHaveLength(2);
    expect([await inventoryQty(sourceAId), await inventoryQty(sourceBId), await inventoryQty(destinationId)]).toEqual(
      before
    );

    const [transfer] = await db.select().from(stockTransferVouchers).where(eq(stockTransferVouchers.id, transferId));
    expect(transfer.sourceLocationId).toBeNull();
  });

  it("finalizes the draft atomically and applies each source exactly once", async () => {
    const first = await finalizeOptionalStockTransfer(companyId, voucherId);
    expect(first.transition).toBe("post");
    expect(first.inventoryApplied).toBe(true);
    expect(await inventoryQty(sourceAId)).toBe(88);
    expect(await inventoryQty(sourceBId)).toBe(42);
    expect(await inventoryQty(destinationId)).toBe(20);

    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.id, voucherId));
    const [transfer] = await db.select().from(stockTransferVouchers).where(eq(stockTransferVouchers.id, transferId));
    expect(voucher.optional).toBe(false);
    expect(transfer.inventoryApplied).toBe(true);
  });

  it("is idempotent when finalize is called again", async () => {
    const before = [await inventoryQty(sourceAId), await inventoryQty(sourceBId), await inventoryQty(destinationId)];
    const second = await finalizeOptionalStockTransfer(companyId, voucherId);
    expect(second.transition).toBe("no-op");
    expect([await inventoryQty(sourceAId), await inventoryQty(sourceBId), await inventoryQty(destinationId)]).toEqual(
      before
    );
  });

  it("reverses the old posted quantities before applying a posted edit", async () => {
    const result = await saveStockTransferLifecycle({
      companyId,
      transferId,
      destinationLocationId: destinationId,
      notes: "Posted edit",
      items: [{ stockItemId: itemId, sourceLocationId: sourceAId, quantity: 15, rate: 10 }],
    });

    expect(result.transition).toBe("posted-edit");
    expect(await inventoryQty(sourceAId)).toBe(85);
    expect(await inventoryQty(sourceBId)).toBe(50);
    expect(await inventoryQty(destinationId)).toBe(15);
  });

  it("reopens a posted transfer and reverses inventory only once", async () => {
    const first = await reopenStockTransferAsDraft(companyId, voucherId);
    expect(first.transition).toBe("unpost");
    expect(first.inventoryApplied).toBe(false);
    expect(await inventoryQty(sourceAId)).toBe(100);
    expect(await inventoryQty(sourceBId)).toBe(50);
    expect(await inventoryQty(destinationId)).toBe(0);

    const second = await reopenStockTransferAsDraft(companyId, voucherId);
    expect(second.transition).toBe("no-op");
    expect(await inventoryQty(sourceAId)).toBe(100);
    expect(await inventoryQty(destinationId)).toBe(0);

    const repeatedDraftEdit = await saveStockTransferLifecycle({
      companyId,
      transferId,
      destinationLocationId: destinationId,
      notes: "Still draft",
      items: [{ stockItemId: itemId, sourceLocationId: sourceBId, quantity: 9, rate: 10 }],
    });
    expect(repeatedDraftEdit.transition).toBe("draft-edit");
    expect(await inventoryQty(sourceBId)).toBe(50);
    expect(await inventoryQty(destinationId)).toBe(0);
  });

  it("allows finalization into negative source stock when policy permits it", async () => {
    await db
      .update(inventory)
      .set({ quantity: "5", totalValue: "50" })
      .where(and(eq(inventory.locationId, sourceBId), eq(inventory.stockItemId, itemId)));

    const finalized = await finalizeOptionalStockTransfer(companyId, voucherId);
    expect(finalized.transition).toBe("post");
    expect(finalized.inventoryApplied).toBe(true);

    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.id, voucherId));
    const [transfer] = await db.select().from(stockTransferVouchers).where(eq(stockTransferVouchers.id, transferId));
    expect(voucher.optional).toBe(false);
    expect(transfer.inventoryApplied).toBe(true);
    expect(await inventoryQty(sourceBId)).toBe(-4);
    expect(await inventoryQty(destinationId)).toBe(9);
  });
});
