import type { Express } from "express";
import { registerStatsNetProfitRoutes } from "./stats/statsNetProfitRoutes";
import { registerStatsNetPositionRoutes } from "./stats/statsNetPositionRoutes";
import { registerGroupNetPositionRoutes } from "./stats/groupNetPositionRoutes";
import { registerStatsDataRoutes } from "./stats/statsDataRoutes";
import { registerStatsSalesRoutes } from "./stats/statsSalesRoutes";
import { registerStatsReportsRoutes } from "./stats/statsReportsRoutes";
import { registerStatsCountryActivityRoutes } from "./stats/statsCountryActivityRoutes";
import { registerStatsMultiCurrencyRoutes } from "./stats/statsMultiCurrencyRoutes";
import { registerStockInSalesReportRoutes } from "./stats/stockInSalesReportRoutes";
import { registerGoldenCoastResidualEquityProjection } from "./stats/goldenCoastResidualEquityProjection";

export function registerStatsRoutes(app: Express) {
  // Golden Coast's Phase 17 balance-sheet projection must be registered before
  // the live cash/bank translation middleware. Express response wrappers unwind
  // in reverse order, so the currency layer runs first and Golden Coast then
  // performs the final Assets - Liabilities = Equity reconciliation on the
  // translated totals. Ordinary companies pass through unchanged.
  registerGoldenCoastResidualEquityProjection(app);
  registerStatsMultiCurrencyRoutes(app);
  registerStatsNetProfitRoutes(app);
  registerStatsNetPositionRoutes(app);
  registerGroupNetPositionRoutes(app);
  registerStatsDataRoutes(app);
  registerStatsSalesRoutes(app);
  registerStockInSalesReportRoutes(app);
  registerStatsReportsRoutes(app);
  registerStatsCountryActivityRoutes(app);
}
