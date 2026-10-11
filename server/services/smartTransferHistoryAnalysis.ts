import { and, desc, eq, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
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
import {
  calculateDaysToSellThrough,
  calculateSellThroughPercentage,
  calendarDaysInclusive,
  classifyTransferPerformance,
  performanceLabel,
  roundNumber,
  type TransferPerformanceClassification,
} from "./smartTransferPerformance";
import { parseMoneyInput } from "../lib/money";

export interface HistoricalTransferLine {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  sourceLocationId: number;
  sourceLocationName: string;
  quantity: number;
}

export interface HistoricalTransferOrder {
  transferId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  sourceLocationIds: number[];
  sourceLocationNames: string[];
  destinationLocationId: number;
  destinationLocationName: string;
  totalQuantity: number;
  items: HistoricalTransferLine[];
}

export interface HistoricalTransferItemPerformance {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  historicalSourceLocationIds: number[];
  historicalSourceLocationNames: string[];
  olderTransferQty: number;
  newerTransferQty: number;
  totalTransferredQty: number;
  salesAfterOlderTransfer: number;
  salesAfterNewerTransfer: number;
  totalSalesSinceOlderTransfer: number;
  olderSellThroughPercentage: number;
  newerSellThroughPercentage: number;
  overallSellThroughPercentage: number;
  averageSalesPerDay: number;
  latestSalesPerDay: number;
  currentDestinationQty: number;
  estimatedDaysOfStockRemaining: number | null;
  daysToSellOlderTransfer: number | null;
  daysToSellNewerTransfer: number | null;
  classification: TransferPerformanceClassification;
  classificationLabel: string;
  explanation: string;
}

export interface SmartTransferHistoryResult {
  companyId: number;
  destinationLocationId: number;
  destinationLocationName: string;
  selectedSourceLocationIds: number[];
  selectedSourceLocationNames: string[];
  asOfDate: string;
  newerTransfer: HistoricalTransferOrder | null;
  olderTransfer: HistoricalTransferOrder | null;
  items: HistoricalTransferItemPerformance[];
  summary: string;
}

export interface SmartTransferHistoryOptions {
  asOfDate?: string;
}

function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniquePositiveIds(ids: number[]): number[] {
  return Array.from(new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
}

function assertIsoDate(value: string, fieldName: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
    throw new Error(`${fieldName} must be a valid date in YYYY-MM-DD format`);
  }
}

function sumItemQuantity(order: HistoricalTransferOrder | null, stockItemId: number): number {
  if (!order) return 0;
  return order.items.filter((item) => item.stockItemId === stockItemId).reduce((sum, item) => sum + item.quantity, 0);
}

function buildExplanation(
  classification: TransferPerformanceClassification,
  totalTransferredQty: number,
  totalSales: number,
  currentDestinationQty: number,
  latestSalesPerDay: number,
  estimatedDaysRemaining: number | null
): string {
  const soldText = `${roundNumber(totalSales, 0)} sold after ${roundNumber(totalTransferredQty, 0)} transferred in the last qualifying orders`;
  switch (classification) {
    case "strong_seller":
      return `${soldText}; demand is strong and current destination stock is ${roundNumber(currentDestinationQty, 0)}.`;
    case "good_seller":
      return `${soldText}; the item has good repeat demand at the destination.`;
    case "normal_seller":
      return `${soldText}; sales are steady and should be balanced against current destination stock.`;
    case "slow_seller":
      return `${soldText}; recent sales are slow (${roundNumber(latestSalesPerDay, 2)}/day).`;
    case "overstocked":
      return `${soldText}; destination still holds ${roundNumber(currentDestinationQty, 0)}${
        estimatedDaysRemaining === null ? "" : `, about ${roundNumber(estimatedDaysRemaining, 0)} days of stock`
      }.`;
    case "no_recent_sales":
    default:
      return `No qualifying destination sales were found after the recent transfer order(s).`;
  }
}

/**
 * Read-only historical analyzer used by the smart multi-source transfer generator.
 *
 * It deliberately selects the last FOUR TRANSFER VOUCHERS, not individual item
 * rows. A voucher can contain lines from any number of source locations because
 * the source is resolved from stock_transfer_items.source_location_id first,
 * with the legacy voucher-level source used only as a fallback.
 *
 * In the result:
 *   newerTransfer = the most recent completed order (orders[0])
 *   olderTransfer = the oldest of the four (orders[3] or fewer if <4 exist)
 *   olderTransferQty per item = sum across all orders EXCEPT the newest
 *   newerTransferQty per item = qty from the newest order only
 */
export async function analyzeLastTwoMultiSourceTransfers(
  companyId: number,
  sourceLocationIds: number[],
  destinationLocationId: number,
  options: SmartTransferHistoryOptions = {}
): Promise<SmartTransferHistoryResult> {
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

  for (const stockItemId of stockItemIds) {
    const identity = itemIdentity.get(stockItemId)!;
    const itemSales = salesByItem.get(stockItemId) ?? [];
    // newerTransferQty = most recent order only; olderTransferQty = sum of all prior orders
    const newerTransferQty = sumItemQuantity(newerTransfer, stockItemId);
    const olderTransferQty = priorOrders.reduce((sum, o) => sum + sumItemQuantity(o, stockItemId), 0);

    // olderWindowSales = everything from the oldest transfer up to (not incl.) the newest
    const olderWindowSales =
      earliestTransferDate < newerTransfer!.voucherDate
        ? itemSales.filter(
            (sale) => sale.voucherDate >= earliestTransferDate && sale.voucherDate < newerTransfer!.voucherDate
          )
        : [];
    const newerWindowSales = itemSales.filter(
      (sale) => sale.voucherDate >= newerTransfer!.voucherDate && sale.voucherDate <= asOfDate
    );

    const salesAfterOlderTransfer = olderWindowSales.reduce((sum, sale) => sum + sale.quantity, 0);
    const salesAfterNewerTransfer = newerWindowSales.reduce((sum, sale) => sum + sale.quantity, 0);
    const totalTransferredQty = olderTransferQty + newerTransferQty;
    const totalSalesSinceOlderTransfer = salesAfterOlderTransfer + salesAfterNewerTransfer;
    const currentDestinationQty = destinationQtyByItem.get(stockItemId) ?? 0;
    const latestSalesPerDay = salesAfterNewerTransfer / Math.max(1, latestWindowDays);
    const averageSalesPerDay = totalSalesSinceOlderTransfer / Math.max(1, fullWindowDays);
    const rateForCoverage = latestSalesPerDay > 0 ? latestSalesPerDay : averageSalesPerDay;
    const estimatedDaysOfStockRemaining = rateForCoverage > 0 ? currentDestinationQty / rateForCoverage : null;

    const classification = classifyTransferPerformance({
      olderTransferQty,
      newerTransferQty,
      salesAfterOlderTransfer,
      salesAfterNewerTransfer,
      currentDestinationQty,
      latestWindowDays,
    });

    const historicalSourceLocationIds = Array.from(
      new Set(allLines.filter((line) => line.stockItemId === stockItemId).map((line) => line.sourceLocationId))
    );

    itemPerformance.push({
      stockItemId,
      stockItemName: identity.name,
      stockItemCode: identity.code,
      historicalSourceLocationIds,
      historicalSourceLocationNames: historicalSourceLocationIds.map(
        (id) => locationNameById.get(id) ?? `Location #${id}`
      ),
      olderTransferQty: roundNumber(olderTransferQty, 3),
      newerTransferQty: roundNumber(newerTransferQty, 3),
      totalTransferredQty: roundNumber(totalTransferredQty, 3),
      salesAfterOlderTransfer: roundNumber(salesAfterOlderTransfer, 3),
      salesAfterNewerTransfer: roundNumber(salesAfterNewerTransfer, 3),
      totalSalesSinceOlderTransfer: roundNumber(totalSalesSinceOlderTransfer, 3),
      olderSellThroughPercentage: calculateSellThroughPercentage(salesAfterOlderTransfer, olderTransferQty),
      newerSellThroughPercentage: calculateSellThroughPercentage(salesAfterNewerTransfer, newerTransferQty),
      overallSellThroughPercentage: calculateSellThroughPercentage(totalSalesSinceOlderTransfer, totalTransferredQty),
      averageSalesPerDay: roundNumber(averageSalesPerDay, 3),
      latestSalesPerDay: roundNumber(latestSalesPerDay, 3),
      currentDestinationQty: roundNumber(currentDestinationQty, 3),
      estimatedDaysOfStockRemaining:
        estimatedDaysOfStockRemaining === null ? null : roundNumber(estimatedDaysOfStockRemaining, 1),
      daysToSellOlderTransfer: olderTransfer
        ? calculateDaysToSellThrough(olderWindowSales, olderTransferQty, olderTransfer.voucherDate)
        : null,
      daysToSellNewerTransfer: calculateDaysToSellThrough(
        newerWindowSales,
        newerTransferQty,
        newerTransfer!.voucherDate
      ),
      classification,
      classificationLabel: performanceLabel(classification),
      explanation: buildExplanation(
        classification,
        totalTransferredQty,
        totalSalesSinceOlderTransfer,
        currentDestinationQty,
        latestSalesPerDay,
        estimatedDaysOfStockRemaining
      ),
    });
  }

  // --- Supplemental items: items selling at destination but not in recent transfers ---
  // Look back 90 days for destination sales of items not already captured above.
  const ninetyDaysAgo = (() => {
    const d = new Date(`${asOfDate}T00:00:00.000Z`);
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  })();

  const supplementalSaleRows =
    stockItemIds.length > 0
      ? await db
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
              notInArray(salesItems.stockItemId, stockItemIds),
              gte(vouchers.voucherDate, ninetyDaysAgo),
              lte(vouchers.voucherDate, asOfDate)
            )
          )
          .orderBy(vouchers.voucherDate)
      : await db
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
              gte(vouchers.voucherDate, ninetyDaysAgo),
              lte(vouchers.voucherDate, asOfDate)
            )
          )
          .orderBy(vouchers.voucherDate);

  // Build sales map for supplemental items
  const suppSalesByItem = new Map<number, Array<{ voucherDate: string; quantity: number }>>();
  for (const sale of supplementalSaleRows) {
    const list = suppSalesByItem.get(sale.stockItemId) ?? [];
    list.push({ voucherDate: sale.voucherDate, quantity: parseQuantity(sale.quantity) });
    suppSalesByItem.set(sale.stockItemId, list);
  }

  if (suppSalesByItem.size > 0) {
    const suppStockItemIds = Array.from(suppSalesByItem.keys());

    const [suppItemMetaRows, suppDestInvRows] = await Promise.all([
      db
        .select({
          id: stockItems.id,
          name: stockItems.name,
          code: stockItems.code,
        })
        .from(stockItems)
        .where(
          and(
            eq(stockItems.companyId, companyId),
            inArray(stockItems.id, suppStockItemIds),
            eq(stockItems.active, true),
            isNull(stockItems.deletedAt)
          )
        ),
      db
        .select({ stockItemId: inventory.stockItemId, quantity: inventory.quantity })
        .from(inventory)
        .where(
          and(
            eq(inventory.companyId, companyId),
            eq(inventory.locationId, destinationLocationId),
            inArray(inventory.stockItemId, suppStockItemIds)
          )
        ),
    ]);

    const suppMetaById = new Map(suppItemMetaRows.map((r) => [r.id, r]));
    const suppDestQtyById = new Map(suppDestInvRows.map((r) => [r.stockItemId, parseQuantity(r.quantity)]));

    // Use the same latest window as the historical analysis
    const suppLatestWindowDays = latestWindowDays;
    const latestWindowStart = newerTransfer!.voucherDate;

    for (const [stockItemId, itemSales] of suppSalesByItem.entries()) {
      const meta = suppMetaById.get(stockItemId);
      if (!meta) continue; // inactive / deleted item

      const total90DaySales = itemSales.reduce((sum, s) => sum + s.quantity, 0);
      const latestWindowSales = itemSales.filter((s) => s.voucherDate >= latestWindowStart);
      const salesAfterNewerTransfer = latestWindowSales.reduce((sum, s) => sum + s.quantity, 0);
      const currentDestinationQty = suppDestQtyById.get(stockItemId) ?? 0;

      // Use the 90-day window for averageSalesPerDay; latest window for latestSalesPerDay
      const averageSalesPerDay = total90DaySales / 90;
      const latestSalesPerDay = salesAfterNewerTransfer / Math.max(1, suppLatestWindowDays);
      const rateForCoverage = latestSalesPerDay > 0 ? latestSalesPerDay : averageSalesPerDay;
      const estimatedDaysOfStockRemaining = rateForCoverage > 0 ? currentDestinationQty / rateForCoverage : null;

      // Classify based on sales rate alone (no transfer baseline):
      // Use daily rate tiers to assign a reasonable classification.
      let classification: TransferPerformanceClassification;
      if (rateForCoverage >= 1.0) {
        classification = "good_seller";
      } else if (rateForCoverage >= 0.3) {
        classification = "normal_seller";
      } else if (rateForCoverage >= 0.05) {
        classification = "slow_seller";
      } else {
        continue; // essentially no sales — skip
      }

      // If destination already has lots of stock, call it overstocked and skip
      if (estimatedDaysOfStockRemaining !== null && estimatedDaysOfStockRemaining > 60) {
        continue;
      }

      itemPerformance.push({
        stockItemId,
        stockItemName: meta.name,
        stockItemCode: meta.code,
        historicalSourceLocationIds: [],
        historicalSourceLocationNames: [],
        olderTransferQty: 0,
        newerTransferQty: 0,
        totalTransferredQty: 0,
        salesAfterOlderTransfer: roundNumber(total90DaySales - salesAfterNewerTransfer, 3),
        salesAfterNewerTransfer: roundNumber(salesAfterNewerTransfer, 3),
        totalSalesSinceOlderTransfer: roundNumber(total90DaySales, 3),
        olderSellThroughPercentage: 0,
        newerSellThroughPercentage: 0,
        overallSellThroughPercentage: 0,
        averageSalesPerDay: roundNumber(averageSalesPerDay, 3),
        latestSalesPerDay: roundNumber(latestSalesPerDay, 3),
        currentDestinationQty: roundNumber(currentDestinationQty, 3),
        estimatedDaysOfStockRemaining:
          estimatedDaysOfStockRemaining === null ? null : roundNumber(estimatedDaysOfStockRemaining, 1),
        daysToSellOlderTransfer: null,
        daysToSellNewerTransfer: null,
        classification,
        classificationLabel: performanceLabel(classification),
        explanation: `Sales-based candidate: ${roundNumber(total90DaySales, 0)} units sold at destination in last 90 days (${roundNumber(latestSalesPerDay, 2)}/day recently). Not in recent transfers.`,
      });
    }
  }

  const priority: Record<TransferPerformanceClassification, number> = {
    strong_seller: 0,
    good_seller: 1,
    normal_seller: 2,
    slow_seller: 3,
    overstocked: 4,
    no_recent_sales: 5,
  };
  itemPerformance.sort(
    (a, b) =>
      priority[a.classification] - priority[b.classification] ||
      b.latestSalesPerDay - a.latestSalesPerDay ||
      b.overallSellThroughPercentage - a.overallSellThroughPercentage ||
      a.stockItemName.localeCompare(b.stockItemName)
  );

  return {
    companyId,
    destinationLocationId,
    destinationLocationName,
    selectedSourceLocationIds: uniqueSourceIds,
    selectedSourceLocationNames: uniqueSourceIds.map((id) => locationNameById.get(id)!),
    asOfDate,
    newerTransfer,
    olderTransfer,
    items: itemPerformance,
    summary: `Analyzed ${orders.length} of up to 4 completed transfer order(s) to ${destinationLocationName}. ${itemPerformance.length} item(s) considered (including sales-based candidates) through ${asOfDate}.`,
  };
}
