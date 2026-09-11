import { db } from "../../db";
import { logger } from "../../lib/logger";
import {
  inventory,
  salesItems,
  vouchers,
  containerOffloadItems,
  containerOffloads,
  containers,
  stockAdjustmentItems,
  stockAdjustmentVouchers,
  stockTransferItems,
  stockTransferVouchers,
  creditNoteItems,
  stockItems as stockItemsTable,
  stockGroups as stockGroupsTable,
  stockCategories as stockCategoriesTable,
} from "@shared/schema";
import { eq, and, sql, gt, inArray } from "drizzle-orm";

// TEMP DEBUG (historical opening-stock audit): gate behind an explicit env
// flag so routine exports/inventory reads stay quiet by default. Enable with
// DEBUG_HISTORICAL_INVENTORY=1 when auditing an opening-stock discrepancy.
const DEBUG_HISTORICAL_INVENTORY = process.env.DEBUG_HISTORICAL_INVENTORY === "1";

// ─── Historical inventory ─────────────────────────────────────────────────────
export type HistoricalLocationInventoryRow = {
  stockItemId: number;
  quantity: string;
  averageRate: string;
  totalValue: string;
  stockItemCode: string;
  stockItemName: string;
  stockItemUom: string;
  stockGroupId: number | null;
  stockGroupName: string;
  stockGroupCode: string;
  categoryId: number | null;
  categoryName: string | null;
  stockItemActive: boolean;
};

export async function calculateHistoricalLocationInventory(
  locationId: number,
  companyId: number,
  asOfDate: string
): Promise<HistoricalLocationInventoryRow[]> {
  const cutoffDateStr = asOfDate;
  const cutoffTimestamp = new Date(asOfDate + "T23:59:59.999");

  const seedStockItemIds = new Set<number>();

  const currentInventory = await db
    .select({
      stockItemId: inventory.stockItemId,
      quantity: inventory.quantity,
      averageRate: inventory.averageRate,
    })
    .from(inventory)
    .where(and(eq(inventory.locationId, locationId), eq(inventory.companyId, companyId)))
    .execute();

  for (const inv of currentInventory) seedStockItemIds.add(inv.stockItemId);

  const salesStockItems = await db
    .selectDistinct({ stockItemId: salesItems.stockItemId })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), eq(vouchers.locationId, locationId)))
    .execute();
  for (const item of salesStockItems) seedStockItemIds.add(item.stockItemId);

  const offloadStockItems = await db
    .selectDistinct({ stockItemId: containerOffloadItems.stockItemId })
    .from(containerOffloadItems)
    .innerJoin(containerOffloads, eq(containerOffloadItems.offloadId, containerOffloads.id))
    .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
    .where(and(eq(containers.companyId, companyId), eq(containerOffloads.locationId, locationId)))
    .execute();
  for (const item of offloadStockItems) seedStockItemIds.add(item.stockItemId);

  const adjustmentStockItems = await db
    .selectDistinct({ stockItemId: stockAdjustmentItems.stockItemId })
    .from(stockAdjustmentItems)
    .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
    .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), eq(stockAdjustmentVouchers.locationId, locationId)))
    .execute();
  for (const item of adjustmentStockItems) seedStockItemIds.add(item.stockItemId);

  const transfersInStockItems = await db
    .selectDistinct({ stockItemId: stockTransferItems.stockItemId })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), eq(stockTransferVouchers.destinationLocationId, locationId)))
    .execute();
  for (const item of transfersInStockItems) seedStockItemIds.add(item.stockItemId);

  const transfersOutStockItems = await db
    .selectDistinct({ stockItemId: stockTransferItems.stockItemId })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), eq(stockTransferItems.sourceLocationId, locationId)))
    .execute();
  for (const item of transfersOutStockItems) seedStockItemIds.add(item.stockItemId);

  // Credit/Debit notes — the monthly-summary route's per-month buckets fold these
  // in (Credit Note = inward, Debit Note = outward), so the historical opening
  // reconstruction must seed and reverse them too or opening balances drift.
  const creditDebitNoteStockItems = await db
    .selectDistinct({ stockItemId: creditNoteItems.stockItemId })
    .from(creditNoteItems)
    .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), eq(creditNoteItems.locationId, locationId)))
    .execute();
  for (const item of creditDebitNoteStockItems) seedStockItemIds.add(item.stockItemId);

  if (seedStockItemIds.size === 0) return [];

  const inventoryMap = new Map<number, { quantity: number; totalValue: number; rate: number }>();
  for (const stockItemId of Array.from(seedStockItemIds)) {
    inventoryMap.set(stockItemId, { quantity: 0, totalValue: 0, rate: 0 });
  }

  for (const inv of currentInventory) {
    const qty = parseFloat(inv.quantity) || 0;
    const rate = parseFloat(inv.averageRate) || 0;
    inventoryMap.set(inv.stockItemId, {
      quantity: qty,
      totalValue: qty * rate,
      rate,
    });
  }

  const salesAfterDate = await db
    .select({
      stockItemId: salesItems.stockItemId,
      quantity: salesItems.quantity,
      costPrice: salesItems.costPrice,
    })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.locationId, locationId),
        eq(vouchers.optional, false),
        sql`${vouchers.voucherDate} > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const sale of salesAfterDate) {
    const qty = parseFloat(sale.quantity) || 0;
    const cost = parseFloat(sale.costPrice) || 0;
    const existing = inventoryMap.get(sale.stockItemId) || {
      quantity: 0,
      totalValue: 0,
      rate: 0,
    };
    existing.quantity += qty;
    existing.totalValue += qty * cost;
    if (existing.quantity > 0) existing.rate = existing.totalValue / existing.quantity;
    inventoryMap.set(sale.stockItemId, existing);
  }

  const adjustmentsAfterDate = await db
    .select({
      stockItemId: stockAdjustmentItems.stockItemId,
      quantity: stockAdjustmentItems.quantity,
      rate: stockAdjustmentItems.rate,
      adjustmentType: stockAdjustmentVouchers.adjustmentType,
    })
    .from(stockAdjustmentItems)
    .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
    .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(stockAdjustmentVouchers.locationId, locationId),
        eq(vouchers.optional, false),
        sql`${vouchers.voucherDate} > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const adj of adjustmentsAfterDate) {
    // stock_adjustment_items.quantity is stored SIGNED at creation time
    // (see client StockAdjustmentForm.tsx + server storage/stockOps.ts):
    //   PRODUCE items -> positive quantity (increases inventory)
    //   CONSUME items -> negative quantity (decreases inventory)
    // This holds true for "Production", "Consumption", AND "Mixed" adjustment
    // vouchers alike — the sign lives on the item, not just the voucher type.
    // To reverse an after-cutoff adjustment we simply undo its signed effect:
    //   historicalQty = currentQty - signedQty
    // (Do NOT branch on adjustmentType here — a prior version treated
    // non-"Production" rows as "always subtract further", which is correct
    // for the qty>0 case but doubles the error for negative (Consumption/
    // Mixed-consumption) quantities instead of adding them back.)
    const qty = parseFloat(adj.quantity) || 0;
    const rate = parseFloat(adj.rate) || 0;
    const existing = inventoryMap.get(adj.stockItemId) || {
      quantity: 0,
      totalValue: 0,
      rate: 0,
    };
    existing.quantity -= qty;
    existing.totalValue -= qty * rate;
    if (existing.quantity > 0) existing.rate = existing.totalValue / existing.quantity;
    inventoryMap.set(adj.stockItemId, existing);
  }

  // TEMP DEBUG (historical opening-stock audit): show the reversal effect for
  // one sample stock item so a "stock added today, exported for a past range"
  // scenario can be verified end-to-end (current vs. after-cutoff adjustments
  // reversed vs. resulting historical qty).
  if (DEBUG_HISTORICAL_INVENTORY && adjustmentsAfterDate.length > 0) {
    const sample = adjustmentsAfterDate[0];
    const currentSample = currentInventory.find((i) => i.stockItemId === sample.stockItemId);
    const currentQty = currentSample ? parseFloat(currentSample.quantity) || 0 : 0;
    const adjustmentsForSample = adjustmentsAfterDate.filter((a) => a.stockItemId === sample.stockItemId);
    const reversedQty = adjustmentsForSample.reduce((s, a) => s + (parseFloat(a.quantity) || 0), 0);
    const historicalQty = inventoryMap.get(sample.stockItemId)?.quantity ?? 0;
    logger.info(
      `[calculateHistoricalLocationInventory] DEBUG sample stockItemId=${sample.stockItemId} locationId=${locationId} cutoff=${cutoffDateStr} ` +
        `currentQty=${currentQty} afterCutoffAdjustmentsQty(signed,reversed)=${reversedQty} historicalOpeningQty=${historicalQty}`
    );
  }

  const transfersInAfterDate = await db
    .select({
      stockItemId: stockTransferItems.stockItemId,
      quantity: stockTransferItems.quantity,
      rate: stockTransferItems.rate,
    })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(stockTransferVouchers.destinationLocationId, locationId),
        eq(vouchers.optional, false),
        sql`${vouchers.voucherDate} > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const transfer of transfersInAfterDate) {
    const qty = parseFloat(transfer.quantity) || 0;
    const rate = parseFloat(transfer.rate) || 0;
    const existing = inventoryMap.get(transfer.stockItemId) || {
      quantity: 0,
      totalValue: 0,
      rate: 0,
    };
    existing.quantity -= qty;
    existing.totalValue -= qty * rate;
    if (existing.quantity > 0) existing.rate = existing.totalValue / existing.quantity;
    inventoryMap.set(transfer.stockItemId, existing);
  }

  const transfersOutAfterDate = await db
    .select({
      stockItemId: stockTransferItems.stockItemId,
      quantity: stockTransferItems.quantity,
      rate: stockTransferItems.rate,
    })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(stockTransferItems.sourceLocationId, locationId),
        eq(vouchers.optional, false),
        sql`${vouchers.voucherDate} > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const transfer of transfersOutAfterDate) {
    const qty = parseFloat(transfer.quantity) || 0;
    const rate = parseFloat(transfer.rate) || 0;
    const existing = inventoryMap.get(transfer.stockItemId) || {
      quantity: 0,
      totalValue: 0,
      rate: 0,
    };
    existing.quantity += qty;
    existing.totalValue += qty * rate;
    if (existing.quantity > 0) existing.rate = existing.totalValue / existing.quantity;
    inventoryMap.set(transfer.stockItemId, existing);
  }

  const offloadsAfterDate = await db
    .select({
      stockItemId: containerOffloadItems.stockItemId,
      quantity: containerOffloadItems.quantity,
      rate: containerOffloadItems.rate,
    })
    .from(containerOffloadItems)
    .innerJoin(containerOffloads, eq(containerOffloadItems.offloadId, containerOffloads.id))
    .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
    .where(
      and(
        eq(containers.companyId, companyId),
        eq(containerOffloads.locationId, locationId),
        gt(containerOffloads.offloadedAt, cutoffTimestamp)
      )
    )
    .execute();

  for (const offload of offloadsAfterDate) {
    const qty = parseFloat(offload.quantity) || 0;
    const cost = parseFloat(offload.rate) || 0;
    const existing = inventoryMap.get(offload.stockItemId) || {
      quantity: 0,
      totalValue: 0,
      rate: 0,
    };
    existing.quantity -= qty;
    existing.totalValue -= qty * cost;
    if (existing.quantity > 0) existing.rate = existing.totalValue / existing.quantity;
    inventoryMap.set(offload.stockItemId, existing);
  }

  // Reverse credit/debit notes AFTER the target date. Credit Notes restored
  // stock (were inward) so reverse by subtracting; Debit Notes reduced stock
  // (were outward) so reverse by adding back — mirrors the sign convention
  // used in the monthly-summary month buckets.
  const creditDebitNotesAfterDate = await db
    .select({
      stockItemId: creditNoteItems.stockItemId,
      quantity: creditNoteItems.quantity,
      inventoryCost: creditNoteItems.inventoryCost,
      noteType: vouchers.voucherType,
    })
    .from(creditNoteItems)
    .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(creditNoteItems.locationId, locationId),
        sql`${vouchers.voucherDate} > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const note of creditDebitNotesAfterDate) {
    const qty = parseFloat(note.quantity) || 0;
    const cost = parseFloat(note.inventoryCost) || 0;
    const existing = inventoryMap.get(note.stockItemId) || { quantity: 0, totalValue: 0, rate: 0 };
    if (note.noteType === "Credit Note") {
      existing.quantity -= qty;
      existing.totalValue -= qty * cost;
    } else {
      existing.quantity += qty;
      existing.totalValue += qty * cost;
    }
    if (existing.quantity > 0) existing.rate = existing.totalValue / existing.quantity;
    inventoryMap.set(note.stockItemId, existing);
  }

  const stockItemIdList = Array.from(inventoryMap.keys());
  if (stockItemIdList.length === 0) return [];

  const itemDetails = await db
    .select({
      id: stockItemsTable.id,
      code: stockItemsTable.code,
      name: stockItemsTable.name,
      uom: stockItemsTable.uom,
      stockGroupId: stockItemsTable.stockGroupId,
      stockGroupName: sql<string>`COALESCE(${stockGroupsTable.name}, '')`,
      stockGroupCode: sql<string>`COALESCE(${stockGroupsTable.code}, '')`,
      categoryId: stockItemsTable.categoryId,
      categoryName: stockCategoriesTable.name,
      active: stockItemsTable.active,
    })
    .from(stockItemsTable)
    .leftJoin(stockGroupsTable, eq(stockItemsTable.stockGroupId, stockGroupsTable.id))
    .leftJoin(stockCategoriesTable, eq(stockItemsTable.categoryId, stockCategoriesTable.id))
    .where(inArray(stockItemsTable.id, stockItemIdList));

  const detailMap = new Map(itemDetails.map((d) => [d.id, d]));

  const results = [];
  for (const [stockItemId, data] of Array.from(inventoryMap.entries())) {
    const detail = detailMap.get(stockItemId);
    results.push({
      stockItemId,
      quantity: data.quantity.toString(),
      averageRate: data.rate.toString(),
      totalValue: data.totalValue.toString(),
      stockItemCode: detail?.code ?? "",
      stockItemName: detail?.name ?? "",
      stockItemUom: detail?.uom ?? "",
      stockGroupId: detail?.stockGroupId ?? null,
      stockGroupName: detail?.stockGroupName ?? "",
      stockGroupCode: detail?.stockGroupCode ?? "",
      categoryId: detail?.categoryId ?? null,
      categoryName: detail?.categoryName ?? null,
      stockItemActive: detail?.active ?? true,
    });
  }
  return results;
}
