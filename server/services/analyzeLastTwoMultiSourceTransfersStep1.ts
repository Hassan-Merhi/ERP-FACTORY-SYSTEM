// Extracted from ./smartTransferHistoryAnalysis.ts to keep that module under the source-size cap.
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  inventory,
  locations,
  salesItems,
  stockItems,
  stockTransferItems,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";
import { calendarDaysInclusive } from "./smartTransferPerformance";
import {
  assertIsoDate,
  parseQuantity,
  uniquePositiveIds,
  type HistoricalTransferItemPerformance,
  type HistoricalTransferLine,
  type HistoricalTransferOrder,
  type SmartTransferHistoryOptions,
} from "./smartTransferHistoryAnalysisTypes";

export async function analyzeLastTwoMultiSourceTransfersStep1(
  companyId: number,
  sourceLocationIds: number[],
  destinationLocationId: number,
  options: SmartTransferHistoryOptions
) {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("A valid company is required");
  if (!Number.isInteger(destinationLocationId) || destinationLocationId <= 0) {
    throw new Error("A valid destination location is required");
  }

  const uniqueSourceIds = uniquePositiveIds(sourceLocationIds).filter((id) => id !== destinationLocationId);
  if (uniqueSourceIds.length === 0)
    throw new Error("At least one source location different from the destination is required");

  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  assertIsoDate(asOfDate, "asOfDate");

  const requestedLocationIds = [...uniqueSourceIds, destinationLocationId];
  const locationRows = await db
    .select({ id: locations.id, name: locations.name, code: locations.code })
    .from(locations)
    .where(
      and(eq(locations.companyId, companyId), inArray(locations.id, requestedLocationIds), isNull(locations.deletedAt))
    );

  const locationNameById = new Map(locationRows.map((location) => [location.id, location.name]));
  const destinationLocationName = locationNameById.get(destinationLocationId);
  if (!destinationLocationName) throw new Error("Destination location was not found in the current company");

  const missingSources = uniqueSourceIds.filter((id) => !locationNameById.has(id));
  if (missingSources.length > 0) {
    throw new Error(`Source location(s) not found in the current company: ${missingSources.join(", ")}`);
  }

  const resolvedSourceLocationId = sql<number>`COALESCE(${stockTransferItems.sourceLocationId}, ${stockTransferVouchers.sourceLocationId})`;

  const headerRows = await db
    .select({
      transferId: stockTransferVouchers.id,
      voucherId: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      voucherDate: vouchers.voucherDate,
      voucherCreatedAt: vouchers.createdAt,
      destinationLocationId: stockTransferVouchers.destinationLocationId,
    })
    .from(stockTransferVouchers)
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .innerJoin(stockTransferItems, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.voucherType, "Stock Transfer"),
        eq(vouchers.optional, false),
        isNull(vouchers.deletedAt),
        eq(stockTransferVouchers.inventoryApplied, true),
        eq(stockTransferVouchers.destinationLocationId, destinationLocationId),
        // NOTE: intentionally no source-location filter here — we look at the last
        // two completed transfers to this destination regardless of which warehouse
        // they came from. The allocation engine filters based on current stock
        // availability in the selected sources, so items with no available stock
        // there are automatically excluded.
        lte(vouchers.voucherDate, asOfDate)
      )
    )
    .groupBy(
      stockTransferVouchers.id,
      vouchers.id,
      vouchers.voucherNumber,
      vouchers.voucherDate,
      vouchers.createdAt,
      stockTransferVouchers.destinationLocationId
    )
    .orderBy(desc(vouchers.voucherDate), desc(vouchers.createdAt), desc(vouchers.id))
    .limit(4);

  if (headerRows.length === 0) {
    return {
      done: true as const,
      value: {
        companyId,
        destinationLocationId,
        destinationLocationName,
        selectedSourceLocationIds: uniqueSourceIds,
        selectedSourceLocationNames: uniqueSourceIds.map((id) => locationNameById.get(id)!),
        asOfDate,
        newerTransfer: null,
        olderTransfer: null,
        items: [],
        summary: `No completed stock transfer orders were found to ${destinationLocationName}.`,
      },
    };
  }

  const transferIds = headerRows.map((row) => row.transferId);
  const transferLineRows = await db
    .select({
      transferId: stockTransferItems.transferId,
      stockItemId: stockTransferItems.stockItemId,
      stockItemName: stockItems.name,
      stockItemCode: stockItems.code,
      sourceLocationId: resolvedSourceLocationId,
      quantity: stockTransferItems.quantity,
    })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(stockItems, eq(stockTransferItems.stockItemId, stockItems.id))
    // Include all items from those transfers — the allocation engine will exclude
    // any item that has no available stock in the currently selected sources.
    .where(inArray(stockTransferItems.transferId, transferIds));

  const linesByTransferId = new Map<number, HistoricalTransferLine[]>();
  for (const row of transferLineRows) {
    const sourceLocationId = Number(row.sourceLocationId);
    const list = linesByTransferId.get(row.transferId) ?? [];
    list.push({
      stockItemId: row.stockItemId,
      stockItemName: row.stockItemName,
      stockItemCode: row.stockItemCode,
      sourceLocationId,
      sourceLocationName: locationNameById.get(sourceLocationId) ?? `Location #${sourceLocationId}`,
      quantity: parseQuantity(row.quantity),
    });
    linesByTransferId.set(row.transferId, list);
  }

  const orders: HistoricalTransferOrder[] = headerRows.map((header) => {
    const items = linesByTransferId.get(header.transferId) ?? [];
    const orderSourceLocationIds = Array.from(new Set(items.map((item) => item.sourceLocationId)));
    return {
      transferId: header.transferId,
      voucherId: header.voucherId,
      voucherNumber: header.voucherNumber,
      voucherDate: header.voucherDate,
      sourceLocationIds: orderSourceLocationIds,
      sourceLocationNames: orderSourceLocationIds.map((id) => locationNameById.get(id) ?? `Location #${id}`),
      destinationLocationId: header.destinationLocationId,
      destinationLocationName,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      items,
    };
  });

  // orders[0] = newest, orders[last] = oldest (up to 4 total)
  const newerTransfer = orders[0] ?? null;
  const olderTransfer = orders[orders.length - 1] ?? null;
  const priorOrders = orders.slice(1); // all orders except the newest
  const allLines = orders.flatMap((order) => order.items);
  const stockItemIds = Array.from(new Set(allLines.map((line) => line.stockItemId)));
  const earliestTransferDate = olderTransfer?.voucherDate ?? newerTransfer!.voucherDate;

  const [saleRows, destinationInventoryRows] = await Promise.all([
    db
      .select({
        stockItemId: salesItems.stockItemId,
        voucherDate: vouchers.voucherDate,
        quantity: salesItems.quantity,
      })
      .from(salesItems)
      .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
      .where(
        and(
          eq(vouchers.companyId, companyId),
          eq(vouchers.voucherType, "Sales"),
          eq(vouchers.optional, false),
          isNull(vouchers.deletedAt),
          eq(vouchers.locationId, destinationLocationId),
          inArray(salesItems.stockItemId, stockItemIds),
          // Look back up to 365 days so sales rates reflect the full available
          // history, not just the narrow window since the last two transfers.
          gte(
            vouchers.voucherDate,
            (() => {
              const d = new Date(asOfDate);
              d.setFullYear(d.getFullYear() - 1);
              return d.toISOString().slice(0, 10);
            })()
          ),
          lte(vouchers.voucherDate, asOfDate)
        )
      )
      .orderBy(vouchers.voucherDate),
    db
      .select({ stockItemId: inventory.stockItemId, quantity: inventory.quantity })
      .from(inventory)
      .where(
        and(
          eq(inventory.companyId, companyId),
          eq(inventory.locationId, destinationLocationId),
          inArray(inventory.stockItemId, stockItemIds)
        )
      ),
  ]);

  const salesByItem = new Map<number, Array<{ voucherDate: string; quantity: number }>>();
  for (const sale of saleRows) {
    const list = salesByItem.get(sale.stockItemId) ?? [];
    list.push({ voucherDate: sale.voucherDate, quantity: parseQuantity(sale.quantity) });
    salesByItem.set(sale.stockItemId, list);
  }

  const destinationQtyByItem = new Map<number, number>();
  for (const row of destinationInventoryRows) {
    destinationQtyByItem.set(row.stockItemId, parseQuantity(row.quantity));
  }

  const itemIdentity = new Map<number, { name: string; code: string }>();
  for (const line of allLines) {
    itemIdentity.set(line.stockItemId, { name: line.stockItemName, code: line.stockItemCode });
  }

  const latestWindowDays = calendarDaysInclusive(newerTransfer!.voucherDate, asOfDate);
  const fullWindowDays = calendarDaysInclusive(earliestTransferDate, asOfDate);
  const itemPerformance: HistoricalTransferItemPerformance[] = [];
  return {
    done: false as const,
    allLines,
    asOfDate,
    destinationLocationName,
    destinationQtyByItem,
    earliestTransferDate,
    fullWindowDays,
    itemIdentity,
    itemPerformance,
    latestWindowDays,
    locationNameById,
    newerTransfer,
    olderTransfer,
    orders,
    priorOrders,
    salesByItem,
    stockItemIds,
    uniqueSourceIds,
  };
}
