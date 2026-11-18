// Extracted from ./smartTransferHistoryAnalysis.ts to keep that module under the source-size cap.
import { and, eq, gte, isNull, lte, notInArray } from "drizzle-orm";
import { db } from "../db";
import { salesItems, vouchers } from "@shared/schema";
import {
  calculateDaysToSellThrough,
  calculateSellThroughPercentage,
  classifyTransferPerformance,
  performanceLabel,
  roundNumber,
} from "./smartTransferPerformance";
import { buildExplanation, parseQuantity, sumItemQuantity } from "./smartTransferHistoryAnalysisTypes";
import { analyzeLastTwoMultiSourceTransfersStep1 } from "./analyzeLastTwoMultiSourceTransfersStep1";

export async function analyzeLastTwoMultiSourceTransfersStep2(
  {
    allLines,
    asOfDate,
    destinationQtyByItem,
    earliestTransferDate,
    fullWindowDays,
    itemIdentity,
    itemPerformance,
    latestWindowDays,
    locationNameById,
    newerTransfer,
    olderTransfer,
    priorOrders,
    salesByItem,
    stockItemIds,
  }: Pick<
    Extract<Awaited<ReturnType<typeof analyzeLastTwoMultiSourceTransfersStep1>>, { done: false }>,
    | "allLines"
    | "asOfDate"
    | "destinationQtyByItem"
    | "earliestTransferDate"
    | "fullWindowDays"
    | "itemIdentity"
    | "itemPerformance"
    | "latestWindowDays"
    | "locationNameById"
    | "newerTransfer"
    | "olderTransfer"
    | "priorOrders"
    | "salesByItem"
    | "stockItemIds"
  >,
  companyId: number,
  destinationLocationId: number
) {
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
  return { suppSalesByItem };
}
