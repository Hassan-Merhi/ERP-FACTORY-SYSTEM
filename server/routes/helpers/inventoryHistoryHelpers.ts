import { db, type DatabaseOrTransaction } from "../../db";
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
  inventoryValueMovements,
  stockItems as stockItemsTable,
  stockGroups as stockGroupsTable,
  stockCategories as stockCategoriesTable,
} from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../lib/money";

// TEMP DEBUG (historical opening-stock audit): gate behind an explicit env
// flag so routine exports/inventory reads stay quiet by default. Enable with
// DEBUG_HISTORICAL_INVENTORY=1 when auditing an opening-stock discrepancy.
const DEBUG_HISTORICAL_INVENTORY = process.env.DEBUG_HISTORICAL_INVENTORY === "1";

/**
 * The value a movement line moved, unsigned: the sub-ledger value it recorded
 * (`value_moved`, wave 11) when present, else the line's stored total, else
 * quantity × rate. value_moved is read as an amount whatever sign the writer
 * gave it; the caller applies the direction.
 */
function exactMovementValue(
  exactTotal: string | number | null | undefined,
  quantity: Decimal,
  fallbackRate: Decimal,
  valueMoved?: string | number | null
): Decimal {
  if (valueMoved !== null && valueMoved !== undefined && valueMoved !== "") {
    const moved = toMoney(valueMoved);
    if (moved.isFinite()) return moved.abs();
  }
  if (exactTotal !== null && exactTotal !== undefined && exactTotal !== "") {
    try {
      const parsed = new MoneyDecimal(exactTotal);
      if (parsed.isFinite()) return parsed.abs();
    } catch {
      // Not a number: fall back to quantity x rate below.
    }
  }
  return quantity.times(fallbackRate).abs();
}

type HistoricalStock = { quantity: Decimal; totalValue: Decimal; rate: number };

function emptyHistoricalStock(): HistoricalStock {
  return { quantity: new MoneyDecimal(0), totalValue: new MoneyDecimal(0), rate: 0 };
}

/** Moves a stock item's reconstructed quantity and value, then refreshes its rate. */
function applyHistoricalMovement(
  inventoryMap: Map<number, HistoricalStock>,
  stockItemId: number,
  quantity: Decimal,
  value: Decimal
): void {
  const existing = inventoryMap.get(stockItemId) ?? emptyHistoricalStock();
  existing.quantity = existing.quantity.plus(quantity);
  existing.totalValue = existing.totalValue.plus(value);
  if (existing.quantity.greaterThan(0) && existing.totalValue.greaterThan(0)) {
    existing.rate = existing.totalValue.dividedBy(existing.quantity).toNumber();
  }
  inventoryMap.set(stockItemId, existing);
}

/** Plain decimal text; zero is always "0", never "-0". */
function plainNumber(value: Decimal): string {
  return value.isZero() ? "0" : value.toFixed();
}

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

// ─── Historical inventory ─────────────────────────────────────────────────────
export async function calculateHistoricalLocationInventory(
  locationId: number,
  companyId: number,
  asOfDate: string,
  executor: DatabaseOrTransaction = db
): Promise<HistoricalLocationInventoryRow[]> {
  const cutoffDateStr = asOfDate;

  const seedStockItemIds = new Set<number>();

  const currentInventory = await executor
    .select({
      stockItemId: inventory.stockItemId,
      quantity: inventory.quantity,
      averageRate: inventory.averageRate,
      totalValue: inventory.totalValue,
    })
    .from(inventory)
    .where(and(eq(inventory.locationId, locationId), eq(inventory.companyId, companyId)))
    .execute();

  for (const inv of currentInventory) seedStockItemIds.add(inv.stockItemId);

  const salesStockItems = await executor
    .selectDistinct({ stockItemId: salesItems.stockItemId })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), eq(vouchers.locationId, locationId), isNull(vouchers.deletedAt)))
    .execute();
  for (const item of salesStockItems) seedStockItemIds.add(item.stockItemId);

  const offloadStockItems = await executor
    .selectDistinct({ stockItemId: containerOffloadItems.stockItemId })
    .from(containerOffloadItems)
    .innerJoin(containerOffloads, eq(containerOffloadItems.offloadId, containerOffloads.id))
    .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
    .where(and(eq(containers.companyId, companyId), eq(containerOffloads.locationId, locationId)))
    .execute();
  for (const item of offloadStockItems) seedStockItemIds.add(item.stockItemId);

  const adjustmentStockItems = await executor
    .selectDistinct({ stockItemId: stockAdjustmentItems.stockItemId })
    .from(stockAdjustmentItems)
    .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
    .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(stockAdjustmentVouchers.locationId, locationId),
        isNull(vouchers.deletedAt)
      )
    )
    .execute();
  for (const item of adjustmentStockItems) seedStockItemIds.add(item.stockItemId);

  const transfersInStockItems = await executor
    .selectDistinct({ stockItemId: stockTransferItems.stockItemId })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(stockTransferVouchers.destinationLocationId, locationId),
        isNull(vouchers.deletedAt)
      )
    )
    .execute();
  for (const item of transfersInStockItems) seedStockItemIds.add(item.stockItemId);

  const transfersOutStockItems = await executor
    .selectDistinct({ stockItemId: stockTransferItems.stockItemId })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(stockTransferItems.sourceLocationId, locationId),
        isNull(vouchers.deletedAt)
      )
    )
    .execute();
  for (const item of transfersOutStockItems) seedStockItemIds.add(item.stockItemId);

  // Credit/Debit notes — the monthly-summary route's per-month buckets fold these
  // in (Credit Note = inward, Debit Note = outward), so the historical opening
  // reconstruction must seed and reverse them too or opening balances drift.
  const creditDebitNoteStockItems = await executor
    .selectDistinct({ stockItemId: creditNoteItems.stockItemId })
    .from(creditNoteItems)
    .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
    .where(
      and(eq(vouchers.companyId, companyId), eq(creditNoteItems.locationId, locationId), isNull(vouchers.deletedAt))
    )
    .execute();
  for (const item of creditDebitNoteStockItems) seedStockItemIds.add(item.stockItemId);

  // Movements that leave no document line (quick adjustments, archive and
  // restore, location imports, cost corrections, readiness write-offs): their
  // dated evidence (inventory_value_movements, wave 15) is replayed like a
  // document line.
  const evidenceAfterDate = await executor
    .select({
      stockItemId: inventoryValueMovements.stockItemId,
      quantityDelta: inventoryValueMovements.quantityDelta,
      valueDelta: inventoryValueMovements.valueDelta,
    })
    .from(inventoryValueMovements)
    .where(
      and(
        eq(inventoryValueMovements.companyId, companyId),
        eq(inventoryValueMovements.locationId, locationId),
        sql`${inventoryValueMovements.stockItemId} IS NOT NULL`,
        sql`${inventoryValueMovements.movementDate} > ${cutoffDateStr}::date`
      )
    )
    .execute();
  for (const movement of evidenceAfterDate) {
    if (movement.stockItemId !== null) seedStockItemIds.add(movement.stockItemId);
  }

  if (seedStockItemIds.size === 0) return [];

  const inventoryMap = new Map<number, HistoricalStock>();
  for (const stockItemId of Array.from(seedStockItemIds)) {
    inventoryMap.set(stockItemId, emptyHistoricalStock());
  }

  // Seed the backward reconstruction from the exact stored asset value, as
  // stored: a short row's negative value (the negative-stock policy) is part
  // of the sub-ledger and is replayed like any other. The average_rate is
  // cost memory only and never regenerates value (wave 11).
  for (const inv of currentInventory) {
    const quantity = toMoney(inv.quantity);
    const totalValue = toMoney(inv.totalValue);
    inventoryMap.set(inv.stockItemId, {
      quantity,
      totalValue,
      rate:
        quantity.gt(0) && totalValue.gt(0)
          ? totalValue.dividedBy(quantity).toNumber()
          : Math.max(toMoney(inv.averageRate).toNumber(), 0),
    });
  }

  const salesAfterDate = await executor
    .select({
      stockItemId: salesItems.stockItemId,
      quantity: salesItems.quantity,
      costPrice: salesItems.costPrice,
      totalCost: salesItems.totalCost,
      valueMoved: salesItems.valueMoved,
    })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.locationId, locationId),
        eq(vouchers.optional, false),
        isNull(vouchers.deletedAt),
        sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const sale of salesAfterDate) {
    const qty = toMoney(sale.quantity);
    const value = exactMovementValue(sale.totalCost, qty, toMoney(sale.costPrice), sale.valueMoved);
    applyHistoricalMovement(inventoryMap, sale.stockItemId, qty, value);
  }

  const adjustmentsAfterDate = await executor
    .select({
      stockItemId: stockAdjustmentItems.stockItemId,
      quantity: stockAdjustmentItems.quantity,
      rate: stockAdjustmentItems.rate,
      totalAmount: stockAdjustmentItems.totalAmount,
      valueMoved: stockAdjustmentItems.valueMoved,
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
        isNull(vouchers.deletedAt),
        sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const adj of adjustmentsAfterDate) {
    // The line's direction is the writer's: a Production receives, a
    // Consumption issues (its quantity is stored as entered, unsigned), and a
    // Mixed line moves by the sign of its quantity. Reverse both quantity and
    // the exact stored line value in that direction so historical value is not
    // reconstructed from the rounded rate.
    const rawQty = toMoney(adj.quantity);
    const adjustmentType = (adj.adjustmentType ?? "").trim().toLowerCase();
    const inward = adjustmentType === "production" || (adjustmentType !== "consumption" && !rawQty.lessThan(0));
    const qty = inward ? rawQty.abs() : rawQty.abs().negated();
    const absoluteValue = exactMovementValue(adj.totalAmount, qty, toMoney(adj.rate), adj.valueMoved);
    const signedValue = inward ? absoluteValue : absoluteValue.negated();
    applyHistoricalMovement(inventoryMap, adj.stockItemId, qty.negated(), signedValue.negated());
  }

  // TEMP DEBUG (historical opening-stock audit): show the reversal effect for
  // one sample stock item so a "stock added today, exported for a past range"
  // scenario can be verified end-to-end (current vs. after-cutoff adjustments
  // reversed vs. resulting historical qty).
  if (DEBUG_HISTORICAL_INVENTORY && adjustmentsAfterDate.length > 0) {
    const sample = adjustmentsAfterDate[0];
    const currentSample = currentInventory.find((i) => i.stockItemId === sample.stockItemId);
    const currentQty = toMoney(currentSample?.quantity).toString();
    const adjustmentsForSample = adjustmentsAfterDate.filter((a) => a.stockItemId === sample.stockItemId);
    const reversedQty = adjustmentsForSample.reduce((s, a) => s.plus(toMoney(a.quantity)), new MoneyDecimal(0));
    const historicalQty = (inventoryMap.get(sample.stockItemId)?.quantity ?? new MoneyDecimal(0)).toString();
    logger.info(
      `[calculateHistoricalLocationInventory] DEBUG sample stockItemId=${sample.stockItemId} locationId=${locationId} cutoff=${cutoffDateStr} ` +
        `currentQty=${currentQty} afterCutoffAdjustmentsQty(signed,reversed)=${reversedQty} historicalOpeningQty=${historicalQty}`
    );
  }

  const transfersInAfterDate = await executor
    .select({
      stockItemId: stockTransferItems.stockItemId,
      quantity: stockTransferItems.quantity,
      rate: stockTransferItems.rate,
      totalAmount: stockTransferItems.totalAmount,
      valueMoved: stockTransferItems.valueMoved,
    })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(stockTransferVouchers.destinationLocationId, locationId),
        eq(vouchers.optional, false),
        isNull(vouchers.deletedAt),
        sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const transfer of transfersInAfterDate) {
    const qty = toMoney(transfer.quantity);
    const value = exactMovementValue(transfer.totalAmount, qty, toMoney(transfer.rate), transfer.valueMoved);
    applyHistoricalMovement(inventoryMap, transfer.stockItemId, qty.negated(), value.negated());
  }

  const transfersOutAfterDate = await executor
    .select({
      stockItemId: stockTransferItems.stockItemId,
      quantity: stockTransferItems.quantity,
      rate: stockTransferItems.rate,
      totalAmount: stockTransferItems.totalAmount,
      valueMoved: stockTransferItems.valueMoved,
    })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(stockTransferItems.sourceLocationId, locationId),
        eq(vouchers.optional, false),
        isNull(vouchers.deletedAt),
        sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const transfer of transfersOutAfterDate) {
    const qty = toMoney(transfer.quantity);
    const value = exactMovementValue(transfer.totalAmount, qty, toMoney(transfer.rate), transfer.valueMoved);
    applyHistoricalMovement(inventoryMap, transfer.stockItemId, qty, value);
  }

  const offloadsAfterDate = await executor
    .select({
      stockItemId: containerOffloadItems.stockItemId,
      quantity: containerOffloadItems.quantity,
      rate: containerOffloadItems.rate,
      totalValue: containerOffloadItems.totalValue,
      valueMoved: containerOffloadItems.valueMoved,
    })
    .from(containerOffloadItems)
    .innerJoin(containerOffloads, eq(containerOffloadItems.offloadId, containerOffloads.id))
    .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
    .where(
      and(
        eq(containers.companyId, companyId),
        eq(containerOffloads.locationId, locationId),
        // A suspended (optional) offload's stock is already out of inventory.
        eq(containerOffloads.optional, false),
        // Dated as the stock-in journal dates it: the container's offload date,
        // else the offload's own timestamp (wave 15).
        sql`COALESCE(${containers.offloadDate}, (${containerOffloads.offloadedAt})::date) > ${cutoffDateStr}::date`
      )
    )
    .execute();

  for (const offload of offloadsAfterDate) {
    const qty = toMoney(offload.quantity);
    // An offload line's direction is the sign of its quantity: a net-negative
    // PO line returned stock (its value_moved is negative too), so it is
    // replayed as an issue, not as a receipt of a negative amount.
    const amount = exactMovementValue(offload.totalValue, qty, toMoney(offload.rate), offload.valueMoved);
    const value = qty.isNegative() ? amount.negated() : amount;
    applyHistoricalMovement(inventoryMap, offload.stockItemId, qty.negated(), value.negated());
  }

  // Reverse credit/debit notes AFTER the target date. Credit Notes restored
  // stock (were inward) so reverse by subtracting; Debit Notes reduced stock
  // (were outward) so reverse by adding back — mirrors the sign convention
  // used in the monthly-summary month buckets.
  const creditDebitNotesAfterDate = await executor
    .select({
      stockItemId: creditNoteItems.stockItemId,
      quantity: creditNoteItems.quantity,
      inventoryCost: creditNoteItems.inventoryCost,
      valueMoved: creditNoteItems.valueMoved,
      noteType: vouchers.voucherType,
    })
    .from(creditNoteItems)
    .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(creditNoteItems.locationId, locationId),
        // An optional note is not in the ledger (wave 15).
        eq(vouchers.optional, false),
        isNull(vouchers.deletedAt),
        sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) > ${cutoffDateStr}`
      )
    )
    .execute();

  for (const note of creditDebitNotesAfterDate) {
    const qty = toMoney(note.quantity);
    const value = exactMovementValue(null, qty, toMoney(note.inventoryCost), note.valueMoved);
    if (note.noteType === "Credit Note") {
      applyHistoricalMovement(inventoryMap, note.stockItemId, qty.negated(), value.negated());
    } else {
      applyHistoricalMovement(inventoryMap, note.stockItemId, qty, value);
    }
  }

  // Reverse the evidenced movements after the date: each line is the signed
  // change it made to the row.
  for (const movement of evidenceAfterDate) {
    if (movement.stockItemId === null) continue;
    applyHistoricalMovement(
      inventoryMap,
      movement.stockItemId,
      toMoney(movement.quantityDelta ?? 0).negated(),
      toMoney(movement.valueDelta).negated()
    );
  }

  const stockItemIdList = Array.from(inventoryMap.keys());
  if (stockItemIdList.length === 0) return [];

  const itemDetails = await executor
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

  const results: HistoricalLocationInventoryRow[] = [];
  for (const [stockItemId, data] of Array.from(inventoryMap.entries())) {
    const detail = detailMap.get(stockItemId);
    results.push({
      stockItemId,
      quantity: plainNumber(data.quantity),
      averageRate: data.rate.toString(),
      totalValue: plainNumber(data.totalValue),
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

/**
 * Evidenced movements after `asOfDate` that name no stock item (a transfer's
 * settlement residual, a reversal difference, a container's pre-cut-over
 * offload movement): the signed value they changed, by location (null when the
 * line names none). The as-of company valuation reverses them from the
 * sub-ledger total; they cannot be placed on an item row.
 */
export async function unitemizedInventoryMovementsAfter(
  executor: DatabaseOrTransaction,
  companyId: number,
  asOfDate: string
): Promise<Map<number | null, Decimal>> {
  const result = await executor.execute(sql`
    SELECT location_id, SUM(value_delta)::text AS value
      FROM inventory_value_movements
     WHERE company_id = ${companyId} AND stock_item_id IS NULL AND movement_date > ${asOfDate}::date
     GROUP BY location_id
  `);
  const byLocation = new Map<number | null, Decimal>();
  for (const row of result.rows as unknown as { location_id: number | null; value: string }[]) {
    byLocation.set(row.location_id === null ? null : Number(row.location_id), toMoney(row.value));
  }
  return byLocation;
}
