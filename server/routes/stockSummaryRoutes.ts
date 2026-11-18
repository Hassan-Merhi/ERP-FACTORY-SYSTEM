import type { Response } from "express";
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { requireAuth } from "../auth";
import { registerStockSummaryLocationRoutes } from "./stock-summary-location";
import { registerStockSummaryRoutesStep1 } from "./registerStockSummaryRoutesStep1";
import { handleGetStockItemsIdVouchersYearMonthStep1 } from "./handleGetStockItemsIdVouchersYearMonthStep1";

export function registerStockSummaryRoutes(app: Express) {
  registerStockSummaryRoutesStep1(app);
  registerStockSummaryRoutesStep2(app);
  registerStockSummaryRoutesStep3(app);

  // Location Summary - Matrix view of all stock groups/items across selected locations
}

function registerStockSummaryRoutesStep2(app: Express) {
  // Stock Item Monthly Vouchers - Get detailed transactions for a specific month
  app.get("/api/stock-items/:id/vouchers/:year/:month", requireAuth, async (req, res) => {
    try {
      const step1Result = await handleGetStockItemsIdVouchersYearMonthStep1(req, res);
      if (step1Result.done) return step1Result.value;
      const { month, opening, stockItem, totals, transactionsWithBalance, year } = step1Result;
      handleGetStockItemsIdVouchersYearMonthStep2(
        { month, opening, stockItem, totals, transactionsWithBalance, year },
        res
      );
    } catch (error: unknown) {
      logger.error("Stock item monthly vouchers error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
  return {};
}

function registerStockSummaryRoutesStep3(app: Express) {
  registerStockSummaryLocationRoutes(app);
  return {};
}

function handleGetStockItemsIdVouchersYearMonthStep2(
  {
    month,
    opening,
    stockItem,
    totals,
    transactionsWithBalance,
    year,
  }: Pick<
    Extract<Awaited<ReturnType<typeof handleGetStockItemsIdVouchersYearMonthStep1>>, { done: false }>,
    "month" | "opening" | "stockItem" | "totals" | "transactionsWithBalance" | "year"
  >,
  res: Response
) {
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
    year,
    month,
    monthName: monthNames[month - 1],
    openingBalance: opening,
    transactions: transactionsWithBalance,
    totals,
  });
  return {};
}
