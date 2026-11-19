import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { inventory, stockItems } from "@shared/schema";
import { performanceLabel, roundNumber, type TransferPerformanceClassification } from "./smartTransferPerformance";
import {
  parseQuantity,
  type HistoricalTransferItemPerformance,
  type HistoricalTransferOrder,
  type SmartTransferHistoryOptions,
} from "./smartTransferHistoryAnalysisTypes";
import { analyzeLastTwoMultiSourceTransfersStep1 } from "./analyzeLastTwoMultiSourceTransfersStep1";
import { analyzeLastTwoMultiSourceTransfersStep2 } from "./analyzeLastTwoMultiSourceTransfersStep2";
export type {
  HistoricalTransferItemPerformance,
  HistoricalTransferLine,
  HistoricalTransferOrder,
  SmartTransferHistoryOptions,
} from "./smartTransferHistoryAnalysisTypes";

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
  const step1Result = await analyzeLastTwoMultiSourceTransfersStep1(
    companyId,
    sourceLocationIds,
    destinationLocationId,
    options
  );
  if (step1Result.done) return step1Result.value;
  const {
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
  } = step1Result;
  const { suppSalesByItem } = await analyzeLastTwoMultiSourceTransfersStep2(
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
    },
    companyId,
    destinationLocationId
  );
  await analyzeLastTwoMultiSourceTransfersStep3(
    { itemPerformance, latestWindowDays, newerTransfer, suppSalesByItem },
    companyId,
    destinationLocationId
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

async function analyzeLastTwoMultiSourceTransfersStep3(
  {
    itemPerformance,
    latestWindowDays,
    newerTransfer,
    suppSalesByItem,
  }: Pick<
    Extract<Awaited<ReturnType<typeof analyzeLastTwoMultiSourceTransfersStep1>>, { done: false }> &
      Awaited<ReturnType<typeof analyzeLastTwoMultiSourceTransfersStep2>>,
    "itemPerformance" | "latestWindowDays" | "newerTransfer" | "suppSalesByItem"
  >,
  companyId: number,
  destinationLocationId: number
) {
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
  return {};
}
