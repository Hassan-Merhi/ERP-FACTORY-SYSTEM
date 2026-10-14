import type { Express } from "express";
import { registerStockLightRoutes } from "./stock/stockLightRoutes";
import { registerStockGroupsItemsRoutes } from "./stock/groups-items";
import { registerStockTransferAdjRoutes } from "./stock/transfer-adj";
import { registerStockMergeRoutes } from "./stock/merge";
import { registerRetailRoutes } from "./retailRoutes";
import { registerRetailCatalogRoutes } from "./retailCatalogRoutes";
import { registerRetailReportingRoutes } from "./retailReportingRoutes";
import { registerRetailFashionRoutes } from "./retailFashionRoutes";
import { registerRetailFinancialRoutes } from "./retailFinancialRoutes";
import { registerRetailSettingsRoutes } from "./retailSettingsRoutes";

export function registerStockRoutes(app: Express) {
  // Light route MUST be first — prevents /api/stock-items/:id from swallowing "light" as a param
  registerStockLightRoutes(app);
  registerStockGroupsItemsRoutes(app);
  registerStockTransferAdjRoutes(app);
  registerStockMergeRoutes(app);
  registerRetailRoutes(app);
  registerRetailCatalogRoutes(app);
  registerRetailReportingRoutes(app);
  registerRetailFashionRoutes(app);
  registerRetailFinancialRoutes(app);
  registerRetailSettingsRoutes(app);
}
