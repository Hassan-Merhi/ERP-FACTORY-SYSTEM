import type { Express } from "express";
import { registerStockLightRoutes } from "./stock/stockLightRoutes";
import { registerStockGroupsItemsRoutes } from "./stock/groups-items";
import { registerStockTransferAdjRoutes } from "./stock/transfer-adj";
import { registerStockMergeRoutes } from "./stock/merge";
import { registerStockItemManageRoutes } from "./stock/stockItemManageRoutes";
import { registerStockPriceListImportRoutes } from "./stock/stockPriceListImportRoutes";
import { registerRetailRoutes } from "./retailRoutes";
import { registerRetailReportingRoutes } from "./retailReportingRoutes";

export function registerStockRoutes(app: Express) {
  // Light route MUST be first — prevents /api/stock-items/:id from swallowing "light" as a param
  registerStockLightRoutes(app);
  registerStockGroupsItemsRoutes(app);
  registerStockTransferAdjRoutes(app);
  registerStockMergeRoutes(app);
  registerStockItemManageRoutes(app);
  registerStockPriceListImportRoutes(app);
  registerRetailRoutes(app);
  registerRetailReportingRoutes(app);
}