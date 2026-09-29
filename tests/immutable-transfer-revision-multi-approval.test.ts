import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  companies,
  inventory,
  locations,
  stockItems,
  stockTransferItems,
  stockTransferRevisionItems,
  stockTransferRevisions,
  stockTransferVouchers,
  vouchers,
} from "../shared/schema";
import {
  approveImmutableStockTransferRevision,
  createImmutableStockTransferRevision,
} from "../server/services/immutableStockTransferRevisionLifecycle";

const PREFIX = `immutable-multi-approval-${Date.now()}`;
let companyId = 0;
let sourceAId = 0;
let sourceBId = 0;
let destinationId = 0;
let itemAId = 0;
let itemBId = 0;
let voucherId = 0;
let transferId = 0;

async function inventoryQty(locationId: number, stockItemId: number): Promise<number> {
  const [row] = await db
    .select({ quantity: inventory.quantity })
    .from(inventory)
    .where(
      and(
        eq(inventory.companyId, companyId),
        eq(inventory.locationId, locationId),
        eq(inventory.stockItemId, stockItemId)
      )
    );
  return Number(row?.quantity ?? 0);
}

async function transferQty(stockItemId: number, sourceLocationId: number): Promise<number> {
  const [row] = await db
    .select({ quantity: stockTransferItems.quantity })
    .from(stockTransferItems)
    .where(
      and(
        eq(stockTransferItems.transferId, transferId),
        eq(stockTransferItems.stockItemId, stockItemId),
        eq(stockTransferItems.sourceLocationId, sourceLocationId)
      )
    );
  return Number(row?.quantity ?? 0);
}

beforeAll(async () => {
  const [company] = await db
    .insert(companies)
    .values({ code: `${PREFIX}-co`, name: `${PREFIX} company`, baseCurrency: "USD" })
    .returning();
  companyId = company.id;

  const createdLocations = await db
    .insert(locations)
    .values([
      { companyId, code: `${PREFIX}-src-a`, name: "POS Source A" },
      { companyId, code: `${PREFIX}-src-b`, name: "POS Source B" },
      { companyId, code: `${PREFIX}-dst`, name: "Warehouse" },
    ])
    .returning();
  sourceAId = createdLocations[0].id;
  sourceBId = createdLocations[1].id;
  destinationId = createdLocations[2].id;

  const createdItems = await db
    .insert(stockItems)
    .values([
      { companyId, code: `${PREFIX}-item-a`, name: "Bale A", uom: "BALE", active: true },
      { companyId, code: `${PREFIX}-item-b`, name: "Bale B", uom: "BALE", active: true },
    ])
    .returning();
  itemAId = createdItems[0].id;
  itemBId = createdItems[1].id;

  await db.insert(inventory).values([
    { companyId, locationId: sourceAId, stockItemId: itemAId, quantity: "90", averageRate: "10", totalValue: "900" },
    { companyId, locationId: sourceBId, stockItemId: itemBId, quantity: "90", averageRate: "10", totalValue: "900" },
    {
      companyId,
      locationId: destinationId,
      stockItemId: itemAId,
      quantity: "10",
      averageRate: "10",
      totalValue: "100",
    },
    {
      companyId,
      locationId: destinationId,
      stockItemId: itemBId,
      quantity: "10",
      averageRate: "10",
      totalValue: "100",
    },
  ]);

  const [voucher] = await db
    .insert(vouchers)
    .values({
      companyId,
      locationId: sourceAId,
      voucherNumber: `${PREFIX}-voucher`,
      voucherType: "Stock Transfer",
      voucherDate: "2026-08-07",
      description: "Multi-source POS revision approval",
      totalAmount: "200",
      optional: false,
    })
    .returning();
  voucherId = voucher.id;

  const [transfer] = await db
    .insert(stockTransferVouchers)
    .values({
      voucherId,
      sourceLocationId: sourceAId,
      destinationLocationId: destinationId,
      notes: "Multi-source POS revision approval",
      inventoryApplied: true,
    })
    .returning();
  transferId = transfer.id;

  await db.insert(stockTransferItems).values([
    { transferId, stockItemId: itemAId, sourceLocationId: sourceAId, quantity: "10", rate: "10", totalAmount: "100" },
    { transferId, stockItemId: itemBId, sourceLocationId: sourceBId, quantity: "10", rate: "10", totalAmount: "100" },
  ]);
});

afterAll(async () => {
  if (!companyId) return;
  const revisions = await db
    .select({ id: stockTransferRevisions.id })
    .from(stockTransferRevisions)
    .where(eq(stockTransferRevisions.transferId, transferId));
  const revisionIds = revisions.map((row) => row.id);
  if (revisionIds.length > 0) {
    await db.delete(stockTransferRevisionItems).where(inArray(stockTransferRevisionItems.revisionId, revisionIds));
    await db.delete(stockTransferRevisions).where(inArray(stockTransferRevisions.id, revisionIds));
  }
  await db.delete(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
  await db.delete(stockTransferVouchers).where(eq(stockTransferVouchers.id, transferId));
  await db.delete(vouchers).where(eq(vouchers.id, voucherId));
  await db.delete(inventory).where(eq(inventory.companyId, companyId));
  await db.execute(sql`DELETE FROM canonical_stock_movements WHERE stock_item_id IN (${itemAId}, ${itemBId})`);
  await db.execute(sql`DELETE FROM canonical_stock_movement_audit WHERE company_id = ${companyId}`);
  await db.execute(sql`DELETE FROM canonical_stock_movement_requests WHERE company_id = ${companyId}`);
  await db.delete(stockItems).where(eq(stockItems.companyId, companyId));
  await db.delete(locations).where(eq(locations.companyId, companyId));
  await db.delete(companies).where(eq(companies.id, companyId));
});

describe("immutable transfer revision approval across POS locations", () => {
  it("applies every pending revision, not only the one that was clicked", async () => {
    const fromLocationA = await createImmutableStockTransferRevision({
      companyId,
      transferId,
      userId: `${PREFIX}-pos-a`,
      pending: true,
      sourceLocationIdLimit: sourceAId,
      items: [
        {
          stockItemId: itemAId,
          stockItemName: "Bale A",
          sourceLocationId: sourceAId,
          sourceLocationName: "POS Source A",
          originalQuantity: 10,
          newQuantity: 14,
        },
      ],
    });

    const fromLocationB = await createImmutableStockTransferRevision({
      companyId,
      transferId,
      userId: `${PREFIX}-pos-b`,
      pending: true,
      sourceLocationIdLimit: sourceBId,
      items: [
        {
          stockItemId: itemBId,
          stockItemName: "Bale B",
          sourceLocationId: sourceBId,
          sourceLocationName: "POS Source B",
          originalQuantity: 10,
          newQuantity: 7,
        },
      ],
    });

    // Resubmitting supersedes the same user's earlier pending revision. This
    // used to fail outright on the array-typed supersede statement.
    const resubmitted = await createImmutableStockTransferRevision({
      companyId,
      transferId,
      userId: `${PREFIX}-pos-a`,
      pending: true,
      sourceLocationIdLimit: sourceAId,
      items: [
        {
          stockItemId: itemAId,
          stockItemName: "Bale A",
          sourceLocationId: sourceAId,
          sourceLocationName: "POS Source A",
          originalQuantity: 10,
          newQuantity: 14,
        },
      ],
      note: "Resubmitted after reopening the transfer",
    });
    expect(resubmitted.revisionId).not.toBe(fromLocationA.revisionId);
    const [superseded] = await db
      .select({ status: stockTransferRevisions.status })
      .from(stockTransferRevisions)
      .where(eq(stockTransferRevisions.id, fromLocationA.revisionId));
    expect(superseded.status).toBe("superseded");

    // The admin approves the first row in the list; the second must land too.
    const result = await approveImmutableStockTransferRevision(companyId, resubmitted.revisionId, `${PREFIX}-admin`);
    expect(result.transition).toBe("approved");
    expect(result.appliedRevisionCount).toBe(2);
    expect(result.changedItemCount).toBe(2);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stockItemId: itemAId,
          stockItemName: "Bale A",
          sourceLocationId: sourceAId,
          sourceLocationName: "POS Source A",
          originalQuantity: 10,
          newQuantity: 14,
          delta: 4,
          rate: 10,
        }),
        expect.objectContaining({
          stockItemId: itemBId,
          stockItemName: "Bale B",
          sourceLocationId: sourceBId,
          sourceLocationName: "POS Source B",
          originalQuantity: 10,
          newQuantity: 7,
          delta: -3,
          rate: 10,
        }),
      ])
    );

    expect(await transferQty(itemAId, sourceAId)).toBe(14);
    expect(await transferQty(itemBId, sourceBId)).toBe(7);

    expect(await inventoryQty(sourceAId, itemAId)).toBe(86);
    expect(await inventoryQty(destinationId, itemAId)).toBe(14);
    expect(await inventoryQty(sourceBId, itemBId)).toBe(93);
    expect(await inventoryQty(destinationId, itemBId)).toBe(7);

    const statuses = await db
      .select({ id: stockTransferRevisions.id, status: stockTransferRevisions.status })
      .from(stockTransferRevisions)
      .where(inArray(stockTransferRevisions.id, [resubmitted.revisionId, fromLocationB.revisionId]));
    expect(statuses.every((row) => row.status === "approved")).toBe(true);
  });

  it("is a no-op when the same revision is approved twice", async () => {
    const [alreadyApproved] = await db
      .select({ id: stockTransferRevisions.id })
      .from(stockTransferRevisions)
      .where(and(eq(stockTransferRevisions.transferId, transferId), eq(stockTransferRevisions.status, "approved")));

    const before = [await inventoryQty(sourceAId, itemAId), await inventoryQty(destinationId, itemAId)];
    const repeat = await approveImmutableStockTransferRevision(companyId, alreadyApproved.id, `${PREFIX}-admin`);
    expect(repeat.transition).toBe("no-op");
    expect(repeat.items.length).toBeGreaterThan(0);
    expect(repeat.items[0]).toEqual(expect.objectContaining({ stockItemName: expect.any(String) }));
    expect([await inventoryQty(sourceAId, itemAId), await inventoryQty(destinationId, itemAId)]).toEqual(before);
  });
});
