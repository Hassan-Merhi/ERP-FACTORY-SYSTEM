import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "../server/db";
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
  approvePendingStockTransferRevision,
  savePendingStockTransferRevision,
} from "../server/services/stockTransferRevisionLifecycle";

const PREFIX = `revision-lifecycle-${Date.now()}`;
let companyId = 0;
let sourceId = 0;
let destinationId = 0;
let itemId = 0;
let voucherId = 0;
let transferId = 0;
let pendingRevisionId = 0;

async function inventoryQty(locationId: number): Promise<number> {
  const [row] = await db
    .select({ quantity: inventory.quantity })
    .from(inventory)
    .where(
      and(eq(inventory.companyId, companyId), eq(inventory.locationId, locationId), eq(inventory.stockItemId, itemId))
    );
  return Number(row?.quantity ?? 0);
}

async function cleanup() {
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
  // The revision approvals write canonical stock evidence for the company's items.
  await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [companyId]);
  await db.delete(inventory).where(eq(inventory.companyId, companyId));
  await db.delete(stockItems).where(eq(stockItems.companyId, companyId));
  await db.delete(locations).where(eq(locations.companyId, companyId));
  await db.delete(companies).where(eq(companies.id, companyId));
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
      { companyId, code: `${PREFIX}-src`, name: "Revision Source" },
      { companyId, code: `${PREFIX}-dst`, name: "Revision Destination" },
    ])
    .returning();
  sourceId = createdLocations[0].id;
  destinationId = createdLocations[1].id;

  const [item] = await db
    .insert(stockItems)
    .values({ companyId, code: `${PREFIX}-item`, name: "Revision Bale", uom: "BALE", active: true })
    .returning();
  itemId = item.id;

  await db.insert(inventory).values([
    {
      companyId,
      locationId: sourceId,
      stockItemId: itemId,
      quantity: "90",
      averageRate: "10",
      totalValue: "900",
    },
    {
      companyId,
      locationId: destinationId,
      stockItemId: itemId,
      quantity: "10",
      averageRate: "10",
      totalValue: "100",
    },
  ]);

  const [voucher] = await db
    .insert(vouchers)
    .values({
      companyId,
      locationId: sourceId,
      voucherNumber: `${PREFIX}-voucher`,
      voucherType: "Stock Transfer",
      voucherDate: "2026-07-22",
      description: "Revision lifecycle test",
      totalAmount: "100",
      optional: false,
    })
    .returning();
  voucherId = voucher.id;

  const [transfer] = await db
    .insert(stockTransferVouchers)
    .values({
      voucherId,
      sourceLocationId: sourceId,
      destinationLocationId: destinationId,
      notes: "Revision lifecycle test",
      inventoryApplied: true,
    })
    .returning();
  transferId = transfer.id;

  await db.insert(stockTransferItems).values({
    transferId,
    stockItemId: itemId,
    sourceLocationId: sourceId,
    quantity: "10",
    rate: "10",
    totalAmount: "100",
  });
});

afterAll(cleanup);

describe("stock transfer revision lifecycle", () => {
  it("replaces one user's pending snapshot without duplicate rows", async () => {
    const first = await savePendingStockTransferRevision({
      companyId,
      transferId,
      userId: `${PREFIX}-user`,
      sourceLocationIdLimit: sourceId,
      note: "First change",
      items: [
        {
          stockItemId: itemId,
          stockItemName: "Revision Bale",
          sourceLocationId: sourceId,
          sourceLocationName: "Revision Source",
          originalQuantity: 10,
          newQuantity: 12,
        },
      ],
    });

    const second = await savePendingStockTransferRevision({
      companyId,
      transferId,
      userId: `${PREFIX}-user`,
      sourceLocationIdLimit: sourceId,
      note: "Replacement change",
      items: [
        {
          stockItemId: itemId,
          stockItemName: "Revision Bale",
          sourceLocationId: sourceId,
          sourceLocationName: "Revision Source",
          originalQuantity: 10,
          newQuantity: 15,
        },
      ],
    });

    pendingRevisionId = second.revisionId;
    expect(second.revisionId).toBe(first.revisionId);
    const rows = await db
      .select()
      .from(stockTransferRevisionItems)
      .where(eq(stockTransferRevisionItems.revisionId, pendingRevisionId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].newQuantity)).toBe(15);
    expect(Number(rows[0].delta)).toBe(5);
    expect(await inventoryQty(sourceId)).toBe(90);
    expect(await inventoryQty(destinationId)).toBe(10);
  });

  it("approves all pending rows once and updates inventory atomically", async () => {
    const firstApproval = await approvePendingStockTransferRevision(companyId, pendingRevisionId);
    expect(firstApproval.transition).toBe("approved");
    expect(firstApproval.approvedRevisionCount).toBe(1);
    expect(await inventoryQty(sourceId)).toBe(85);
    expect(await inventoryQty(destinationId)).toBe(15);

    const [line] = await db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    expect(Number(line.quantity)).toBe(15);

    const beforeRepeat = [await inventoryQty(sourceId), await inventoryQty(destinationId)];
    const secondApproval = await approvePendingStockTransferRevision(companyId, pendingRevisionId);
    expect(secondApproval.transition).toBe("no-op");
    expect([await inventoryQty(sourceId), await inventoryQty(destinationId)]).toEqual(beforeRepeat);
  });

  it("rolls back approval when source stock changed after revision submission", async () => {
    const pending = await savePendingStockTransferRevision({
      companyId,
      transferId,
      userId: `${PREFIX}-rollback-user`,
      sourceLocationIdLimit: sourceId,
      note: "Too much stock",
      items: [
        {
          stockItemId: itemId,
          stockItemName: "Revision Bale",
          sourceLocationId: sourceId,
          sourceLocationName: "Revision Source",
          originalQuantity: 15,
          newQuantity: 200,
        },
      ],
    });

    const before = [await inventoryQty(sourceId), await inventoryQty(destinationId)];
    await expect(approvePendingStockTransferRevision(companyId, pending.revisionId)).rejects.toMatchObject({
      code: "STOCK_TRANSFER_INSUFFICIENT_STOCK",
    });
    expect([await inventoryQty(sourceId), await inventoryQty(destinationId)]).toEqual(before);

    const [revision] = await db
      .select({ optional: stockTransferRevisions.optional })
      .from(stockTransferRevisions)
      .where(eq(stockTransferRevisions.id, pending.revisionId));
    expect(revision.optional).toBe(true);
  });

  it("rejects a POS revision for another source location", async () => {
    await expect(
      savePendingStockTransferRevision({
        companyId,
        transferId,
        userId: `${PREFIX}-other-user`,
        sourceLocationIdLimit: destinationId,
        items: [
          {
            stockItemId: itemId,
            stockItemName: "Revision Bale",
            sourceLocationId: sourceId,
            originalQuantity: 15,
            newQuantity: 16,
          },
        ],
      })
    ).rejects.toThrow(/own source location/i);
  });
});
