import type { Response } from "express";
/**
 * stockSummaryLocationRoutes: LocationMonthlyVoucher endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireAuth } from "../../auth";
import { sumMoney } from "../../lib/money";
import { handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1 } from "./handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1";
import { handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep2 } from "./handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep2";
import { handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep3 } from "./handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep3";

export function registerLocationMonthlyVoucherRoutes(app: Express) {
  // Location Stock Item Monthly Vouchers - Get detailed transactions for a specific month at a location
  app.get(
    "/api/locations/:locationId/stock-items/:stockItemId/vouchers/:year/:month",
    requireAuth,
    async (req, res) => {
      try {
        const step1Result = await handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1(req, res);
        if (step1Result.done) return step1Result.value;
        const {
          companyId,
          expectedClosingQty,
          expectedClosingRate,
          expectedClosingValue,
          location,
          locationId,
          month,
          monthEndStr,
          monthStartStr,
          openingHistoryRow,
          stockItem,
          stockItemId,
          transactions,
          year,
        } = step1Result;
        const { noteData } = await handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep2({
          companyId,
          locationId,
          month,
          stockItemId,
          transactions,
          year,
        });
        const { finalClosingQty, finalClosingRate, finalClosingValue, opening, transactionsWithBalance } =
          await handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep3({
            companyId,
            expectedClosingQty,
            expectedClosingRate,
            expectedClosingValue,
            locationId,
            month,
            monthEndStr,
            monthStartStr,
            noteData,
            openingHistoryRow,
            stockItemId,
            transactions,
            year,
          });
        handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep4(
          {
            finalClosingQty,
            finalClosingRate,
            finalClosingValue,
            location,
            month,
            opening,
            stockItem,
            transactionsWithBalance,
            year,
          },
          res
        );
      } catch (error: unknown) {
        logger.error("Location stock item monthly vouchers error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

function handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep4(
  {
    finalClosingQty,
    finalClosingRate,
    finalClosingValue,
    location,
    month,
    opening,
    stockItem,
    transactionsWithBalance,
    year,
  }: Pick<
    Extract<
      Awaited<ReturnType<typeof handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1>>,
      { done: false }
    > &
      Awaited<ReturnType<typeof handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep3>>,
    | "finalClosingQty"
    | "finalClosingRate"
    | "finalClosingValue"
    | "location"
    | "month"
    | "opening"
    | "stockItem"
    | "transactionsWithBalance"
    | "year"
  >,
  res: Response
) {
  // Update last transaction's closing to match expected closing
  if (transactionsWithBalance.length > 0) {
    const lastTx = transactionsWithBalance[transactionsWithBalance.length - 1];
    lastTx.closingQty = finalClosingQty;
    lastTx.closingRate = finalClosingRate;
    lastTx.closingValue = finalClosingValue;
  }

  const processedTransactions = transactionsWithBalance.filter((t) => !t.isOpeningBalance);
  const totals = {
    inwardQty: sumMoney(processedTransactions.map((t) => t.inwardQty)).toNumber(),
    inwardRate: 0,
    inwardValue: sumMoney(processedTransactions.map((t) => t.inwardValue)).toNumber(),
    outwardQty: sumMoney(processedTransactions.map((t) => t.outwardQty)).toNumber(),
    outwardRate: 0,
    outwardValue: sumMoney(processedTransactions.map((t) => t.outwardValue)).toNumber(),
    closingQty: finalClosingQty,
    closingRate: finalClosingRate,
    closingValue: finalClosingValue,
  };
  totals.inwardRate = totals.inwardQty > 0 ? totals.inwardValue / totals.inwardQty : 0;
  totals.outwardRate = totals.outwardQty > 0 ? totals.outwardValue / totals.outwardQty : 0;

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  res.json({
    stockItem,
    location,
    year,
    month,
    monthName: monthNames[month - 1],
    openingBalance: opening,
    transactions: transactionsWithBalance,
    totals,
  });
  return {};
}
