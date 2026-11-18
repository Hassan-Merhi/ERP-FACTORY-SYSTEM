// Extracted from ./smartTransferHistoryAnalysis.ts to keep that module under the source-size cap.
import { roundNumber, type TransferPerformanceClassification } from "./smartTransferPerformance";
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

export interface SmartTransferHistoryOptions {
  asOfDate?: string;
}

export function parseQuantity(value: unknown): number {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function uniquePositiveIds(ids: number[]): number[] {
  return Array.from(new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
}

export function assertIsoDate(value: string, fieldName: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
    throw new Error(`${fieldName} must be a valid date in YYYY-MM-DD format`);
  }
}

export function sumItemQuantity(order: HistoricalTransferOrder | null, stockItemId: number): number {
  if (!order) return 0;
  return order.items.filter((item) => item.stockItemId === stockItemId).reduce((sum, item) => sum + item.quantity, 0);
}

export function buildExplanation(
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
