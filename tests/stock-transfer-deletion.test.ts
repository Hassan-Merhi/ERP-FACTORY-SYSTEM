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
  deleteStockTransferVoucher,
  isStockTransferVoucherType,
  shouldReverseStockTransferOnDelete,
  sortStockTransferDeletionItems,
} from "../server/services/stockTransferDeletion";

const PREFIX = `std-${Date.now()}`;
let companyId = 0;
let sourceId = 0;
let destinationId = 0;
let itemId = 0;
let appliedVoucherId = 0;
let draftVoucherId = 0;

async function quantity(locationId: number): Promise<number> {
  const [row] = await db
    .select({ quantity: inventory.quantity })
    .from(inventory)
    .where(and(eq(inventory.locationId, locationId), eq(inventory.stockItemId, itemId)));
  return Number(row?.quantity ?? 0);
}

beforeAll(async () => {
  const [company] = await db
    .insert(companies)
    .values({ code: `${PREFIX}-co`, name: `${PREFIX} deletion`, baseCurrency: "USD" })
    .returning();
  companyId = company.id;

  const insertedLocations = await db
    .insert(locations)
    .values([
      { companyId, code: `${PREFIX}-src`, name: "Deletion Source" },
      { companyId, code: `${PREFIX}-dst`, name: "Deletion Destination" },
    ])
    .returning();
  sourceId = insertedLocations[0].id;
  destinationId = insertedLocations[1].id;

  const [item] = await db
    .insert(stockItems)
    .values({ companyId, code: `${PREFIX}-item`, name: "Deletion Bale", uom: "BALE", active: true })
    .returning();
  itemId = item.id;

  // Represents a posted transfer of 10 units from source to destination.
  await db.insert(inventory).values([
    { companyId, locationId: sourceId, stockItemId: itemId, quantity: "90", averageRate: "5", totalValue: "450" },
    { companyId, locationId: destinationId, stockItemId: itemId, quantity: "10", averageRate: "5", totalValue: "50" },
  ]);

  const [appliedVoucher] = await db
    .insert(vouchers)
    .values({
      companyId,
      voucherNumber: `${PREFIX}-applied`,
      voucherType: "Stock Transfer",
      voucherDate: "2026-07-25",
      optional: false,
      totalAmount: "50",
      locationId: sourceId,
    })
    .returning();
  appliedVoucherId = appliedVoucher.id;

  const [appliedTransfer] = await db
    .insert(stockTransferVouchers)
    .values({
      voucherId: appliedVoucherId,
      sourceLocationId: sourceId,
      destinationLocationId: destinationId,
      inventoryApplied: true,
      notes: "Applied deletion test",
    })
    .returning();
  await db.insert(stockTransferItems).values({
    transferId: appliedTransfer.id,
    stockItemId: itemId,
    sourceLocationId: sourceId,
    quantity: "10",
    rate: "5",
    totalAmount: "50",
  });

  const [draftVoucher] = await db
    .insert(vouchers)
    .values({
      companyId,
      voucherNumber: `${PREFIX}-draft`,
      voucherType: "StockTransfer",
      voucherDate: "2026-07-25",
      optional: true,
      totalAmount: "25",
      locationId: sourceId,
    })
    .returning();
  draftVoucherId = draftVoucher.id;

  const [draftTransfer] = await db
    .insert(stockTransferVouchers)
    .values({
      voucherId: draftVoucherId,
      sourceLocationId: sourceId,
      destinationLocationId: destinationId,
      inventoryApplied: false,
      notes: "Draft deletion test",
    })
    .returning();
  await db.insert(stockTransferItems).values({
    transferId: draftTransfer.id,
    stockItemId: itemId,
    sourceLocationId: sourceId,
    quantity: "5",
    rate: "5",
    totalAmount: "25",
  });
});

afterAll(async () => {
  await db.delete(stockTransferItems).where(eq(stockTransferItems.stockItemId, itemId));
  await db.delete(stockTransferVouchers).where(eq(stockTransferVouchers.voucherId, appliedVoucherId));
  await db.delete(stockTransferVouchers).where(eq(stockTransferVouchers.voucherId, draftVoucherId));
  await db.delete(vouchers).where(eq(vouchers.id, appliedVoucherId));
  await db.delete(vouchers).where(eq(vouchers.id, draftVoucherId));
  await db.delete(inventory).where(eq(inventory.companyId, companyId));
  await db.execute(sql`DELETE FROM canonical_stock_movements WHERE stock_item_id = ${itemId}`);
  await db.execute(sql`DELETE FROM canonical_stock_movement_audit WHERE company_id = ${companyId}`);
  await db.execute(sql`DELETE FROM canonical_stock_movement_requests WHERE company_id = ${companyId}`);
  await db.delete(stockItems).where(eq(stockItems.id, itemId));
  await db.delete(locations).where(eq(locations.companyId, companyId));
  await db.delete(companies).where(eq(companies.id, companyId));
});

describe("stock transfer deletion policy", () => {
  it("recognizes every persisted stock transfer voucher type", () => {
    expect(isStockTransferVoucherType("Stock Transfer")).toBe(true);
    expect(isStockTransferVoucherType("StockTransfer")).toBe(true);
    expect(isStockTransferVoucherType("Transfer")).toBe(true);
    expect(isStockTransferVoucherType("Sales")).toBe(false);
  });

  it("uses inventoryApplied with the legacy non-optional fallback", () => {
    expect(shouldReverseStockTransferOnDelete({ inventoryApplied: true, optional: true })).toBe(true);
    expect(shouldReverseStockTransferOnDelete({ inventoryApplied: false, optional: false })).toBe(true);
    expect(shouldReverseStockTransferOnDelete({ inventoryApplied: false, optional: true })).toBe(false);
  });

  it("orders item locks by source and item", () => {
    expect(
      sortStockTransferDeletionItems([
        { sourceLocationId: 2, stockItemId: 1 },
        { sourceLocationId: 1, stockItemId: 3 },
        { sourceLocationId: 1, stockItemId: 2 },
      ])
    ).toEqual([
      { sourceLocationId: 1, stockItemId: 2 },
      { sourceLocationId: 1, stockItemId: 3 },
      { sourceLocationId: 2, stockItemId: 1 },
    ]);
  });
});

describe("stock transfer deletion transaction", () => {
  it("reverses an applied transfer exactly once", async () => {
    const first = await deleteStockTransferVoucher({ companyId, voucherId: appliedVoucherId });
    expect(first.replayed).toBe(false);
    expect(first.reversedInventory).toBe(true);
    expect(await quantity(sourceId)).toBe(100);
    expect(await quantity(destinationId)).toBe(0);

    const [deletedVoucher] = await db.select().from(vouchers).where(eq(vouchers.id, appliedVoucherId));
    expect(deletedVoucher.deletedAt).not.toBeNull();
    expect(
      await db.select().from(stockTransferVouchers).where(eq(stockTransferVouchers.voucherId, appliedVoucherId))
    ).toHaveLength(0);

    const replay = await deleteStockTransferVoucher({ companyId, voucherId: appliedVoucherId });
    expect(replay.replayed).toBe(true);
    expect(replay.reversedInventory).toBe(false);
    expect(await quantity(sourceId)).toBe(100);
    expect(await quantity(destinationId)).toBe(0);
  });

  it("deletes an unapplied optional draft without moving inventory", async () => {
    const before = [await quantity(sourceId), await quantity(destinationId)];
    const result = await deleteStockTransferVoucher({ companyId, voucherId: draftVoucherId });
    expect(result.replayed).toBe(false);
    expect(result.reversedInventory).toBe(false);
    expect([await quantity(sourceId), await quantity(destinationId)]).toEqual(before);

    const [deletedVoucher] = await db.select().from(vouchers).where(eq(vouchers.id, draftVoucherId));
    expect(deletedVoucher.deletedAt).not.toBeNull();
    const [retainedTransfer] = await db
      .select()
      .from(stockTransferVouchers)
      .where(eq(stockTransferVouchers.voucherId, draftVoucherId));
    expect(retainedTransfer).toBeDefined();
    expect(retainedTransfer.inventoryApplied).toBe(false);
    expect(
      await db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, retainedTransfer.id))
    ).toHaveLength(1);

    const replay = await deleteStockTransferVoucher({ companyId, voucherId: draftVoucherId });
    expect(replay.replayed).toBe(true);
    expect(replay.reversedInventory).toBe(false);
    expect([await quantity(sourceId), await quantity(destinationId)]).toEqual(before);
  });
});
